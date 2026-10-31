import { BrowserEventBus } from './event-bus.js';
import { createConversationActions, ensureMessageIdentity, messageId } from './conversation-actions.js';
import { createConversationNative } from './conversation-native.js';
import { createPersonaContext } from './conversation-personas.js';
import { createConversationSession } from './conversation-session.js';
import { createConversationUI } from './conversation-ui.js';
import { mountLorebooks } from './lorebook-bootstrap.js';

const initializations = new WeakMap();

/**
 * Resolves a native or ownership-projected group to its source-qualified chat.
 * @param {object} group Selected native group record.
 * @returns {object|null} Bus chat identity, or null for an ordinary/unopened group.
 */
export function getConversationIdentity(group) {
    if (!group?.multiplayer?.owner || !group.chat_id) { return null; }
    let groupId = String(group.id);
    if (groupId.startsWith('multiplayer-group:')) {
        try {
            const [owner, original] = JSON.parse(groupId.slice('multiplayer-group:'.length).replace(/:+$/u, ''));
            if (owner !== group.multiplayer.owner) { return null; }
            groupId = String(original);
        } catch { return null; }
    }
    return { accountId: group.multiplayer.owner, groupId, chatId: group.chat_id };
}

function sameChat(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Wires native lifecycle, bus coordination, action persistence and shared-chat controls.
 * @param {object} options Live native bindings, browser objects and authenticated account.
 * @returns {Promise<object>} Mounted controller with disposal and session access.
 */
export async function mountConversations({ native, window, document, accountId, bus: suppliedBus }) {
    let current = null;
    let session;
    let actions;
    let ui;
    let opening = 0;
    let streamingActive = false;
    let lastPreview;
    let personaLoadFailed = false;
    let lorebooks;
    const subscriptions = [];
    const report = error => window.toastr?.error(error.message, 'Multiplayer');
    const bus = suppliedBus ?? new BrowserEventBus({
        fetch: window.fetch.bind(window), WebSocket: window.WebSocket,
        getRequestHeaders: native.getRequestHeaders,
        getCurrentChat: () => current, location: window.location,
    });
    const personaContext = createPersonaContext({
        accountId, baseURL: document.baseURI,
        fetch: (...args) => window.fetch(...args), getRequestHeaders: native.getRequestHeaders,
        formatDescription: (description, persona) => native.substituteParams(description, { name1Override: persona.name }),
        setPrompt: text => native.setExtensionPrompt?.('multiplayer-personas', text, native.extension_prompt_types?.IN_PROMPT ?? 0, 0, false, native.extension_prompt_roles?.SYSTEM ?? 0),
    });
    const selectedIdentity = () => getConversationIdentity(native.groups.find(group => String(group.id) === String(native.selectedGroup)));
    const adapter = createConversationNative({
        native, window, document, accountId, randomUUID: native.uuidv4,
        getCurrentChat: selectedIdentity,
        canSave: () => !selectedIdentity() || Boolean(sameChat(selectedIdentity(), current) && session?.getState().connected && session?.getState().isOwner && !actions?.recoveryBlocked),
        onSaveFailure: async outcome => {
            if (!current || !session?.getState().isOwner) { return; }
            report(new Error(outcome.reason ?? 'The chat save could not be confirmed.'));
            await actions.restoreSaved();
        },
        onSave: async () => {
            if (!current || !session?.getState().isOwner) { return; }
            session.localSaved(native.chat);
            await session.saved();
        },
    });

    function render(state) {
        actions?.setAuthority(state.connected && state.isOwner);
        actions?.setGenerating(state.generating);
        ui?.refresh();
    }

    function stopAuthority() {
        personaContext.clear();
        streamingActive = false;
        lastPreview = undefined;
        actions?.setAuthority(false);
        native.stopGeneration();
    }

    function createSession() {
        session = createConversationSession({
            bus, loadChat: async (chat, status) => {
                const messages = await adapter.reload(chat, status);
                await lorebooks?.refresh();
                if (status.isOwner) {
                    for (const message of messages) { ensureMessageIdentity(message, native.uuidv4); }
                }
                return messages;
            }, render,
            onAction: ({ type, body, sender }) => actions.enqueue(type, body, sender),
            stopAuthority, onError: report,
        });
        const selected = session;
        actions = createConversationActions({
            native: adapter, accountId, bus,
            isCurrent: () => session === selected && sameChat(selectedIdentity(), selected.getState().chat),
            onLocalFailure: (type, body, reason) => session.localFailure(type, body, reason),
            onLocalSaved: messages => session.localSaved(messages),
        });
    }

    async function changed() {
        const group = native.groups.find(group => String(group.id) === String(native.selectedGroup));
        const identity = getConversationIdentity(group);
        if (sameChat(identity, current)) { return; }
        const request = ++opening;
        personaContext.clear();
        adapter.invalidate();
        const previous = session;
        current = identity;
        if (identity && native.is_group_automode_enabled) { native.stopGeneration(); }
        if (previous) { await previous.close(); }
        if (request !== opening) { return; }
        if (!identity) { ui.refresh(); return; }
        createSession();
        await session.open(identity);
        ui.refresh();
    }

    function state() {
        return { ...session?.getState(), shared: Boolean(current), accountId, blocked: actions?.recoveryBlocked ?? false };
    }

    async function submit(text) {
        const selected = session;
        if (await adapter.processCommands(text)) { return; }
        if (selected !== session || !selected.getState().canChange) { return; }
        const prepared = await adapter.prepareTurn(text);
        if (selected !== session || !selected.getState().canChange) { return; }
        const submission = selected.submit('send', { message: prepared });
        const composer = document.querySelector('#send_textarea');
        if (composer?.value === text) {
            composer.value = '';
            composer.dispatchEvent(new window.Event('input', { bubbles: true }));
        }
        await submission;
    }

    async function generate(options = {}) {
        if (!session?.getState().isOwner || !session.getState().canChange) { return; }
        const selected = session;
        if (options.type === 'swipe') {
            await actions.runNative(async isCurrent => {
                const target = options.messageId ? native.chat.find(message => messageId(message) === options.messageId) : native.chat.at(-1);
                if (options.messageId && !target) { return; }
                const id = target && messageId(target);
                try {
                    await (options.direction === 'left' ? native.swipe_left(undefined, { message: target }) : native.swipe_right(undefined, { message: target }));
                    native.cancelDebouncedChatSave?.();
                    if (!isCurrent() || selected !== session) { return; }
                    if (target && id) {
                        target.extra ??= {};
                        target.extra.multiplayer = { ...target.extra.multiplayer, messageId: id };
                        ensureMessageIdentity(target, native.uuidv4);
                    }
                    const outcome = await adapter.save();
                    if (outcome.status === 'saved') {
                        selected.localSaved(native.chat);
                        await selected.saved();
                    } else {
                        await actions.restoreSaved();
                    }
                } finally {
                    if (selected === session && selected.getState().isOwner && selected.getState().generating) {
                        await selected.generationStatus(false);
                    }
                }
            });
            return;
        }
        await actions.runGeneration(async () => {
            await selected.generationStatus(true);
            try {
                if (options.type === 'regenerate') {
                    await native.regenerateGroup();
                } else {
                    await native.Generate(options.type ?? 'normal', options.params ?? {});
                }
            } finally {
                if (selected === session && selected.getState().isOwner) { await selected.generationStatus(false); }
            }
        });
    }

    async function edit(id, text) {
        const message = native.chat.find(message => messageId(message) === id);
        if (!message) { return; }
        await session.submit('edit', { messageId: id, text: await adapter.prepareEdit(message, text) });
    }

    ui = createConversationUI({
        document, window, getState: state,
        renderMessage: message => {
            const index = native.chat.findIndex(saved => messageId(saved) === messageId(message));
            const rendered = native.updateMessageElement?.(message, { messageId: index < 0 ? native.chat.length : index });
            return rendered?.[0] ?? rendered;
        },
        onSubmit: text => submit(text).catch(report),
        onGenerate: options => generate(options).catch(report),
        onEdit: (id, text) => edit(id, text).catch(report),
        onDelete: (id, options = {}) => session.submit('delete', { messageId: id, ...options }).catch(report),
        onRetry: id => session.retry(id).catch(report),
        onDiscard: id => session.discard(id),
        shouldSendOnEnter: native.shouldSendOnEnter,
        isPopupOpen: native.isPopupOpen,
    });

    function subscribe(name, handler) {
        if (!name) { return; }
        native.eventSource.on(name, handler);
        subscriptions.push([name, handler]);
    }

    function identify(index) {
        if (!current || !session?.getState().isOwner) { return; }
        const message = native.chat[Number.isInteger(index) ? index : native.chat.length - 1];
        if (message && !message.is_user) { ensureMessageIdentity(message, native.uuidv4); }
    }

    subscribe(native.event_types.CHAT_CHANGED, () => changed().catch(report));
    subscribe(native.event_types.GENERATION_STARTED, async (type, _options, dryRun) => {
        personaContext.clear();
        personaLoadFailed = false;
        streamingActive = false;
        lastPreview = undefined;
        if (!current || dryRun || type === 'quiet' || type === 'impersonate' || !session?.getState().isOwner) { return; }
        const selected = session;
        const ready = actions.prepareGeneration();
        await selected.generationStatus(true);
        try {
            await ready;
            if (selected !== session || !selected.getState().isOwner || !sameChat(selectedIdentity(), selected.getState().chat)) { return; }
            const prepared = await personaContext.prepare(selected.getState().messages);
            if (!prepared) { personaLoadFailed = true; }
        } catch (error) {
            personaLoadFailed = true;
            native.stopGeneration();
            if (session.getState().isOwner) { await session.generationStatus(false); }
            report(error);
            throw error;
        }
    });
    subscribe(native.event_types.GENERATION_AFTER_COMMANDS, (type, _options, dryRun) => {
        if (!current || dryRun || type === 'quiet' || type === 'impersonate') { return; }
        if (!session?.getState().isOwner || !session.getState().connected || actions.recoveryBlocked || personaLoadFailed) {
            native.stopGeneration();
        }
    });
    subscribe(native.event_types.GENERATION_ENDED, () => personaContext.clear());
    subscribe(native.event_types.GENERATION_STOPPED, async () => {
        personaContext.clear();
        if (current && session?.getState().isOwner && session.getState().generating) {
            await session.generationStatus(false);
        }
    });
    subscribe(native.event_types.MESSAGE_RECEIVED, identify);
    subscribe(native.event_types.MESSAGE_SWIPED, identify);
    subscribe(native.event_types.STREAM_TOKEN_RECEIVED, () => {
        if (!current || !session?.getState().isOwner || !session.getState().generating) { return; }
        if (['quiet', 'impersonate'].includes(native.streamingProcessor?.type)) { return; }
        streamingActive = true;
        identify(native.streamingProcessor?.messageId);
    });
    const previewObserver = new window.MutationObserver(records => {
        if (!streamingActive || !current || !sameChat(selectedIdentity(), current) || !session?.getState().isOwner || !session.getState().generating) { return; }
        const updated = records.some(record => (record.target.nodeType === 1 ? record.target : record.target.parentElement)?.closest('.mes .mes_text'));
        if (!updated) { return; }
        const index = native.streamingProcessor?.messageId ?? native.chat.length - 1;
        const message = native.chat[index];
        if (!message || message.is_user) { return; }
        identify(index);
        const preview = { messageId: messageId(message), name: message.name, force_avatar: native.characterPortrait?.(message) ?? message.force_avatar ?? '', text: message.mes };
        const key = JSON.stringify(preview);
        if (key === lastPreview) { return; }
        lastPreview = key;
        void session.generationPreview(preview).catch(report);
    });
    subscribe(native.event_types.GROUP_WRAPPER_STARTED, async ({ type }) => {
        if (!current || type === 'impersonate' || type === 'quiet') { return; }
        if (!session?.getState().isOwner) { native.stopGeneration(); return; }
        actions.setGenerating(true);
        await session.generationStatus(true);
    });
    subscribe(native.event_types.GROUP_WRAPPER_FINISHED, async ({ type }) => {
        personaContext.clear();
        if (!current || !session?.getState().isOwner || type === 'impersonate' || type === 'quiet') { return; }
        actions.setGenerating(false);
        await session.generationStatus(false);
    });
    adapter.mount();
    if (native.worldInfoCache) {
        lorebooks = mountLorebooks({ native, window, document, accountId, bus, getCurrentChat: () => current, onError: report });
    }
    ui.mount();
    previewObserver.observe(document.querySelector('#chat') ?? document.body, { childList: true, subtree: true, characterData: true });
    void changed().catch(report);
    return {
        /** @returns {BrowserEventBus} Shared transport managed by this integration. */
        get bus() { return bus; },
        /** @returns {object|undefined} Current shared-chat controller. */
        get session() { return session; },
        /** @returns {Promise<void>} Leaves shared play and restores native browser integrations. */
        async dispose() {
            opening++;
            personaContext.clear();
            adapter.invalidate();
            current = null;
            await session?.close();
            for (const [name, listener] of subscriptions) { native.eventSource.removeListener(name, listener); }
            ui.dispose();
            previewObserver.disconnect();
            lorebooks?.dispose();
            adapter.dispose();
        },
    };
}

async function start({ window, document, loadModule }) {
    const [script, groups, users, power, regex, timestamps, tokens, chats, personas, popup, prompts, stats, utils, worlds] = await Promise.all([
        loadModule('/script.js'), loadModule('/scripts/group-chats.js'), loadModule('/scripts/user.js'),
        loadModule('/scripts/power-user.js'), loadModule('/scripts/extensions/regex/engine.js'),
        loadModule('/scripts/RossAscends-mods.js'), loadModule('/scripts/tokenizers.js'),
        loadModule('/scripts/chats.js'), loadModule('/scripts/personas.js'), loadModule('/scripts/popup.js'),
        loadModule('/scripts/itemized-prompts.js'), loadModule('/scripts/stats.js'), loadModule('/scripts/utils.js'),
        loadModule('/scripts/world-info.js'),
    ]);
    const native = {
        ...script,
        get chat() { return script.chat; },
        get chat_metadata() { return script.chat_metadata; },
        get characters() { return script.characters; },
        get characterId() { return script.this_chid; },
        get groups() { return groups.groups; },
        get selectedGroup() { return groups.selected_group; },
        get selected_group() { return groups.selected_group; },
        get world_names() { return worlds.world_names; },
        get selected_world_info() { return worlds.selected_world_info; },
        get world_info() { return worlds.world_info; },
        worldInfoCache: worlds.worldInfoCache,
        $: window.$,
        get is_group_automode_enabled() { return groups.is_group_automode_enabled; },
        get name1() { return script.name1; },
        get streamingProcessor() { return script.streamingProcessor; },
        get user_avatar() { return personas.user_avatar; },
        power_user: power.power_user,
        getGroupChat: groups.getGroupChat,
        regenerateGroup: groups.regenerateGroup,
        loadItemizedPrompts: prompts.loadItemizedPrompts,
        deleteItemizedPromptForMessage: prompts.deleteItemizedPromptForMessage,
        statMesProcess: stats.statMesProcess,
        uuidv4: utils.uuidv4,
        getRegexedString: regex.getRegexedString,
        regex_placement: regex.regex_placement,
        getMessageTimeStamp: timestamps.getMessageTimeStamp,
        shouldSendOnEnter: timestamps.shouldSendOnEnter,
        getTokenCountAsync: tokens.getTokenCountAsync,
        populateFileAttachment: chats.populateFileAttachment,
        isPopupOpen: () => popup.Popup?.util?.isPopupOpen?.() ?? Boolean(document.querySelector('dialog[open]')),
        characterPortrait: message => {
            const filename = message.original_avatar ?? script.characters[script.this_chid]?.avatar;
            return filename && currentPortrait(groups, filename);
        },
    };
    return mountConversations({ native, window, document, accountId: users.currentUser.handle });
}

function currentPortrait(groups, filename) {
    const group = groups.groups.find(group => String(group.id) === String(groups.selected_group));
    if (!group?.multiplayer?.owner || filename === 'none') { return undefined; }
    return `/api/plugins/multiplayer/accounts/${encodeURIComponent(group.multiplayer.owner)}/characters/${encodeURIComponent(filename)}`;
}

/**
 * Initializes shared conversations after ownership has mounted and native APP_READY has completed.
 * @param {object} [options] Browser objects and injectable native module loader.
 * @returns {Promise<object>} One mounted conversation integration per browser.
 */
export function initializeConversations({ window = globalThis, document = globalThis.document, loadModule = path => import(path) } = {}) {
    if (!initializations.has(window)) {
        initializations.set(window, start({ window, document, loadModule }));
    }
    return initializations.get(window);
}

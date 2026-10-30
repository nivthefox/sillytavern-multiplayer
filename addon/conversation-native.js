import { ensureMessageIdentity } from './conversation-actions.js';

async function nativeRequestBody(input, options) {
    if (typeof options?.body === 'string') { return JSON.parse(options.body); }
    const request = typeof input === 'object' && typeof input.clone === 'function' ? input.clone() : null;
    const headers = new Headers(options?.headers ?? request?.headers);
    if (headers.get('Content-Encoding') === 'gzip') {
        const body = options?.body ?? await request.arrayBuffer();
        return new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
    }
    return request ? request.json() : null;
}

function messageIdentity(message) {
    return message?.extra?.multiplayer?.messageId;
}

/**
 * Adapts shared conversations to live SillyTavern bindings without owning action ordering.
 * @param {object} options Native bindings, browser objects, authenticated account and save hooks.
 * @returns {object} Preparation, transcript loading, queue mutation and persistence operations.
 */
export function createConversationNative({ native, window, document, accountId, apiBase = '/api/plugins/multiplayer', randomUUID = () => globalThis.crypto.randomUUID(), onSave = () => {}, onSaveFailure = () => {}, canSave = () => true, getCurrentChat = () => undefined }) {
    let originalFetch;
    let mounted = false;
    let active;
    let loading = 0;
    let saveAttempt;
    let confirmedMessages = false;
    const messageEvents = [];
    let renderedText = new Map();
    let initializing;
    const newChats = new Set();
    const knownGroups = new Map((native.groups ?? []).map(group => [String(group.id), new Set(group.chats ?? [])]));

    function chatKey(identity) {
        return JSON.stringify([identity.accountId, String(identity.groupId), identity.chatId]);
    }

    async function groupWrite(input, options, path) {
        const model = path === '/api/groups/edit' ? await nativeRequestBody(input, options) : null;
        const response = await originalFetch.call(window, input, options);
        if (!response.ok) { return response; }
        const group = model ?? await response.clone().json();
        if (group?.multiplayer?.owner !== accountId) { return response; }
        const previous = knownGroups.get(String(group.id));
        if (group.chat_id && (path === '/api/groups/create' || (previous && !previous.has(group.chat_id)))) {
            newChats.add(chatKey({ accountId, groupId: group.id, chatId: group.chat_id }));
        }
        knownGroups.set(String(group.id), new Set(group.chats ?? []));
        return response;
    }

    function rememberRenderedText() {
        renderedText = new Map(native.chat.map(message => [messageIdentity(message), message.mes]));
    }

    function taint() {
        if (native.chat_metadata) {
            native.chat_metadata.tainted = true;
        }
    }

    async function emit(name, ...args) {
        const event = native.event_types?.[name];
        if (event) {
            await native.eventSource?.emit(event, ...args);
        }
    }

    async function notifySaved() {
        while (messageEvents.length) {
            const [name, index] = messageEvents.shift();
            await emit(name, index);
            if (name === 'MESSAGE_SENT') {
                await emit('USER_MESSAGE_RENDERED', index);
            }
        }
    }

    async function readNativeChat(input, options, identity) {
        const request = loading;
        const body = await nativeRequestBody(input, options);
        if (body?.id !== identity.chatId) { throw new Error('Shared chat load was superseded.'); }
        const creation = identity.accountId === accountId && newChats.has(chatKey(identity));
        let response;
        if (creation || canSave() || (active?.isOwner && active.identity.chatId === identity.chatId)) {
            response = await originalFetch.call(window, input, options);
        } else {
            const { accountId: owner, groupId, chatId } = identity;
            response = await originalFetch.call(window, `${apiBase}/chats/${encodeURIComponent(owner)}/groups/${encodeURIComponent(groupId)}/chats/${encodeURIComponent(chatId)}`, { cache: 'no-store', headers: native.getRequestHeaders?.() });
        }
        if (!response.ok) { throw new Error(`Shared chat could not be loaded (${response.status}).`); }
        const records = await response.clone().json();
        if (request !== loading) { throw new Error('Shared chat load was superseded.'); }
        if (!Array.isArray(records)) { throw new Error('Invalid shared chat transcript.'); }
        if (creation && records.length === 0) {
            initializing = chatKey(identity);
            return response;
        }
        newChats.delete(chatKey(identity));
        const empty = records.length === 0 || (records.length === 1 && Object.hasOwn(records[0], 'chat_metadata'));
        if (!empty) { return response; }
        await native.clearChat({ clearData: false });
        if (request !== loading) { throw new Error('Shared chat load was superseded.'); }
        native.chat.splice(0);
        await native.printMessages();
        return Response.json(records.length ? records : [{ chat_metadata: {} }]);
    }

    async function interceptedFetch(input, options) {
        const url = typeof input === 'string' ? input : input.url ?? String(input);
        const path = new URL(url, document.baseURI).pathname;
        if (path === '/api/groups/create' || path === '/api/groups/edit') {
            return groupWrite(input, options, path);
        }
        const selected = getCurrentChat();
        const identity = selected === undefined ? active?.identity : selected;
        if (path === '/api/chats/group/get' && identity) {
            return readNativeChat(input, options, identity);
        }
        if (path !== '/api/chats/group/save') {
            return originalFetch.call(window, input, options);
        }
        let model;
        if (identity) {
            try { model = await nativeRequestBody(input, options); } catch { model = null; }
        }
        const creatingChat = identity && identity.accountId === accountId && initializing === chatKey(identity);
        if ((!canSave() && !creatingChat) || (identity && model?.id !== identity.chatId)) {
            const outcome = { status: 'failed', reason: 'This browser is not the authoritative owner.' };
            if (saveAttempt) {
                saveAttempt.outcome = outcome;
            }
            return Response.json({ error: outcome.reason }, { status: 403 });
        }
        if (model && Array.isArray(model.chat)) {
            let index = 0;
            for (const message of model.chat) {
                if (Object.hasOwn(message, 'chat_metadata')) { continue; }
                const live = native.chat[index++];
                if (message.is_user === false) {
                    const id = ensureMessageIdentity(message, randomUUID);
                    if (live && !messageIdentity(live)) {
                        live.extra ??= {};
                        live.extra.multiplayer = { ...live.extra.multiplayer, messageId: id };
                    }
                }
            }
            const headers = new Headers(options?.headers ?? input?.headers);
            headers.delete('Content-Encoding');
            options = { ...options, headers, body: JSON.stringify(model) };
        }
        const attempt = saveAttempt;
        const savingChat = JSON.stringify(identity ?? null);
        let response;
        try {
            response = await originalFetch.call(window, input, options);
        } catch (error) {
            const outcome = { status: 'uncertain', reason: error.message };
            if (attempt) {
                attempt.outcome = outcome;
            } else {
                try { await onSaveFailure(outcome); } catch (failure) { native.reportError?.(failure); }
            }
            throw error;
        }
        const outcome = response.ok ? { status: 'saved' } : { status: 'failed', reason: `Chat save failed (${response.status}).` };
        if (response.ok && creatingChat) {
            newChats.delete(initializing);
            initializing = undefined;
        }
        if (attempt) {
            attempt.outcome = outcome;
        } else if (!response.ok && canSave()) {
            try { await onSaveFailure(outcome); } catch (error) { native.reportError?.(error); }
        } else if (response.ok && canSave() && savingChat === JSON.stringify(getCurrentChat() ?? active?.identity ?? null)) {
            try {
                await notifySaved();
                await onSave(outcome);
            } catch (error) {
                native.reportError?.(error);
            }
        }
        return response;
    }

    async function prepareTurn(text) {
        const name = native.name1;
        const avatar = native.user_avatar;
        const { messageBias } = native.getBiasStrings(text, 'normal');
        const filtered = native.getRegexedString(text, native.regex_placement.USER_INPUT);
        const message = {
            name,
            is_user: true,
            is_system: false,
            send_date: native.getMessageTimeStamp(),
            mes: native.substituteParams(filtered),
            force_avatar: `${apiBase}/accounts/${encodeURIComponent(accountId)}/personas/${encodeURIComponent(avatar)}`,
            extra: { isSmallSys: false, multiplayer: { accountId, messageId: randomUUID() } },
        };
        if (native.power_user.message_token_count_enabled) {
            message.extra.token_count = await native.getTokenCountAsync(message.mes, 0);
        }
        if (messageBias) {
            message.extra.bias = messageBias;
            message.mes = native.removeMacros(message.mes);
        }
        await native.populateFileAttachment(message);
        return structuredClone(message);
    }

    async function prepareEdit(message, text) {
        const placement = message.is_user ? native.regex_placement.USER_INPUT : message.extra?.type === 'narrator' ? native.regex_placement.SLASH_COMMAND : native.regex_placement.AI_OUTPUT;
        text = native.getRegexedString(text, placement, { characterOverride: message.extra?.type === 'narrator' ? undefined : message.name, isEdit: true });
        if (native.power_user.trim_spaces) {
            text = text.trim();
        }
        const bias = native.substituteParams(native.extractMessageBias(text));
        text = native.substituteParams(text);
        return bias ? native.removeMacros(text) : text;
    }

    async function reloadTranscript(identity, { isOwner }) {
        active = { identity: structuredClone(identity), isOwner };
        const request = ++loading;
        const { accountId: owner, groupId, chatId } = identity;
        const url = isOwner ? '/api/chats/group/get' : `${apiBase}/chats/${encodeURIComponent(owner)}/groups/${encodeURIComponent(groupId)}/chats/${encodeURIComponent(chatId)}`;
        const options = { headers: native.getRequestHeaders?.(), cache: 'no-store' };
        if (isOwner) { Object.assign(options, { method: 'POST', body: JSON.stringify({ id: chatId }) }); }
        const response = await window.fetch(url, options);
        if (!response.ok) {
            throw new Error(`Shared chat could not be loaded (${response.status}).`);
        }
        const transcript = await response.json();
        if (!Array.isArray(transcript)) {
            throw new Error('Invalid shared chat transcript.');
        }
        if (request !== loading) {
            return native.chat;
        }
        const hasHeader = transcript[0] && Object.hasOwn(transcript[0], 'chat_metadata');
        const messages = hasHeader ? transcript.slice(1) : transcript;
        await native.clearChat({ clearData: false });
        if (request !== loading) { return native.chat; }
        if (isOwner) { await native.loadItemizedPrompts?.(chatId); }
        if (request !== loading) { return native.chat; }
        native.chat.splice(0, native.chat.length, ...messages.map(message => {
            if (isOwner || message.is_user || !message.original_avatar) { return message; }
            return { ...message, force_avatar: `${apiBase}/accounts/${encodeURIComponent(owner)}/characters/${encodeURIComponent(message.original_avatar)}` };
        }));
        const metadata = hasHeader ? structuredClone(transcript[0].chat_metadata) : {};
        if (isOwner) { metadata.integrity ??= randomUUID(); }
        native.updateChatMetadata(metadata, true);
        await native.printMessages();
        rememberRenderedText();
        messageEvents.splice(0);
        return native.chat;
    }

    async function reload(identity, options) {
        const composer = document.querySelector('#send_textarea');
        let draft = composer?.value;
        const preserveDraft = () => { draft = composer.value; };
        composer?.addEventListener('input', preserveDraft);
        try {
            return await reloadTranscript(identity, options);
        } finally {
            composer?.removeEventListener('input', preserveDraft);
            if (composer && composer.value !== draft) {
                composer.value = draft;
            }
        }
    }

    async function save() {
        for (const [index, message] of native.chat.entries()) {
            const id = messageIdentity(message);
            if (message.is_user && id && renderedText.has(id) && renderedText.get(id) !== message.mes) {
                taint();
                messageEvents.push(['MESSAGE_EDITED', index], ['MESSAGE_UPDATED', index]);
            }
        }
        const attempt = { outcome: { status: 'uncertain' } };
        saveAttempt = attempt;
        try {
            await native.saveChatConditional();
        } catch (error) {
            if (attempt.outcome.status === 'uncertain') {
                attempt.outcome.reason = error.message;
            }
        } finally {
            if (saveAttempt === attempt) {
                saveAttempt = undefined;
            }
        }
        confirmedMessages = attempt.outcome.status === 'saved';
        return attempt.outcome;
    }

    return {
        /** Installs observation of actual native chat persistence responses. */
        mount() {
            if (mounted) {
                return;
            }
            originalFetch = window.fetch;
            window.fetch = interceptedFetch;
            mounted = true;
        },
        /** Invalidates any pending read when switching away from the current scene. */
        invalidate() {
            loading++;
            active = undefined;
            initializing = undefined;
            messageEvents.splice(0);
            confirmedMessages = false;
        },
        /** Removes this adapter's fetch interception and invalidates pending reads. */
        dispose() {
            loading++;
            if (mounted && window.fetch === interceptedFetch) {
                window.fetch = originalFetch;
            }
            mounted = false;
        },
        /** Prepares a detached player message in the sender's native context without saving. */
        prepareTurn,
        /** Prepares replacement player text using native edit-time transformations. */
        prepareEdit,
        /** Runs native slash-command handling and reports whether input was consumed. */
        processCommands(text) {
            return native.processCommands(text);
        },
        /** Reloads the selected transcript without changing the composer's draft. */
        reload,
        /** Restores the authoritative transcript previously selected by reload. */
        loadSaved() {
            if (!active) {
                throw new Error('No shared conversation is loaded.');
            }
            return reload(active.identity, { isOwner: active.isOwner });
        },
        /** Returns the live native message array for the authoritative action queue. */
        getMessages() {
            return native.chat;
        },
        /** Inserts already prepared content without transforming or saving it. */
        async insertMessage(message) {
            await native.statMesProcess?.(message, 'user', native.characters, native.characterId, '');
            native.chat.push(structuredClone(message));
            taint();
            messageEvents.push(['MESSAGE_SENT', native.chat.length - 1]);
        },
        /** Deletes one message or an owner-selected suffix without a debounced save. */
        async deleteMessage(index, { bulk = false } = {}) {
            native.closeMessageEditor?.();
            const end = bulk ? native.chat.length : index + 1;
            for (let target = end - 1; target >= index; target--) { native.deleteItemizedPromptForMessage?.(target); }
            native.chat.splice(index, bulk ? native.chat.length - index : 1);
            taint();
            messageEvents.push(['MESSAGE_DELETED', native.chat.length]);
        },
        /** Applies an owner-local AI edit in place without saving or adding a swipe. */
        async editMessage(index, text) {
            const message = native.chat[index];
            message.mes = text;
            if (message.swipes && message.swipe_id !== undefined) {
                message.swipes[message.swipe_id] = text;
            }
            taint();
            messageEvents.push(['MESSAGE_EDITED', index], ['MESSAGE_UPDATED', index]);
        },
        /** Renders the current live chat through native rendering facilities. */
        async render() {
            native.closeMessageEditor?.();
            if (native.redisplayChat) {
                await native.redisplayChat({ fade: false });
            } else {
                document.querySelector('#chat')?.replaceChildren();
                await native.printMessages();
            }
            rememberRenderedText();
            if (confirmedMessages) {
                confirmedMessages = false;
                await notifySaved();
            }
        },
        /** Saves through the native group path, returning confirmed or uncertain persistence status. */
        save,
        /** Assigns an AI identity before previews or persistence and preserves it in swipe metadata. */
        ensureMessageIdentity(message) {
            message.extra ??= {};
            message.extra.multiplayer ??= {};
            message.extra.multiplayer.messageId ??= randomUUID();
            const swipe = message.swipe_info?.[message.swipe_id];
            if (swipe) {
                swipe.extra ??= {};
                swipe.extra.multiplayer = { ...swipe.extra.multiplayer, messageId: messageIdentity(message) };
            }
            return messageIdentity(message);
        },
    };
}

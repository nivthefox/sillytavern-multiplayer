import { createChatOwnership } from './chat-ownership.js';
import { createOwnershipNative } from './ownership-native.js';

const initializations = new WeakMap();

async function startOwnership({ window, document, loadModule, createService, createAdapter }) {
    const [script, groups, users, extensions] = await Promise.all([
        loadModule('/script.js'),
        loadModule('/scripts/group-chats.js'),
        loadModule('/scripts/user.js'),
        loadModule('/scripts/extensions.js'),
    ]);
    await new Promise(resolve => script.eventSource.on(script.event_types.APP_READY, resolve));
    const user = users.currentUser;
    if (!user?.handle) {
        throw new Error('Multiplayer requires an authenticated SillyTavern account.');
    }
    const reportError = error => window.toastr?.error(error.message, 'Multiplayer');
    const service = createService({
        account: { id: user.handle, name: user.name, avatar: user.avatar ?? null },
        extensionSettings: extensions.extension_settings,
        saveSettings: script.saveSettingsDebounced,
        getRequestHeaders: script.getRequestHeaders,
        fetch: window.fetch.bind(window),
        reportError,
    });
    const native = {
        get groups() { return groups.groups; },
        get characters() { return script.characters; },
        get chat() { return script.chat; },
        get selectedGroup() { return groups.selected_group; },
        get openGroupId() { return groups.openGroupId; },
        entitiesFilter: script.entitiesFilter,
        eventSource: script.eventSource,
        event_types: script.event_types,
        openGroupById: groups.openGroupById,
        select_group_chats: groups.select_group_chats,
        clearChat: script.clearChat,
        printMessages: script.printMessages,
        updateChatMetadata: script.updateChatMetadata,
        displayPastChats: script.displayPastChats,
        getCharacters: script.getCharacters,
        getRequestHeaders: script.getRequestHeaders,
        default_avatar: script.default_avatar,
        reportError,
    };
    const adapter = createAdapter({ service, native, document, window });
    await adapter.mount();
    await adapter.refreshGroups();
    return adapter;
}

/**
 * Initializes ownership after native APP_READY, including its late-subscriber replay.
 * Repeated calls for the same browser return the same initialization promise.
 * @param {object} [options] Browser objects and injectable native module/factory dependencies.
 * @returns {Promise<object>} Mounted ownership adapter, or a rejected initialization on failure.
 */
export function initializeOwnership({ window = globalThis, document = globalThis.document, loadModule = path => import(path), createService = createChatOwnership, createAdapter = createOwnershipNative } = {}) {
    if (!initializations.has(window)) {
        const initialization = startOwnership({ window, document, loadModule, createService, createAdapter });
        initializations.set(window, initialization);
    }
    return initializations.get(window);
}

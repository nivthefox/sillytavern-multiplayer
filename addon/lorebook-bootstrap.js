import { createLorebookNative } from './lorebook-native.js';
import { createLorebookSession } from './lorebook-session.js';

/**
 * Mounts shared lorebook reads, contributions and persistence notifications on the existing conversation bus.
 * @param {object} options Live native bindings, browser objects, authenticated account and conversation bus.
 * @returns {object} Shared lorebook session, loaded-selection refresh and disposal operations.
 */
export function mountLorebooks({ native, window, document, accountId, bus, getCurrentChat, onError = () => {} }) {
    let lifecycle;
    let selectionKey;
    let discoveryKey;
    let loading = Promise.resolve();
    const session = createLorebookSession({
        accountId, send: (...args) => bus.send(...args), fetch: (...args) => window.fetch(...args),
        isSelf: sender => lifecycle?.isSelf(sender) ?? false, onError,
    });
    const adapter = createLorebookNative({
        native, window, document, accountId,
        getBooks: () => session.getBooks(), isOwner: () => session.getState().isOwner,
        onSaved: filename => session.confirmSaved(filename),
        onDeleted: filename => session.confirmDeleted(filename),
        onSelectionsChanged: () => refresh().catch(onError),
    });

    async function refresh() {
        if (!sameChat(session.getState().chat, getCurrentChat())) { return; }
        const group = native.groups.find(group => String(group.id) === String(native.selected_group));
        if (!group) { return; }
        const snapshot = {
            globalBooks: adapter.getContribution(true).map(filename => filename.slice(0, -5)),
            personaBook: adapter.getContribution(false)[0]?.slice(0, -5) ?? '',
        };
        const discovery = {
            characters: native.characters.filter(character => group.members?.includes(character.avatar))
                .map(character => ({ data: { extensions: { world: character.data?.extensions?.world } } })),
            chatMetadata: { world_info: native.chat_metadata?.world_info },
        };
        const operations = [];
        const nextSelections = JSON.stringify(snapshot);
        const nextDiscovery = JSON.stringify(discovery);
        if (selectionKey !== nextSelections) {
            selectionKey = nextSelections;
            operations.push(session.setSelections(snapshot));
        }
        if (discoveryKey !== nextDiscovery) {
            discoveryKey = nextDiscovery;
            operations.push(session.setDiscovery(discovery));
        }
        await Promise.all(operations);
    }

    lifecycle = mountLorebookLifecycle({
        bus, getCurrentChat, onError, randomUUID: native.uuidv4,
        session: {
            ...session,
            open(chat) {
                session.open(chat);
                selectionKey = undefined;
                discoveryKey = undefined;
                loading = refresh().catch(onError);
            },
            joined(result) {
                loading = Promise.all([session.joined(result), loading]).then(() => syncLocalCache());
                return loading;
            },
            async saved(sender, body) {
                const invalidate = isLocalNotification(sender, body);
                await session.saved(sender, body);
                if (invalidate) { syncLocalCache(body.filename); }
            },
            async deleted(sender, body) {
                const invalidate = isLocalNotification(sender, body);
                await session.deleted(sender, body);
                if (invalidate) { native.worldInfoCache.delete(body.filename.slice(0, -5)); }
            },
        },
    });
    function syncLocalCache(filename) {
        for (const book of session.getBooks({ successfulOnly: true })) {
            if (book.accountId === accountId && (!filename || filename === book.filename)) {
                native.worldInfoCache.set(book.filename.slice(0, -5), book.data);
            }
        }
    }

    function isLocalNotification(sender, body) {
        return sender?.accountId === accountId && typeof sender.connectionId === 'string' && sender.connectionId.length > 0
            && !lifecycle.isSelf(sender)
            && Boolean(session.resolve({ accountId, filename: body?.filename }));
    }

    adapter.mount();
    return {
        session,
        /** @returns {Promise<void>} Rebuilds loaded associations and waits for current shared-book hydration. */
        async refresh() {
            await refresh();
            await loading;
        },
        /** @returns {Promise<void>} Completion of the latest join's shared-book hydration, independent of bus membership. */
        ready() { return loading; },
        /** @returns {void} Removes native overrides and bus subscriptions without owning conversation membership. */
        dispose() {
            adapter.dispose();
            lifecycle.dispose();
        },
    };
}

function sameChat(left, right) {
    return Boolean(left && right && ['accountId', 'groupId', 'chatId'].every(key => left[key] === right[key]));
}

/**
 * Shares conversation membership with lorebooks, including library-driven rejoins.
 * @param {object} options Existing bus, lorebook session, current-chat provider and error reporter.
 * @returns {object} Browser identity predicate and reversible lifecycle installation.
 */
export function mountLorebookLifecycle({ bus, session, getCurrentChat, randomUUID = () => globalThis.crypto.randomUUID(), onError = () => {} }) {
    const originalJoin = bus.join;
    const originalLeave = bus.leave;
    let current = null;
    let nonce;
    let selfConnection;
    let joining = 0;
    let epoch = 0;
    const subscriptions = [];

    function listen(name, handler) {
        subscriptions.push(bus.on(name, (chat, sender, body) => {
            if (!sameChat(chat, current) || !sameChat(chat, getCurrentChat())) { return; }
            return handler(sender, body);
        }));
    }

    async function join(chat) {
        const request = ++epoch;
        if (!sameChat(chat, current)) {
            current = structuredClone(chat);
            session.open(chat);
        }
        joining++;
        let result;
        try {
            result = await originalJoin.call(bus, chat);
        } finally {
            joining--;
        }
        if (request !== epoch || !sameChat(chat, getCurrentChat())) { return result; }
        nonce = randomUUID();
        selfConnection = undefined;
        void bus.send('all', 'multiplayer.lorebooks.identify', { nonce }).catch(onError);
        void Promise.resolve(session.joined(result)).catch(onError);
        return result;
    }

    function clear() {
        epoch++;
        current = null;
        nonce = undefined;
        selfConnection = undefined;
        session.leave();
    }

    function leave() {
        clear();
        return originalLeave.call(bus);
    }

    listen('bus.status', (_sender, body) => {
        if (!joining) { return session.status(body); }
    });
    listen('multiplayer.lorebooks.changed', (_sender, body) => session.receiveList(body));
    listen('multiplayer.lorebook.saved', (sender, body) => session.saved(sender, body));
    listen('multiplayer.lorebook.deleted', (sender, body) => session.deleted(sender, body));
    listen('multiplayer.lorebooks.identify', (sender, body) => {
        if (nonce && body?.nonce === nonce && typeof sender?.connectionId === 'string') {
            selfConnection = sender.connectionId;
        }
    });
    subscriptions.push(bus.on('bus.disconnected', () => {
        nonce = undefined;
        selfConnection = undefined;
        session.disconnected();
    }));
    bus.join = join;
    bus.leave = leave;

    return {
        /** @param {object|null} sender Bus-supplied sender. @returns {boolean} Whether it is this connection, not another tab of the account. */
        isSelf(sender) { return Boolean(selfConnection && sender?.connectionId === selfConnection); },
        /** @returns {void} Removes shared access and restores the original membership methods. */
        dispose() {
            clear();
            for (const unsubscribe of subscriptions) { unsubscribe(); }
            if (bus.join === join) { bus.join = originalJoin; }
            if (bus.leave === leave) { bus.leave = originalLeave; }
        },
    };
}

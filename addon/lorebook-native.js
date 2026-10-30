const identityPrefix = 'multiplayer-lorebook:';
const selectionEvents = [
    'WORLDINFO_SETTINGS_UPDATED', 'PERSONA_CHANGED', 'PERSONA_UPDATED',
    'CHARACTER_EDITED', 'GROUP_UPDATED', 'CHAT_CHANGED', 'CHAT_LOADED',
    'SETTINGS_UPDATED', 'SETTINGS_LOADED', 'SETTINGS_LOADED_AFTER',
];

function qualifiedName({ accountId, filename }) {
    return `${identityPrefix}${JSON.stringify([accountId, filename])}`;
}

function parseIdentity(name) {
    if (typeof name !== 'string' || !name.startsWith(identityPrefix)) {
        return null;
    }
    try {
        const value = JSON.parse(name.slice(identityPrefix.length));
        if (Array.isArray(value) && value.length === 2 && value.every(part => typeof part === 'string' && part.length)) {
            return { accountId: value[0], filename: value[1] };
        }
    } catch {}
    throw new Error('Invalid shared lorebook identity.');
}

async function requestBody(input, options) {
    if (typeof options?.body === 'string') {
        return JSON.parse(options.body);
    }
    if (input instanceof Request) {
        return input.clone().json();
    }
    return null;
}

function nativeCharacterFilename(character) {
    if (character.multiplayer?.filename) {
        return character.multiplayer.filename;
    }
    return character.avatar;
}

/**
 * Integrates shared books with native cache/HTTP reads, persistence and pre-activation evaluation.
 * Qualified native names use `multiplayer-lorebook:` followed by JSON.stringify([accountId, filename]).
 * Native editor reads and owner generation collection retain their local selected books.
 * @param {object} options Live native bindings, browser objects, account identity and callbacks.
 * @param {Function} options.getBooks Synchronous current availability as accountId/filename/data records; missing data remains unavailable.
 * @param {Function} options.isOwner Whether this browser is the selected owner of the shared chat.
 * @param {Function} options.onSelectionsChanged Called after relevant native selections change.
 * @param {Function} options.onSaved Called with a native filename after confirmed successful shared-book persistence.
 * @param {Function} options.onDeleted Called with a native filename after confirmed successful shared-book deletion.
 * @returns {object} Reversible mount/dispose operations and native contribution collection.
 */
export function createLorebookNative({ native, window, document, accountId, getBooks, isOwner, onSelectionsChanged = () => {}, onSaved = () => {}, onDeleted = () => {} }) {
    const cache = native.worldInfoCache;
    const sharedCopies = new WeakSet();
    const subscriptions = [];
    const watchedSelections = [];
    let mounted = false;
    let originalFetch;
    let originalDispatch;
    let originalCache;
    let localEditorDepth = 0;
    let collectingNativeLore = false;
    let selectionSignature;

    function getContribution(owner) {
        const persona = native.power_user?.persona_description_lorebook;
        if (!owner) {
            return persona ? [`${persona}.json`] : [];
        }
        const names = new Set(native.selected_world_info ?? []);
        names.add(native.chat_metadata?.world_info);
        names.add(persona);
        const group = native.groups?.find(value => String(value.id) === String(native.selected_group));
        for (const member of group?.members ?? []) {
            const character = native.characters?.find(value => value.avatar === member || nativeCharacterFilename(value) === member);
            if (!character) {
                continue;
            }
            names.add(character.data?.extensions?.world);
            const filename = nativeCharacterFilename(character)?.replace(/\.[^/.]+$/, '');
            const additional = native.world_info?.charLore?.find(value => value.name === filename);
            for (const name of additional?.extraBooks ?? []) {
                names.add(name);
            }
        }
        return [...names].filter(name => typeof name === 'string' && name.length).map(name => `${name}.json`);
    }

    function report(error) {
        native.reportError?.(error);
    }

    function notify(callback, ...args) {
        try {
            Promise.resolve(callback(...args)).catch(report);
        } catch (error) {
            report(error);
        }
    }

    function watchSelection(object, key) {
        if (!object || watchedSelections.some(watch => watch.object === object && watch.key === key && Object.getOwnPropertyDescriptor(object, key)?.get === watch.get)) {
            return;
        }
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (descriptor && (!descriptor.configurable || !descriptor.writable || descriptor.get || descriptor.set)) {
            return;
        }
        let value = object[key];
        const get = () => value;
        Object.defineProperty(object, key, {
            configurable: true,
            enumerable: descriptor?.enumerable ?? true,
            get,
            set(next) {
                value = next;
                queueMicrotask(selectionsChanged);
            },
        });
        watchedSelections.push({ object, key, descriptor, get });
    }

    function watchSelections() {
        watchSelection(native.world_info, 'charLore');
        watchSelection(native.power_user, 'persona_description_lorebook');
        watchSelection(native.chat_metadata, 'world_info');
    }

    function selectionEvent() {
        if (!mounted) {
            return;
        }
        watchSelections();
        selectionSignature = JSON.stringify([getContribution(true), getContribution(false)]);
        notify(onSelectionsChanged);
    }

    function selectionsChanged() {
        if (!mounted) {
            return;
        }
        watchSelections();
        const signature = JSON.stringify([getContribution(true), getContribution(false)]);
        if (signature === selectionSignature) {
            return;
        }
        selectionSignature = signature;
        notify(onSelectionsChanged);
    }

    function findBook(name) {
        const identity = parseIdentity(name);
        const books = getBooks();
        if (identity) {
            const book = books.find(value => value.accountId === identity.accountId && value.filename === identity.filename);
            if (!book) {
                throw new Error('Shared lorebook is unavailable.');
            }
            return book;
        }
        const matches = new Map();
        for (const book of books) {
            if (book.filename === `${name}.json`) {
                matches.set(qualifiedName(book), book);
            }
        }
        if (matches.size > 1) {
            throw new Error(`Ambiguous shared lorebook name: ${name}`);
        }
        return matches.values().next().value;
    }

    function sharedRead(book) {
        if (!book.data) {
            throw new Error(`Shared lorebook is unavailable: ${book.filename}`);
        }
        const data = structuredClone(book.data);
        sharedCopies.add(data);
        return data;
    }

    function selectedNativeBook(name) {
        return typeof name === 'string' && !name.startsWith(identityPrefix) && getContribution(true).includes(`${name}.json`);
    }

    function localRead(name) {
        return localEditorDepth > 0 || (collectingNativeLore && isOwner() && selectedNativeBook(name));
    }

    function beginNativeCollection() {
        collectingNativeLore = isOwner();
    }

    function endNativeCollection() {
        collectingNativeLore = false;
    }

    function cachedHas(name) {
        if (!mounted || localRead(name)) {
            return originalCache.has.call(cache, name);
        }
        const book = findBook(name);
        if (book && book.accountId !== accountId) {
            return true;
        }
        return originalCache.has.call(cache, book ? book.filename.slice(0, -5) : name);
    }

    function cachedGet(name) {
        if (!mounted || localRead(name)) {
            return originalCache.get.call(cache, name);
        }
        const book = findBook(name);
        if (book && book.accountId !== accountId) {
            return sharedRead(book);
        }
        return originalCache.get.call(cache, book ? book.filename.slice(0, -5) : name);
    }

    function cachedSet(name, data) {
        if (!mounted) {
            return originalCache.set.call(cache, name, data);
        }
        const identity = parseIdentity(name);
        if (sharedCopies.has(data) || (identity && identity.accountId !== accountId)) {
            throw new Error('Shared lorebooks are read-only.');
        }
        return originalCache.set.call(cache, identity ? identity.filename.slice(0, -5) : name, data);
    }

    function dispatch(event, ...args) {
        const editor = event.type === 'change' && event.target?.id === 'world_editor_select';
        if (editor) {
            localEditorDepth++;
        }
        try {
            return originalDispatch.call(this, event, ...args);
        } finally {
            if (editor) {
                localEditorDepth--;
            }
            if (['change', 'input', 'click'].includes(event.type)) {
                queueMicrotask(selectionsChanged);
            }
        }
    }

    function protectResponse(response) {
        const json = response.json.bind(response);
        const clone = response.clone.bind(response);
        response.json = async () => {
            const data = await json();
            sharedCopies.add(data);
            return data;
        };
        response.clone = () => protectResponse(clone());
        return response;
    }

    async function readBook(input, options, body, localEditor) {
        if (localEditor) {
            return originalFetch.call(window, input, options);
        }
        const book = findBook(body.name);
        if (!book) {
            return originalFetch.call(window, input, options);
        }
        if (book.accountId !== accountId) {
            return protectResponse(Response.json(sharedRead(book)));
        }
        const name = book.filename.slice(0, -5);
        if (name === body.name) {
            return originalFetch.call(window, input, options);
        }
        const init = { ...options, method: 'POST', headers: options?.headers ?? input?.headers, body: JSON.stringify({ ...body, name }) };
        return originalFetch.call(window, input, init);
    }

    function writeDenied(name) {
        const identity = parseIdentity(name);
        if (identity) {
            return identity.accountId !== accountId;
        }
        return !native.world_names?.includes(name) && getBooks().some(book => book.accountId !== accountId && book.filename === `${name}.json`);
    }

    async function persistBook(input, options, body, path) {
        if (writeDenied(body.name)) {
            return Response.json({ error: 'Shared lorebooks are read-only.' }, { status: 403 });
        }
        const identity = parseIdentity(body.name);
        const name = identity ? identity.filename.slice(0, -5) : body.name;
        const filename = `${name}.json`;
        const shared = getBooks().some(book => book.accountId === accountId && book.filename === filename);
        const init = identity ? { ...options, method: 'POST', headers: options?.headers ?? input?.headers, body: JSON.stringify({ ...body, name }) } : options;
        const response = await originalFetch.call(window, input, init);
        const stillShared = getBooks().some(book => book.accountId === accountId && book.filename === filename);
        if (mounted && response.ok && shared && stillShared) {
            notify(path === '/api/worldinfo/edit' ? onSaved : onDeleted, filename);
        }
        return response;
    }

    async function interceptedFetch(input, options) {
        if (!mounted) {
            return originalFetch.call(window, input, options);
        }
        const localEditor = localEditorDepth > 0;
        const localGeneration = collectingNativeLore && isOwner();
        const url = new URL(typeof input === 'string' ? input : input.url ?? String(input), document.baseURI);
        const method = (options?.method ?? input?.method ?? 'GET').toUpperCase();
        const paths = ['/api/worldinfo/get', '/api/worldinfo/edit', '/api/worldinfo/delete'];
        if (url.origin !== new URL(document.baseURI).origin || method !== 'POST' || !paths.includes(url.pathname)) {
            return originalFetch.call(window, input, options);
        }
        let body;
        try {
            body = await requestBody(input, options);
        } catch {
            return originalFetch.call(window, input, options);
        }
        if (typeof body?.name !== 'string' || !body.name) {
            return originalFetch.call(window, input, options);
        }
        if (url.pathname === '/api/worldinfo/get') {
            return readBook(input, options, body, localEditor || (localGeneration && selectedNativeBook(body.name)));
        }
        return persistBook(input, options, body, url.pathname);
    }

    function addGuestEntries(collections) {
        if (!isOwner()) {
            return;
        }
        const worlds = new Set(Object.values(collections).flat().map(entry => entry.world));
        for (const book of getBooks()) {
            if (book.accountId === accountId || !book.data?.entries) {
                continue;
            }
            const world = qualifiedName(book);
            if (worlds.has(world)) {
                continue;
            }
            worlds.add(world);
            for (const entry of Object.values(book.data.entries)) {
                collections.personaLore.push({ ...structuredClone(entry), world });
            }
        }
    }

    function subscribe(key, callback) {
        const name = native.event_types?.[key];
        if (!name || !native.eventSource) {
            return;
        }
        native.eventSource.on(name, callback);
        subscriptions.push([name, callback]);
    }

    return {
        /** @param {boolean} owner Whether to collect owner selections rather than only the active persona. @returns {string[]} Deduplicated native filenames. */
        getContribution,
        /** @returns {void} Installs native read, persistence, selection and pre-activation hooks once. */
        mount() {
            if (mounted) {
                return;
            }
            mounted = true;
            originalFetch = window.fetch;
            originalCache = { has: cache.has, get: cache.get, set: cache.set };
            window.fetch = interceptedFetch;
            cache.has = cachedHas;
            cache.get = cachedGet;
            cache.set = cachedSet;
            if (native.$?.event) {
                originalDispatch = native.$.event.dispatch;
                native.$.event.dispatch = dispatch;
            }
            selectionSignature = JSON.stringify([getContribution(true), getContribution(false)]);
            watchSelections();
            for (const event of selectionEvents) {
                subscribe(event, selectionEvent);
            }
            subscribe('CHAT_CHANGED', endNativeCollection);
            subscribe('GENERATION_STARTED', endNativeCollection);
            subscribe('GENERATION_AFTER_COMMANDS', beginNativeCollection);
            subscribe('GENERATION_STOPPED', endNativeCollection);
            subscribe('GENERATION_ENDED', endNativeCollection);
            subscribe('WORLDINFO_ENTRIES_LOADED', addGuestEntries);
        },
        /** @returns {void} Removes adapter hooks without replacing local cache contents or other wrappers. */
        dispose() {
            if (!mounted) {
                return;
            }
            mounted = false;
            endNativeCollection();
            for (const { object, key, descriptor, get } of watchedSelections.splice(0)) {
                if (Object.getOwnPropertyDescriptor(object, key)?.get !== get) {
                    continue;
                }
                const value = object[key];
                if (descriptor) {
                    Object.defineProperty(object, key, { ...descriptor, value });
                } else {
                    delete object[key];
                    if (value !== undefined) {
                        object[key] = value;
                    }
                }
            }
            for (const [name, callback] of subscriptions.splice(0)) {
                native.eventSource.removeListener(name, callback);
            }
            if (window.fetch === interceptedFetch) {
                window.fetch = originalFetch;
            }
            for (const [key, callback] of [['has', cachedHas], ['get', cachedGet], ['set', cachedSet]]) {
                if (cache[key] === callback) {
                    cache[key] = originalCache[key];
                }
            }
            if (native.$?.event?.dispatch === dispatch) {
                native.$.event.dispatch = originalDispatch;
            }
        },
    };
}

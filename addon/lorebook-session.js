function validString(value) {
    return typeof value === 'string' && value.length > 0;
}

function validFilename(value) {
    return validString(value) && value.endsWith('.json') && value.length > 5;
}

function validIdentity(value) {
    return value && validString(value.accountId) && validFilename(value.filename);
}

function identityKey({ accountId, filename }) {
    return JSON.stringify([accountId, filename]);
}

function referenceMap(references) {
    return new Map(references.map(({ accountId, filename }) => {
        const identity = { accountId, filename };
        return [identityKey(identity), identity];
    }));
}

function selectionNames(selections, isOwner) {
    if (!selections) {
        return [];
    }
    if (!isOwner) {
        return [selections.personaBook];
    }
    return [
        ...selections.globalBooks ?? [],
        selections.chatBook,
        selections.personaBook,
        ...(selections.characters ?? []).flatMap(character => [
            character.primaryBook, ...character.additionalBooks ?? [],
        ]),
    ];
}

function withoutBook(selections, filename) {
    const retained = name => `${name}.json` !== filename;
    return {
        ...selections,
        globalBooks: (selections.globalBooks ?? []).filter(retained),
        chatBook: retained(selections.chatBook) ? selections.chatBook : '',
        personaBook: retained(selections.personaBook) ? selections.personaBook : '',
        characters: (selections.characters ?? []).map(character => ({
            ...character,
            primaryBook: retained(character.primaryBook) ? character.primaryBook : '',
            additionalBooks: (character.additionalBooks ?? []).filter(retained),
        })),
    };
}

/**
 * Creates shared lorebook availability, contribution and HTTP-cache state without browser wiring.
 * Integration supplies already-loaded native selections, lifecycle events and confirmed persistence.
 * @param {object} options Dependencies.
 * @param {string} options.accountId The authenticated local account handle.
 * @param {Function} options.send Bus send(destination, eventName, body).
 * @param {Function} [options.fetch=globalThis.fetch] HTTP fetch implementation.
 * @param {string} [options.apiBase='/api/plugins/multiplayer'] Plugin API mount.
 * @param {Function} options.isSelf Tests whether a bus sender is this connection, not merely this account.
 * @param {Function} [options.onError] Reports HTTP and publication errors.
 * @returns {object} Explicit lifecycle, selection, notification and read operations.
 */
export function createLorebookSession({
    accountId,
    send,
    fetch = globalThis.fetch,
    apiBase = '/api/plugins/multiplayer',
    isSelf,
    onError = () => {},
}) {
    let chat = null;
    let connected = false;
    let isOwner = false;
    let ownerPresent = false;
    let hasJoined = false;
    let selections = null;
    let pluginBooks = new Map();
    let discoveredBooks = new Map();
    const books = new Map();
    const retainedContents = new Map();
    const withdrawnSelections = new Set();
    const withdrawnDiscovery = new Set();
    let epoch = 0;

    function contribution() {
        return [...new Set(selectionNames(selections, isOwner).filter(validString).map(name => `${name}.json`))];
    }

    async function publish(eventName, body, destination = 'all') {
        if (!chat || !connected) {
            return;
        }
        const currentEpoch = epoch;
        try {
            await send(destination, eventName, body);
        } catch (error) {
            if (currentEpoch === epoch) {
                onError(error);
            }
        }
    }

    function publishContribution() {
        if (!selections) {
            return Promise.resolve();
        }
        return publish('multiplayer.lorebooks.set', { lorebooks: contribution() }, 'server');
    }

    function current(entry, revision = entry.revision) {
        return books.get(identityKey(entry.identity)) === entry && revision === entry.revision;
    }

    function refresh(entry) {
        const revision = ++entry.revision;
        const { accountId: source, filename } = entry.identity;
        const url = `${apiBase}/accounts/${encodeURIComponent(source)}/lore/${encodeURIComponent(filename)}`;
        const pending = (async () => {
            try {
                const response = await fetch(url, { method: 'GET' });
                if (!response.ok) {
                    throw new Error(`Shared lorebook load failed (${response.status}): ${source}/${filename}`);
                }
                const contents = await response.json();
                if (!contents || typeof contents !== 'object' || Array.isArray(contents)) {
                    throw new Error(`Invalid shared lorebook contents: ${source}/${filename}`);
                }
                if (!current(entry, revision)) {
                    return;
                }
                entry.contents = structuredClone(contents);
                retainedContents.set(identityKey(entry.identity), entry.contents);
                entry.error = null;
            } catch (error) {
                if (current(entry, revision)) {
                    entry.error = error;
                    onError(error);
                }
            }
        })();
        entry.pending = pending;
        const clearPending = () => {
            if (current(entry, revision)) {
                entry.pending = null;
            }
        };
        pending.then(clearPending, clearPending);
        return pending;
    }

    function reconcile(refreshCached = false) {
        const availability = new Map([...pluginBooks, ...discoveredBooks]);
        for (const key of books.keys()) {
            if (!availability.has(key)) {
                books.delete(key);
            }
        }
        const loads = [];
        for (const [key, identity] of availability) {
            let entry = books.get(key);
            if (!entry) {
                entry = { identity, contents: retainedContents.get(key), pending: null, error: null, revision: 0 };
                books.set(key, entry);
                loads.push(refresh(entry));
            } else if (refreshCached) {
                loads.push(refresh(entry));
            }
        }
        return Promise.all(loads);
    }

    function replacePluginList(body) {
        if (!Array.isArray(body?.lorebooks) || !body.lorebooks.every(validIdentity)) {
            return false;
        }
        pluginBooks = referenceMap(body.lorebooks);
        return true;
    }

    function notificationIdentity(sender, body) {
        if (!sender || !validString(sender.connectionId) || isSelf(sender)) {
            return;
        }
        const identity = { accountId: sender.accountId, filename: body?.filename };
        if (validIdentity(identity) && books.has(identityKey(identity))) {
            return identity;
        }
    }

    function removeBook(identity) {
        const key = identityKey(identity);
        pluginBooks.delete(key);
        discoveredBooks.delete(key);
        books.delete(key);
        retainedContents.delete(key);
        withdrawnDiscovery.add(key);
        if (identity.accountId === accountId) {
            withdrawnSelections.add(identity.filename);
            if (selections) { selections = withoutBook(selections, identity.filename); }
        }
    }

    function resolveIdentity(query) {
        if (validIdentity(query)) {
            return books.get(identityKey(query))?.identity;
        }
        if (!validString(query)) {
            return;
        }
        const matches = [...books.values()].filter(entry => entry.identity.filename === `${query}.json`);
        if (matches.length > 1) {
            throw new Error(`Ambiguous shared lorebook name: ${query}. Use an account-qualified identity.`);
        }
        return matches[0]?.identity;
    }

    function reset() {
        epoch++;
        chat = null;
        connected = false;
        isOwner = false;
        ownerPresent = false;
        hasJoined = false;
        selections = null;
        pluginBooks.clear();
        discoveredBooks.clear();
        books.clear();
        retainedContents.clear();
        withdrawnSelections.clear();
        withdrawnDiscovery.clear();
    }

    return {
        /**
         * Begins a new chat scope, discarding previous selections, availability and pending read results.
         * @param {{accountId: string, groupId: string, chatId: string}} identity Owning account and native chat IDs.
         * @returns {void}
         */
        open(identity) {
            reset();
            chat = structuredClone(identity);
        },

        /**
         * Applies a successful join or rejoin, publishes loaded selections and refreshes retained books on rejoin.
         * @param {{isOwner: boolean, ownerPresent: boolean, lorebooks: object[]}} result Plugin join result.
         * @returns {Promise<void>} Completion of publication and HTTP loads; failures are reported through onError.
         */
        async joined(result) {
            if (!chat || typeof result?.isOwner !== 'boolean' || typeof result?.ownerPresent !== 'boolean') {
                return;
            }
            connected = true;
            isOwner = result.isOwner;
            ownerPresent = result.ownerPresent;
            replacePluginList(result);
            const refreshCached = hasJoined;
            hasJoined = true;
            await Promise.all([reconcile(refreshCached), publishContribution()]);
        },

        /**
         * Applies owner status; gaining authority publishes the owner union once selections are loaded.
         * @param {{isOwner: boolean, ownerPresent: boolean}} body Plugin status payload.
         * @returns {Promise<void>} Contribution publication completion, when the selected role changes.
         */
        async status(body) {
            if (!chat || typeof body?.isOwner !== 'boolean' || typeof body?.ownerPresent !== 'boolean') {
                return;
            }
            const changedRole = isOwner !== body.isOwner;
            isOwner = body.isOwner;
            ownerPresent = body.ownerPresent;
            if (changedRole) {
                await publishContribution();
            }
        },

        /** @returns {void} Retains availability and cached contents while suspending bus publications. */
        disconnected() {
            connected = false;
            isOwner = false;
            ownerPresent = false;
        },

        /**
         * Replaces locally loaded associations and publishes the current browser's contribution when joined.
         * All book strings are native names without the filename extension; disabled characters are included.
         * @param {{globalBooks?: string[], chatBook?: string, personaBook?: string, characters?: object[]}|null} snapshot
         * Characters contain primaryBook and additionalBooks; null means selections are not yet loaded.
         * @returns {Promise<void>} Contribution publication completion.
         */
        async setSelections(snapshot) {
            if (!chat) {
                return;
            }
            selections = snapshot ? structuredClone(snapshot) : null;
            if (selections) {
                const filenames = new Set(selectionNames(selections, true).filter(validString).map(name => `${name}.json`));
                for (const filename of withdrawnSelections) {
                    if (!filenames.has(filename)) {
                        withdrawnSelections.delete(filename);
                    } else {
                        selections = withoutBook(selections, filename);
                    }
                }
            }
            await publishContribution();
        },

        /**
         * Replaces owner-qualified primary-character and chat-linked discovery from already-loaded resources.
         * @param {{characters?: object[], chatMetadata?: object}} snapshot Native cards and transcript chat_metadata.
         * @returns {Promise<void>} Completion of newly needed HTTP reads.
         */
        async setDiscovery(snapshot) {
            if (!chat) {
                return;
            }
            const names = [
                ...(snapshot?.characters ?? []).map(character => character?.data?.extensions?.world),
                snapshot?.chatMetadata?.world_info,
            ].filter(validString);
            discoveredBooks = referenceMap(names.map(name => ({ accountId: chat.accountId, filename: `${name}.json` })));
            for (const key of withdrawnDiscovery) {
                if (!discoveredBooks.has(key)) {
                    withdrawnDiscovery.delete(key);
                } else {
                    discoveredBooks.delete(key);
                }
            }
            await reconcile();
        },

        /**
         * Atomically replaces the Plugin list; malformed lists leave all existing state unchanged.
         * @param {{lorebooks: {accountId: string, filename: string}[]}} body Combined-list notification body.
         * @returns {Promise<void>} Completion of newly needed HTTP reads.
         */
        async receiveList(body) {
            if (!chat || !replacePluginList(body)) {
                return;
            }
            await reconcile();
        },

        /**
         * Refreshes a shared book saved by another connection, using the authenticated sender's source account.
         * @param {{accountId: string, connectionId: string}} sender Bus-supplied sender.
         * @param {{filename: string}} body Native filename including .json.
         * @returns {Promise<void>} Refresh completion; failed refreshes retain cached contents.
         */
        async saved(sender, body) {
            const identity = notificationIdentity(sender, body);
            if (identity) {
                await refresh(books.get(identityKey(identity)));
            }
        },

        /**
         * Removes another connection's deleted book from both availability sources and the cache.
         * Source-account browsers also withdraw it from every local association and republish.
         * @param {{accountId: string, connectionId: string}} sender Bus-supplied sender.
         * @param {{filename: string}} body Native filename including .json.
         * @returns {Promise<void>} Contribution withdrawal completion, if applicable.
         */
        async deleted(sender, body) {
            const identity = notificationIdentity(sender, body);
            if (!identity) {
                return;
            }
            removeBook(identity);
            if (identity.accountId === accountId) {
                await publishContribution();
            }
        },

        /**
         * Announces a successfully persisted local shared-book save. Never call for uncertain or failed saves.
         * @param {string} filename Native filename including .json, in the authenticated local account.
         * @returns {Promise<void>} Notification publication completion.
         */
        async confirmSaved(filename) {
            if (validFilename(filename) && books.has(identityKey({ accountId, filename }))) {
                await publish('multiplayer.lorebook.saved', { filename });
            }
        },

        /**
         * Cleans up and announces a confirmed successful local deletion, then withdraws its contribution.
         * Never call for uncertain or failed deletions.
         * @param {string} filename Native filename including .json, in the authenticated local account.
         * @returns {Promise<void>} Notification and contribution publication completion.
         */
        async confirmDeleted(filename) {
            const identity = { accountId, filename };
            if (!validFilename(filename) || !books.has(identityKey(identity))) {
                return;
            }
            removeBook(identity);
            await Promise.all([
                publish('multiplayer.lorebook.deleted', { filename }),
                publishContribution(),
            ]);
        },

        /**
         * Resolves advertised identity independently of cache success, so failed loads cannot fall back locally.
         * @param {string|{accountId: string, filename: string}} query Native book name or qualified filename identity.
         * @returns {{accountId: string, filename: string}|undefined} Detached identity, or undefined for local fallback.
         * @throws {Error} A name matches shared books in multiple accounts.
         */
        resolve(query) {
            const identity = resolveIdentity(query);
            return identity ? { ...identity } : undefined;
        },

        /**
         * Reads complete cached contents, awaiting an initial load but retaining old contents during refreshes.
         * @param {string|{accountId: string, filename: string}} query Native book name or qualified filename identity.
         * @returns {Promise<object|undefined>} Detached contents, or undefined when the book is no longer shared.
         * @throws {Error} Ambiguous name or a shared book with no successfully loaded contents.
         */
        async read(query) {
            const identity = resolveIdentity(query);
            if (!identity) {
                return;
            }
            const entry = books.get(identityKey(identity));
            while (current(entry) && entry.contents === undefined && entry.pending) {
                await entry.pending;
            }
            if (!current(entry)) {
                return;
            }
            if (entry.contents === undefined) {
                throw entry.error ?? new Error(`Shared lorebook unavailable: ${identity.accountId}/${identity.filename}`);
            }
            return structuredClone(entry.contents);
        },

        /**
         * Returns detached lifecycle, contribution and combined-availability state without exposing cache internals.
         * @returns {{chat: object|null, connected: boolean, isOwner: boolean, ownerPresent: boolean, contribution: string[], lorebooks: object[]}}
         */
        getState() {
            return structuredClone({
                chat, connected, isOwner, ownerPresent,
                contribution: contribution(),
                lorebooks: [...books.values()].map(entry => entry.identity),
            });
        },

        /**
         * @param {object} [options] Snapshot filtering.
         * @param {boolean} [options.successfulOnly=false] Exclude pending, failed and unavailable refreshes.
         * @returns {object[]} Detached native-read snapshots, with undefined data for unavailable books by default.
         */
        getBooks({ successfulOnly = false } = {}) {
            return [...books.values()]
                .filter(entry => !successfulOnly || (!entry.error && !entry.pending && entry.contents !== undefined))
                .map(entry => ({ ...entry.identity, data: structuredClone(entry.contents) }));
        },

        /** @returns {void} Clears the current chat, associations and cache; integration owns leaving the browser bus. */
        leave() {
            reset();
        },
    };
}

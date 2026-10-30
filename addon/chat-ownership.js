const pluginRoot = '/api/plugins/multiplayer';

function groupPath(accountId, groupId) {
    return `/chats/${encodeURIComponent(accountId)}/groups/${encodeURIComponent(groupId)}`;
}

function groupKey(accountId, groupId) {
    return JSON.stringify([accountId, String(groupId)]);
}

/**
 * Creates the browser-side ownership resource and creation service.
 * @param {object} options Native account, settings, persistence and HTTP dependencies.
 * @param {{id: string, name: string, avatar: string|null}} options.account Current account.
 * @param {object} options.extensionSettings Native extension settings, mutated in place.
 * @param {Function} options.saveSettings Native settings-saving function.
 * @param {Function} options.fetch Browser fetch implementation.
 * @param {Function} options.getRequestHeaders Native request headers including CSRF.
 * @param {Function} options.reportError Displays a load or save error.
 * @returns {object} Ownership operations; failed requests reject rather than returning empty resources.
 */
export function createChatOwnership({ account, extensionSettings, saveSettings, fetch, getRequestHeaders, reportError }) {
    let pendingGroup;

    async function request(path, options) {
        try {
            const response = await fetch(path, options);
            if (!response.ok) {
                throw new Error(`Multiplayer request failed (${response.status}): ${path}`);
            }
            return await response.json();
        } catch (error) {
            reportError(error);
            throw error;
        }
    }

    function get(path) {
        return request(`${pluginRoot}${path}`, { method: 'GET' });
    }

    function post(path, body) {
        return request(path, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });
    }

    function characterImage(accountId, filename) {
        return `${pluginRoot}/accounts/${encodeURIComponent(accountId)}/characters/${encodeURIComponent(filename)}`;
    }

    return {
        account,

        /** @returns {Promise<object[]>} Eligible account cards, excluding the creator. */
        async listAccounts() {
            const accounts = await get('/accounts');
            return accounts.filter(candidate => candidate.id !== account.id);
        },

        /** @returns {boolean} Whether this account allows future group invitations. */
        isDiscoverable() {
            return extensionSettings.multiplayer?.allowGroupInvites !== false;
        },

        /**
         * Saves discoverability without refreshing account choices or changing memberships.
         * @param {boolean} value Whether future invitations are allowed.
         * @returns {Promise<void>} Completion of the native settings-saving call.
         */
        async setDiscoverable(value) {
            extensionSettings.multiplayer ??= {};
            extensionSettings.multiplayer.allowGroupInvites = value;
            await saveSettings();
        },

        /**
         * Creates a native group, then persists its ownership before reporting success.
         * A failed second save is retried against the same returned group on the next call.
         * @param {object} model Native creation model with at least one character member.
         * @param {string[]} [accounts] Selected guest handles from the displayed choices.
         * @returns {Promise<object>} Complete saved native group record.
         */
        async createGroup(model, accounts = []) {
            if (!pendingGroup) {
                if (!Array.isArray(model.members) || model.members.length === 0) {
                    throw new Error('Select at least one Character card.');
                }
                const created = await post('/api/groups/create', model);
                pendingGroup = {
                    ...created,
                    multiplayer: { ...created.multiplayer, owner: account.id, accounts: [...accounts] },
                };
            }
            await post('/api/groups/edit', pendingGroup);
            const saved = pendingGroup;
            pendingGroup = undefined;
            return saved;
        },

        /**
         * Merges discovery with local groups using source-account-qualified identities.
         * @param {object[]} nativeGroups Groups already present in the native listing.
         * @returns {Promise<object[]>} Owner/group envelopes in listing order.
         */
        async mergeGroups(nativeGroups) {
            const shared = await get('/chats');
            const merged = new Map(nativeGroups.map(group => [groupKey(account.id, group.id), { owner: account, group }]));
            for (const entry of shared) {
                const key = groupKey(entry.owner.id, entry.group.id);
                if (!merged.has(key)) {
                    merged.set(key, entry);
                }
            }
            return [...merged.values()];
        },

        /**
         * Reads a shared group's authoritative native record.
         * @param {string} accountId Owning account handle.
         * @param {string} groupId Native group ID.
         * @returns {Promise<object>} Owner/group envelope.
         */
        loadGroup(accountId, groupId) {
            return get(groupPath(accountId, groupId));
        },

        /**
         * Reads native summaries for the group's stored chat IDs.
         * @param {string} accountId Owning account handle.
         * @param {string} groupId Native group ID.
         * @returns {Promise<object[]>} Native chat summaries.
         */
        listChats(accountId, groupId) {
            return get(`${groupPath(accountId, groupId)}/chats`);
        },

        /**
         * Reads a saved transcript without initializing or saving empty chats.
         * @param {string} accountId Owning account handle.
         * @param {string} groupId Native group ID.
         * @param {string} chatId Native chat ID without .jsonl.
         * @returns {Promise<{metadata: object, messages: object[]}>} Metadata and unchanged messages.
         */
        async loadChat(accountId, groupId, chatId) {
            const transcript = await get(`${groupPath(accountId, groupId)}/chats/${encodeURIComponent(chatId)}`);
            const hasHeader = transcript.length > 0 && Object.hasOwn(transcript[0], 'chat_metadata');
            return {
                metadata: hasHeader ? transcript[0].chat_metadata : {},
                messages: hasHeader ? transcript.slice(1) : transcript,
            };
        },

        /**
         * Reads owner-sourced cards, retaining filenames and source identity.
         * @param {string} accountId Owning account handle.
         * @param {string[]} members Native character filenames.
         * @returns {Promise<object[]>} Cards with source identity and portrait URLs.
         */
        async loadCharacters(accountId, members) {
            return Promise.all(members.map(async filename => {
                const imageUrl = characterImage(accountId, filename);
                const card = await request(`${imageUrl}/card`, { method: 'GET' });
                return { ...card, avatar: filename, multiplayer: { accountId, filename }, imageUrl };
            }));
        },

        /**
         * Resolves a character portrait against its source account.
         * @param {string} accountId Owning account handle.
         * @param {string} filename Native character filename.
         * @returns {string} Plugin image URL.
         */
        characterImage,
    };
}

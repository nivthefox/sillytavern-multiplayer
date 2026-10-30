import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

function failure(status) {
    return Object.assign(new Error('Resource request failed'), { status });
}

function validateIdentifier(value) {
    if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\\0]/u.test(value)) {
        throw failure(403);
    }
}

async function resourcePath(directory, filename) {
    validateIdentifier(filename);
    let root;
    let path;
    try {
        root = await realpath(directory);
        path = await realpath(join(root, filename));
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw failure(404);
        }
        throw error;
    }
    const location = relative(root, path);
    if (location === '..' || location.startsWith('../') || isAbsolute(location)) {
        throw failure(403);
    }
    return path;
}

async function readResource(directory, filename) {
    try {
        return await readFile(await resourcePath(directory, filename));
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw failure(404);
        }
        throw error;
    }
}

function parseObject(text) {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw failure(500);
    }
    return value;
}

async function readObject(directory, filename) {
    return parseObject(await readResource(directory, filename));
}

function participates(accountID, group, requester) {
    return accountID === requester || group.multiplayer?.accounts?.includes(requester) === true;
}

function groupRecord(account, group) {
    return { owner: { id: account.handle, name: account.name }, group };
}

function parseTranscript(buffer) {
    if (buffer.length === 0) {
        return [];
    }
    const lines = buffer.toString('utf8').split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }
    return lines.map(parseObject);
}

/** Read-only native resources with source-account-qualified authorization. */
export class Resources {
    #host;

    /**
     * @param {object} host Native account, directory, card-parser, and size-formatting operations.
     */
    constructor(host) {
        this.#host = host;
    }

    async #accounts() {
        const accounts = await this.#host.listAccounts();
        if (!Array.isArray(accounts)) {
            throw failure(500);
        }
        return accounts;
    }

    async #account(accountID) {
        validateIdentifier(accountID);
        const account = (await this.#accounts()).find(account => account.handle === accountID);
        if (!account) {
            throw failure(404);
        }
        return account;
    }

    #directories(accountID) {
        validateIdentifier(accountID);
        return this.#host.getDirectories(accountID);
    }

    async #groups(account) {
        const directory = this.#directories(account.handle).groups;
        try {
            const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
            return await Promise.all(names.map(name => this.#readGroupFile(directory, name)));
        } catch {
            throw failure(500);
        }
    }

    async #readGroupFile(directory, filename) {
        const group = await readObject(directory, filename);
        if (!Array.isArray(group.members) || !Array.isArray(group.chats) ||
            (group.multiplayer?.accounts !== undefined && !Array.isArray(group.multiplayer.accounts))) {
            throw failure(500);
        }
        return group;
    }

    async #settings(account) {
        try {
            return await readObject(this.#directories(account.handle).root, 'settings.json');
        } catch (error) {
            if (error.status === 404) {
                return {};
            }
            throw failure(500);
        }
    }

    async #authorizeCharacter(requester, accountID, characterID) {
        validateIdentifier(accountID);
        validateIdentifier(characterID);
        const account = (await this.#accounts()).find(account => account.handle === accountID);
        if (!account) {
            throw failure(403);
        }
        const groups = await this.#groups(account);
        if (!groups.some(group => participates(accountID, group, requester) && group.members.includes(characterID))) {
            throw failure(403);
        }
    }

    async #authorizeShared(requester, accountID) {
        validateIdentifier(accountID);
        for (const account of await this.#accounts()) {
            for (const group of await this.#groups(account)) {
                if (participates(account.handle, group, requester) && participates(account.handle, group, accountID)) {
                    return;
                }
            }
        }
        throw failure(403);
    }

    async #authorizedGroup(requester, accountID, groupID) {
        validateIdentifier(accountID);
        validateIdentifier(groupID);
        let account;
        let group;
        try {
            account = await this.#account(accountID);
            group = await this.#readGroupFile(this.#directories(accountID).groups, `${groupID}.json`);
        } catch (error) {
            if (requester !== accountID && (error.status === 404 || error.code === 'ENOENT')) {
                throw failure(403);
            }
            throw error;
        }
        if (!participates(accountID, group, requester)) {
            throw failure(403);
        }
        return groupRecord(account, group);
    }

    async #chatFile(accountID, chatID) {
        validateIdentifier(chatID);
        const path = await resourcePath(this.#directories(accountID).groupChats, `${chatID}.jsonl`);
        try {
            const [buffer, stats] = await Promise.all([readFile(path), stat(path)]);
            return { records: parseTranscript(buffer), stats };
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw failure(404);
            }
            throw error;
        }
    }

    #summary(chatID, { records, stats }) {
        const summary = {
            file_id: chatID,
            file_name: `${chatID}.jsonl`,
            file_size: this.#host.formatBytes(stats.size),
            chat_items: 0,
            mes: '[The chat is empty]',
            last_mes: stats.mtimeMs,
            match: false,
        };
        if (records.length === 0) {
            return summary;
        }
        const last = records.at(-1);
        if (!last.name && !last.character_name && !last.chat_metadata) {
            throw failure(500);
        }
        return {
            ...summary,
            chat_items: records.length - 1,
            mes: last.mes || '[The message is empty]',
            last_mes: last.send_date || new Date(Math.round(stats.mtimeMs)).toISOString(),
            match: true,
        };
    }

    /** @returns {Promise<object[]>} Enabled, discoverable accounts with only id, name, and avatar. */
    async accounts() {
        const records = [];
        for (const account of await this.#accounts()) {
            if (!account.enabled) {
                continue;
            }
            const settings = await this.#settings(account);
            if (settings.extension_settings?.multiplayer?.allowGroupInvites === false) {
                continue;
            }
            records.push({ id: account.handle, name: account.name, avatar: await this.#host.getAvatar(account.handle) });
        }
        return records;
    }

    /**
     * @param {string} requester Native authenticated account handle.
     * @param {string} [accountID] Restrict discovery to this source account.
     * @returns {Promise<object[]>} Accessible owner/group records, including owned native groups.
     */
    async groups(requester, accountID) {
        if (accountID !== undefined) {
            validateIdentifier(accountID);
        }
        const records = [];
        for (const account of await this.#accounts()) {
            if (accountID !== undefined && account.handle !== accountID) {
                continue;
            }
            for (const group of await this.#groups(account)) {
                if (participates(account.handle, group, requester)) {
                    records.push(groupRecord(account, group));
                }
            }
        }
        return records;
    }

    /**
     * @param {string} requester Authenticated handle.
     * @param {string} accountID Storage owner handle.
     * @param {string} groupID Native group ID.
     * @returns {Promise<object>} Authorized owner/group record.
     */
    async group(requester, accountID, groupID) {
        return this.#authorizedGroup(requester, accountID, groupID);
    }

    /**
     * Authorize a live chat association without loading or parsing its saved messages.
     * @param {string} requester Authenticated account handle.
     * @param {{accountId: string, groupId: string, chatId: string}} chat Source-qualified chat identity.
     * @returns {Promise<void>} Resolves when membership and the referenced file are established.
     */
    async authorizeChat(requester, { accountId, groupId, chatId }) {
        validateIdentifier(chatId);
        const { group } = await this.#authorizedGroup(requester, accountId, groupId);
        if (!group.chats.includes(chatId)) {
            throw failure(403);
        }
        const path = await resourcePath(this.#directories(accountId).groupChats, `${chatId}.jsonl`);
        if (!(await stat(path)).isFile()) {
            throw failure(500);
        }
    }

    /**
     * @param {string} requester Authenticated handle.
     * @param {string} accountID Storage owner handle.
     * @param {string} groupID Native group ID.
     * @returns {Promise<object[]>} Native chat summaries in the group's stored order.
     */
    async summaries(requester, accountID, groupID) {
        const { group } = await this.#authorizedGroup(requester, accountID, groupID);
        const summaries = [];
        for (const chatID of group.chats) {
            summaries.push(this.#summary(chatID, await this.#chatFile(accountID, chatID)));
        }
        return summaries;
    }

    /**
     * @param {string} requester Authenticated handle.
     * @param {string} accountID Storage owner handle.
     * @param {string} groupID Native group ID.
     * @param {string} chatID Native chat ID without extension.
     * @returns {Promise<object[]>} Complete saved JSONL records, including the metadata header.
     */
    async transcript(requester, accountID, groupID, chatID) {
        validateIdentifier(chatID);
        const { group } = await this.#authorizedGroup(requester, accountID, groupID);
        if (!group.chats.includes(chatID)) {
            throw failure(403);
        }
        return (await this.#chatFile(accountID, chatID)).records;
    }

    /**
     * @param {string} requester Authenticated handle.
     * @param {string} accountID Character's source handle.
     * @param {string} characterID Native PNG filename.
     * @returns {Promise<object>} Unmodified embedded native card JSON.
     */
    async card(requester, accountID, characterID) {
        const image = await this.character(requester, accountID, characterID);
        return parseObject(await this.#host.readCard(image));
    }

    /**
     * @param {string} requester Authenticated handle.
     * @param {string} accountID Character's source handle.
     * @param {string} characterID Native PNG filename.
     * @returns {Promise<Buffer>} Original PNG including embedded metadata.
     */
    async character(requester, accountID, characterID) {
        await this.#authorizeCharacter(requester, accountID, characterID);
        return readResource(this.#directories(accountID).characters, characterID);
    }

    /**
     * @param {string} requester Authenticated handle.
     * @param {string} accountID Persona's source handle.
     * @param {string} filename Native persona-image filename.
     * @returns {Promise<Buffer>} Original image bytes, independent of the active persona.
     */
    async persona(requester, accountID, filename) {
        validateIdentifier(filename);
        await this.#authorizeShared(requester, accountID);
        await this.#account(accountID);
        return readResource(this.#directories(accountID).avatars, filename);
    }

    /**
     * @param {string} requester Authenticated handle.
     * @param {string} accountID Lorebook's source handle.
     * @param {string} filename Native lorebook filename including .json.
     * @returns {Promise<object>} Complete saved book without filtering entries.
     */
    async lore(requester, accountID, filename) {
        validateIdentifier(filename);
        await this.#authorizeShared(requester, accountID);
        await this.#account(accountID);
        return readObject(this.#directories(accountID).worlds, filename);
    }
}

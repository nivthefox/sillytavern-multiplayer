import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Loads native SillyTavern services and its shared account storage.
 * @param {string} [root=process.cwd()] SillyTavern server root, independent of the plugin location.
 * @returns {Promise<{
 *   listAccounts: () => Promise<object[]>,
 *   getDirectories: (handle: string) => object,
 *   getAvatar: (handle: string) => Promise<string|null>,
 *   readCard: (buffer: Buffer) => string,
 *   formatBytes: (bytes: number) => string
 * }>} Services exposing all account profiles (including disabled accounts), native
 * directories, configured account avatar data URLs or null, card JSON text, and byte formatting.
 */
export async function loadNativeHost(root = process.cwd()) {
    const require = createRequire(pathToFileURL(resolve(root, 'package.json')));
    const storage = require('node-persist');
    const [users, cards, util] = await Promise.all([
        import(pathToFileURL(resolve(root, 'src/users.js')).href),
        import(pathToFileURL(resolve(root, 'src/character-card-parser.js')).href),
        import(pathToFileURL(resolve(root, 'src/util.js')).href),
    ]);

    return {
        async listAccounts() {
            const handles = await users.getAllUserHandles();
            return Promise.all(handles.map(handle => storage.getItem(users.toKey(handle))));
        },
        getDirectories: users.getUserDirectories,
        async getAvatar(handle) {
            return await storage.getItem(users.toAvatarKey(handle)) || null;
        },
        readCard: cards.read,
        formatBytes: util.formatBytes,
    };
}

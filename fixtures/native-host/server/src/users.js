import storage from 'node-persist';

/** @returns {Promise<string[]>} Account handles seeded by the test. */
export async function getAllUserHandles() {
    return storage.getItem('handles');
}

/**
 * @param {string} handle Account handle.
 * @returns {string} Account storage key.
 */
export function toKey(handle) {
    return `user:${handle}`;
}

/**
 * @param {string} handle Account handle.
 * @returns {string} Avatar storage key.
 */
export function toAvatarKey(handle) {
    return `avatar:${handle}`;
}

/**
 * @param {string} handle Account handle.
 * @returns {object} Fixture account directories.
 */
export function getUserDirectories(handle) {
    return { root: `/native/${handle}` };
}

export const info = {
    id: 'multiplayer',
    name: 'SillyTavern Multiplayer',
    description: 'Multiplayer server plugin scaffold; functionality is not implemented.',
};

/**
 * SillyTavern plugin initialization hook. No routes are registered yet.
 * @param {object} router The router supplied by SillyTavern.
 * @returns {Promise<void>}
 */
export async function init(router) {}

/**
 * SillyTavern shutdown hook. The scaffold owns no resources yet.
 * @returns {Promise<void>}
 */
export async function exit() {}

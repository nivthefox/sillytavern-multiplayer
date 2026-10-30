import { registerHttpRoutes } from './http.js';

export const info = {
    id: 'multiplayer',
    name: 'SillyTavern Multiplayer',
    description: 'Authorized multiplayer resource HTTP routes for SillyTavern.',
};

/**
 * Register HTTP routes on the router supplied by SillyTavern.
 * @param {object} router Native Express router behind session and CSRF middleware.
 * @param {object} [options] HTTP integration dependencies.
 * @param {object} [options.host] Native account, directory, avatar, card-reader, and size helpers.
 * @param {function(object): Promise<object>} [options.issueTicket] Bus-owned ticket issuer receiving
 * the original authenticated request and returning {ticket, expiresAt}.
 * @returns {Promise<void>}
 */
export async function init(router, options) {
    router.get('/status', (_request, response) => response.json({ plugin: info.id }));
    registerHttpRoutes(router, options);
}

/**
 * SillyTavern shutdown hook. HTTP routes own no persistent connections or timers.
 * @returns {Promise<void>}
 */
export async function exit() {}

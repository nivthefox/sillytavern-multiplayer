import { createEventBus } from './event-bus.js';
import { createEventTransport } from './event-transport.js';
import { registerHttpRoutes } from './http.js';
import { loadNativeHost } from './native-host.js';
import { Resources } from './resources.js';

export const info = {
    id: 'multiplayer',
    name: 'SillyTavern Multiplayer',
    description: 'Authorized multiplayer resources and live event routing for SillyTavern.',
};

let runtime;

/**
 * Register resources and the live event bus behind native session and CSRF middleware.
 * @param {object} router Native Express router supplied by SillyTavern.
 * @param {object} [options] Integration dependencies.
 * @param {object} [options.host] Native account and storage helpers.
 * @param {function(object): Promise<object>} [options.issueTicket] Override ticket issuance for integration tests.
 * @returns {Promise<void>}
 */
export async function init(router, { host, issueTicket } = {}) {
    await exit();
    let resources;
    const bus = createEventBus({
        async authorizeJoin(accountId, chat) {
            resources ??= new Resources(host ?? await loadNativeHost());
            await resources.authorizeChat(accountId, chat);
        },
    });
    const transport = createEventTransport({ bus });
    runtime = { bus, transport };
    router.get('/status', (_request, response) => response.json({ plugin: info.id }));
    registerHttpRoutes(router, { host, issueTicket: issueTicket ?? transport.issueTicket });
}

/**
 * Register a server-side event listener on the running plugin bus.
 * @param {string} eventName Namespaced event name.
 * @param {function(object, object|null, *): *} handler Receives independent chat, sender, and body copies.
 * @returns {function(): void} Removes only this registration.
 */
export function on(eventName, handler) {
    if (!runtime) {
        throw new Error('Multiplayer plugin is not initialized');
    }
    return runtime.bus.on(eventName, handler);
}

/**
 * Route a server-originated event with a null sender in an explicit chat context.
 * @param {{accountId: string, groupId: string, chatId: string}} chat Source-qualified chat identity.
 * @param {string} destination Owner, all, server, or a connection ID.
 * @param {string} eventName Namespaced event name.
 * @param {*} body JSON event body.
 * @returns {Promise<void>} Resolves on routing acceptance, not handler completion.
 */
export async function send(chat, destination, eventName, body) {
    if (!runtime) {
        throw new Error('Multiplayer plugin is not initialized');
    }
    await runtime.bus.send(chat, destination, eventName, body);
}

/**
 * Remove upgrade listeners and release live connections, tickets, handlers, and chat state.
 * @returns {Promise<void>}
 */
export async function exit() {
    const previous = runtime;
    runtime = undefined;
    if (!previous) {
        return;
    }
    await previous.transport.close();
    previous.bus.close();
}

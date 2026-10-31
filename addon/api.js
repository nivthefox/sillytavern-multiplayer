import { initializeConversations } from './conversation-bootstrap.js';
import { initializeOwnership } from './ownership-bootstrap.js';

/**
 * Returns multiplayer's shared browser event bus after addon initialization.
 * Reuses the same connection and chat lifecycle as conversations and lorebooks.
 * Consumers should use on, send and sessionStatus; multiplayer manages connect, join and leave.
 * Initialization failures reject the returned promise. Readiness does not guarantee a joined chat.
 * @returns {Promise<import('./event-bus.js').BrowserEventBus>} The existing multiplayer bus.
 */
export async function getEventBus() {
    await initializeOwnership();
    const integration = await initializeConversations();
    return integration.bus;
}

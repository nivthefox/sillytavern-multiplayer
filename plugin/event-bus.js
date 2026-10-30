import { randomUUID } from 'node:crypto';

const lifecycleEvents = new Set(['bus.connected', 'bus.disconnected', 'bus.status']);
const serverEvents = new Set(['multiplayer.owner.changed', 'multiplayer.lorebooks.changed']);
const errorMessages = {
    invalid_request: 'Invalid event-bus request.',
    forbidden: 'Access to this chat is forbidden.',
    not_found: 'The requested resource was not found.',
    not_joined: 'No chat is joined.',
    owner_unavailable: 'The session owner is unavailable.',
    connection_unavailable: 'The connection is unavailable in this chat.',
    internal_error: 'The server could not complete the request.',
};

function busError(code) {
    return Object.assign(new Error(errorMessages[code]), { code });
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value) {
    return typeof value === 'string' && value.length > 0;
}

function identityOf(value) {
    if (!isObject(value) || !['accountId', 'groupId', 'chatId'].every(key => isString(value[key]))) {
        throw busError('invalid_request');
    }
    return { accountId: value.accountId, groupId: value.groupId, chatId: value.chatId };
}

function chatKey(identity) {
    return JSON.stringify([identity.accountId, identity.groupId, identity.chatId]);
}

function validateEvent(destination, eventName, clientOrigin) {
    if (!isString(destination) || typeof eventName !== 'string' || !/^[^.\s]+\.[^\s.]+(?:\.[^\s.]+)*$/u.test(eventName)) {
        throw busError('invalid_request');
    }
    if (lifecycleEvents.has(eventName) || (clientOrigin && serverEvents.has(eventName))) {
        throw busError('invalid_request');
    }
}

function combinedBooks(room) {
    return [...room.contributions].flatMap(([accountId, filenames]) => filenames.map(filename => ({ accountId, filename })));
}

function bookKey(room) {
    return JSON.stringify(combinedBooks(room).map(book => JSON.stringify([book.accountId, book.filename])).sort());
}

/**
 * Creates the in-memory chat router independently of WebSocket transport.
 * @param {object} options Dependencies for authorization and local error reporting.
 * @param {(accountId: string, chat: object) => Promise<void>} options.authorizeJoin Checks access, throwing errors with an HTTP status on failure.
 * @param {{error: Function}} [options.logger=console] Receives isolated handler and delivery failures.
 * @returns {{connect: Function, on: Function, send: Function, close: Function}} The event bus.
 */
export function createEventBus({ authorizeJoin, logger = console }) {
    const connections = new Map();
    const rooms = new Map();
    const handlers = new Map();
    let nextAge = 0;
    let closed = false;

    function log(error) {
        try {
            logger.error(error);
        } catch {
            return;
        }
    }

    function invoke(callback, ...args) {
        try {
            Promise.resolve(callback(...args)).catch(log);
        } catch (error) {
            log(error);
        }
    }

    function deliver(connection, envelope) {
        if (!connection.active) {
            return;
        }
        invoke(connection.deliver, structuredClone(envelope));
    }

    function broadcast(room, eventName, body) {
        const envelope = { op: 'event', chat: room.identity, eventName, sender: null, body };
        for (const connection of [...room.clients]) {
            deliver(connection, envelope);
        }
    }

    function updateStatus(room) {
        for (const connection of [...room.clients]) {
            const isOwner = room.owner === connection;
            const ownerPresent = room.owner !== null;
            if (connection.status?.isOwner === isOwner && connection.status?.ownerPresent === ownerPresent) {
                continue;
            }
            connection.status = { isOwner, ownerPresent };
            deliver(connection, { op: 'status', chat: room.identity, isOwner, ownerPresent });
        }
    }

    function detach(connection) {
        const room = connection.room;
        if (!room) {
            return;
        }
        connection.room = null;
        connection.status = null;
        room.clients.delete(connection);
        const wasOwner = room.owner === connection;
        if (wasOwner) {
            room.owner = [...room.clients]
                .filter(client => client.accountId === room.identity.accountId)
                .sort((a, b) => a.age - b.age)[0] ?? null;
        }
        if (room.clients.size === 0) {
            rooms.delete(chatKey(room.identity));
            return;
        }
        const before = bookKey(room);
        if (![...room.clients].some(client => client.accountId === connection.accountId)) {
            room.contributions.delete(connection.accountId);
        }
        updateStatus(room);
        if (wasOwner) {
            broadcast(room, 'multiplayer.owner.changed', {});
        }
        if (before !== bookKey(room)) {
            broadcast(room, 'multiplayer.lorebooks.changed', { lorebooks: combinedBooks(room) });
        }
    }

    async function join(connection, identity) {
        try {
            await authorizeJoin(connection.accountId, structuredClone(identity));
        } catch (error) {
            const code = { 403: 'forbidden', 404: 'not_found' }[error?.status] ?? 'internal_error';
            if (code === 'internal_error') {
                log(error);
            }
            throw busError(code);
        }
        if (!connection.active || closed) {
            throw busError('connection_unavailable');
        }
        const key = chatKey(identity);
        if (connection.room && chatKey(connection.room.identity) === key) {
            return joinData(connection);
        }
        detach(connection);
        if (!connection.active || closed) {
            throw busError('connection_unavailable');
        }
        let room = rooms.get(key);
        if (!room) {
            room = { identity, clients: new Set(), owner: null, contributions: new Map() };
            rooms.set(key, room);
        }
        connection.room = room;
        room.clients.add(connection);
        if (!room.owner && connection.accountId === identity.accountId) {
            room.owner = connection;
        }
        updateStatus(room);
        return joinData(connection);
    }

    function joinData(connection) {
        return {
            isOwner: connection.room.owner === connection,
            ownerPresent: connection.room.owner !== null,
            lorebooks: combinedBooks(connection.room),
        };
    }

    function contribute(room, connection, body) {
        if (connection.accountId === room.identity.accountId && room.owner !== connection) {
            return;
        }
        if (!isObject(body) || !Array.isArray(body.lorebooks) || !body.lorebooks.every(filename => isString(filename) && filename.endsWith('.json'))) {
            return;
        }
        const before = bookKey(room);
        const filenames = [...new Set(body.lorebooks)];
        if (filenames.length === 0) {
            room.contributions.delete(connection.accountId);
        } else {
            room.contributions.set(connection.accountId, filenames);
        }
        if (before !== bookKey(room)) {
            broadcast(room, 'multiplayer.lorebooks.changed', { lorebooks: combinedBooks(room) });
        }
    }

    function route(identity, destination, eventName, body, source = null) {
        validateEvent(destination, eventName, source !== null);
        const room = rooms.get(chatKey(identity));
        let recipients;
        if (destination === 'owner') {
            if (!room?.owner) {
                throw busError('owner_unavailable');
            }
            recipients = [room.owner];
        } else if (destination === 'all' || destination === 'server') {
            if (!room) {
                throw busError('not_joined');
            }
            recipients = destination === 'all' ? [...room.clients] : [];
        } else {
            const target = connections.get(destination);
            if (!target?.active || !room || target.room !== room) {
                throw busError('connection_unavailable');
            }
            recipients = [target];
        }
        const sender = source ? { accountId: source.accountId, connectionId: source.id } : null;
        if (destination === 'server') {
            if (eventName === 'multiplayer.lorebooks.set' && source) {
                contribute(room, source, body);
            }
            for (const registration of [...(handlers.get(eventName) ?? [])]) {
                invoke(registration.handler, structuredClone(identity), structuredClone(sender), structuredClone(body));
            }
            return;
        }
        const envelope = { op: 'event', chat: identity, eventName, sender, body };
        for (const recipient of recipients) {
            deliver(recipient, envelope);
        }
    }

    async function processRequest(connection, raw) {
        if (!connection.active || closed) {
            return;
        }
        let requestId = null;
        try {
            let request;
            try {
                request = JSON.parse(raw);
            } catch {
                throw busError('invalid_request');
            }
            if (!isObject(request)) {
                throw busError('invalid_request');
            }
            requestId = isString(request.requestId) ? request.requestId : null;
            if (requestId === null) {
                throw busError('invalid_request');
            }
            let data = null;
            if (request.op === 'join') {
                data = await join(connection, identityOf(request));
            } else if (request.op === 'leave') {
                detach(connection);
            } else if (request.op === 'send') {
                validateEvent(request.destination, request.eventName, true);
                if (!Object.hasOwn(request, 'body')) {
                    throw busError('invalid_request');
                }
                if (!connection.room) {
                    throw busError('not_joined');
                }
                route(connection.room.identity, request.destination, request.eventName, request.body, connection);
            } else {
                throw busError('invalid_request');
            }
            deliver(connection, { op: 'result', requestId, ok: true, data });
        } catch (error) {
            const code = Object.hasOwn(errorMessages, error?.code) ? error.code : 'internal_error';
            if (code === 'internal_error') {
                log(error);
            }
            deliver(connection, { op: 'result', requestId, ok: false, error: { code, message: errorMessages[code] } });
        }
    }

    return {
        /**
         * Registers an authenticated transport connection, initially without a chat.
         * @param {string} accountId The authenticated account handle.
         * @param {(envelope: object) => void} deliver Receives independent envelope objects.
         * @returns {{id: string, receive: Function, disconnect: Function}} Transport-facing connection.
         */
        connect(accountId, deliver) {
            if (closed) {
                throw busError('connection_unavailable');
            }
            const connection = {
                id: randomUUID(), accountId, deliver, age: nextAge++, active: true,
                room: null, status: null, pending: Promise.resolve(),
            };
            connections.set(connection.id, connection);
            return {
                id: connection.id,
                /**
                 * Processes a JSON request in this connection's arrival order.
                 * @param {string} raw A serialized protocol envelope.
                 * @returns {Promise<void>} Resolves after processing, not after handler completion.
                 */
                receive(raw) {
                    connection.pending = connection.pending.then(() => processRequest(connection, raw));
                    return connection.pending;
                },
                /** Removes the connection and its chat association. */
                disconnect() {
                    connection.active = false;
                    connections.delete(connection.id);
                    detach(connection);
                },
            };
        },
        /**
         * Registers an independent server handler.
         * @param {string} eventName Namespaced event name.
         * @param {(chat: object, sender: object|null, body: *) => *} handler Event consumer.
         * @returns {() => void} Idempotent unsubscription for this registration only.
         */
        on(eventName, handler) {
            const registrations = handlers.get(eventName) ?? new Set();
            handlers.set(eventName, registrations);
            const registration = { handler };
            registrations.add(registration);
            return () => {
                registrations.delete(registration);
                if (registrations.size === 0 && handlers.get(eventName) === registrations) {
                    handlers.delete(eventName);
                }
            };
        },
        /**
         * Routes a server-originated message with a null sender.
         * @param {object} chat Explicit owning account, group and chat identity.
         * @param {string} destination Owner, all, server, or a connection ID.
         * @param {string} eventName Namespaced event name.
         * @param {*} body JSON payload.
         * @returns {Promise<void>} Resolves on routing acceptance; rejects with a protocol code on failure.
         */
        async send(chat, destination, eventName, body) {
            let payload;
            try {
                payload = JSON.parse(JSON.stringify(body));
            } catch {
                throw busError('invalid_request');
            }
            route(identityOf(chat), destination, eventName, payload);
        },
        /** Discards all connections, chat state and handler registrations. */
        close() {
            closed = true;
            for (const connection of connections.values()) {
                connection.active = false;
                connection.room = null;
            }
            connections.clear();
            rooms.clear();
            handlers.clear();
        },
    };
}

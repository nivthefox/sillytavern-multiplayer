import { randomBytes } from 'node:crypto';

import { WebSocket, WebSocketServer } from 'ws';

function rejectUpgrade(socket) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

function connectSocket(socket, accountId, bus, timers, logger, connections) {
    let connection;
    let heartbeat;
    let awaitingPong = false;
    let disconnected = false;

    function disconnect() {
        if (disconnected) {
            return;
        }
        disconnected = true;
        timers.clearInterval(heartbeat);
        connections.delete(socket);
        connection?.disconnect();
    }

    function terminate() {
        disconnect();
        socket.terminate();
    }

    function deliver(envelope) {
        if (socket.readyState !== WebSocket.OPEN) {
            return;
        }
        socket.send(JSON.stringify(envelope));
    }

    socket.on('close', disconnect);
    socket.on('error', terminate);
    socket.on('pong', () => { awaitingPong = false; });
    connections.set(socket, terminate);
    try {
        connection = bus.connect(accountId, deliver);
    } catch {
        logger.error('Event bus connection failed');
        terminate();
        return;
    }
    socket.on('message', raw => {
        Promise.resolve().then(() => connection.receive(raw.toString())).catch(() => {
            logger.error('Event bus message processing failed');
        });
    });
    heartbeat = timers.setInterval(() => {
        if (awaitingPong) {
            terminate();
            return;
        }
        awaitingPong = true;
        socket.ping();
    }, 15_000);
}

/**
 * Creates ticket-authenticated WebSocket transport on the native HTTP servers.
 * Authentication and CSRF middleware must run before issuing a ticket.
 * @param {object} options Transport dependencies.
 * @param {object} options.bus Bus exposing connect(accountId, deliver).
 * @param {() => number} [options.now] Current epoch time in milliseconds.
 * @param {object} [options.timers] Native-compatible timeout and interval methods.
 * @param {object} [options.logger] Logger receiving only fixed, credential-free messages.
 * @returns {{issueTicket: Function, close: Function}} Ticket and lifecycle operations.
 */
export function createEventTransport({ bus, now = Date.now, timers = globalThis, logger = console }) {
    const websocketServer = new WebSocketServer({ noServer: true });
    const attachments = new Map();
    const tickets = new Map();
    const connections = new Map();
    let closed = false;
    let closing;

    function removeTicket(ticket) {
        const record = tickets.get(ticket);
        if (!record) {
            return;
        }
        timers.clearTimeout(record.timeout);
        tickets.delete(ticket);
    }

    function upgrade(server, paths, request, socket, head) {
        let url;
        try {
            url = new URL(request.url, 'http://localhost');
        } catch {
            return;
        }
        if (!paths.has(url.pathname)) {
            return;
        }
        const ticket = url.searchParams.get('ticket');
        const record = tickets.get(ticket);
        if (closed || !record || record.expiresAt <= now() || record.server !== server || record.path !== url.pathname) {
            if (record?.expiresAt <= now()) {
                removeTicket(ticket);
            }
            rejectUpgrade(socket);
            return;
        }
        websocketServer.handleUpgrade(request, socket, head, websocket => {
            removeTicket(ticket);
            connectSocket(websocket, record.accountId, bus, timers, logger, connections);
        });
    }

    function attach(server, path) {
        const existing = attachments.get(server);
        if (existing) {
            existing.paths.add(path);
            return;
        }
        const paths = new Set([path]);
        const listener = (request, socket, head) => upgrade(server, paths, request, socket, head);
        server.on('upgrade', listener);
        attachments.set(server, { paths, listener });
    }

    return {
        /**
         * Attaches to the authenticated request's server and issues a 30-second ticket.
         * @param {object} request Native request with user.profile.handle, baseUrl and socket.server.
         * @returns {{ticket: string, expiresAt: string}} Single-use ticket and UTC expiry.
         */
        issueTicket(request) {
            if (closed) {
                throw new Error('Event transport is closed');
            }
            const accountId = request.user?.profile?.handle;
            if (typeof accountId !== 'string' || !accountId) {
                throw Object.assign(new Error('Authentication required'), { status: 403 });
            }
            const server = request.socket?.server;
            if (!server || typeof request.baseUrl !== 'string') {
                throw new Error('Native request server and API mount required');
            }
            const path = `${request.baseUrl}/events`;
            attach(server, path);
            const ticket = randomBytes(32).toString('base64url');
            const expiresAt = now() + 30_000;
            const timeout = timers.setTimeout(() => removeTicket(ticket), 30_000);
            tickets.set(ticket, { accountId, expiresAt, server, path, timeout });
            return { ticket, expiresAt: new Date(expiresAt).toISOString() };
        },
        /**
         * Invalidates tickets, removes owned listeners, and terminates active connections.
         * Repeated calls return the same shutdown promise.
         * @returns {Promise<void>} Resolves when the WebSocket server has closed.
         */
        close() {
            if (closing) {
                return closing;
            }
            closed = true;
            for (const [server, { listener }] of attachments) {
                server.off('upgrade', listener);
            }
            attachments.clear();
            for (const ticket of tickets.keys()) {
                removeTicket(ticket);
            }
            for (const terminate of connections.values()) {
                terminate();
            }
            closing = new Promise(resolve => websocketServer.close(() => resolve()));
            return closing;
        },
    };
}

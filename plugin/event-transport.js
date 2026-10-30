import { randomBytes } from 'node:crypto';

import { WebSocket, WebSocketServer } from 'ws';

class WebSocketConnection {
    #socket;
    #timers;
    #logger;
    #connections;
    #connection;
    #heartbeat;
    #awaitingPong = false;
    #disconnected = false;

    constructor(socket, accountId, { bus, timers, logger, connections }) {
        this.#socket = socket;
        this.#timers = timers;
        this.#logger = logger;
        this.#connections = connections;
        connections.add(this);
        socket.on('close', this.#disconnect.bind(this));
        socket.on('error', this.terminate.bind(this));
        socket.on('pong', this.#pong.bind(this));
        try {
            this.#connection = bus.connect(accountId, this.#deliver.bind(this));
        } catch {
            logger.error('Event bus connection failed');
            this.terminate();
            return;
        }
        socket.on('message', this.#receive.bind(this));
        this.#heartbeat = timers.setInterval(this.#ping.bind(this), 15_000);
    }

    #disconnect() {
        if (this.#disconnected) {
            return;
        }
        this.#disconnected = true;
        this.#timers.clearInterval(this.#heartbeat);
        this.#connections.delete(this);
        this.#connection?.disconnect();
    }

    terminate() {
        this.#disconnect();
        this.#socket.terminate();
    }

    #deliver(envelope) {
        if (this.#socket.readyState !== WebSocket.OPEN) {
            return;
        }
        this.#socket.send(JSON.stringify(envelope));
    }

    async #receive(raw) {
        try {
            await this.#connection.receive(raw.toString());
        } catch {
            this.#logger.error('Event bus message processing failed');
        }
    }

    #pong() {
        this.#awaitingPong = false;
    }

    #ping() {
        if (this.#awaitingPong) {
            this.terminate();
            return;
        }
        this.#awaitingPong = true;
        this.#socket.ping();
    }
}

export class EventTransport {
    #bus;
    #now;
    #timers;
    #logger;
    #websocketServer;
    #attachments = new Map();
    #tickets = new Map();
    #connections = new Set();
    #closed = false;
    #closing;

    /**
     * Creates transport with injected routing, clock, timer, and logging dependencies.
     * @param {object} options Transport dependencies.
     * @param {object} options.bus Bus exposing connect(accountId, deliver).
     * @param {() => number} [options.now] Current epoch time in milliseconds.
     * @param {object} [options.timers] Native-compatible timeout and interval methods.
     * @param {object} [options.logger] Logger receiving fixed, credential-free messages.
     */
    constructor({ bus, now = Date.now, timers = globalThis, logger = console }) {
        this.#bus = bus;
        this.#now = now;
        this.#timers = timers;
        this.#logger = logger;
        this.#websocketServer = new WebSocketServer({ noServer: true });
    }

    #removeTicket(ticket) {
        const record = this.#tickets.get(ticket);
        if (!record) {
            return;
        }
        this.#timers.clearTimeout(record.timeout);
        this.#tickets.delete(ticket);
    }

    #upgrade(server, paths, request, socket, head) {
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
        const record = this.#tickets.get(ticket);
        if (this.#closed || !record || record.expiresAt <= this.#now() || record.server !== server || record.path !== url.pathname) {
            if (record?.expiresAt <= this.#now()) {
                this.#removeTicket(ticket);
            }
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            return;
        }
        this.#websocketServer.handleUpgrade(request, socket, head, this.#accept.bind(this, ticket, record.accountId));
    }

    #accept(ticket, accountId, socket) {
        this.#removeTicket(ticket);
        new WebSocketConnection(socket, accountId, {
            bus: this.#bus,
            timers: this.#timers,
            logger: this.#logger,
            connections: this.#connections,
        });
    }

    #attach(server, path) {
        const existing = this.#attachments.get(server);
        if (existing) {
            existing.paths.add(path);
            return;
        }
        const paths = new Set([path]);
        const listener = this.#upgrade.bind(this, server, paths);
        server.on('upgrade', listener);
        this.#attachments.set(server, { paths, listener });
    }

    /**
     * Attaches to the authenticated request's server and issues a 30-second ticket.
     * Native authentication and CSRF middleware must run before this method.
     * @param {object} request Native request with user.profile.handle, baseUrl and socket.server.
     * @returns {{ticket: string, expiresAt: string}} Single-use ticket and UTC expiry.
     */
    issueTicket(request) {
        if (this.#closed) {
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
        this.#attach(server, path);
        const ticket = randomBytes(32).toString('base64url');
        const expiresAt = this.#now() + 30_000;
        const timeout = this.#timers.setTimeout(this.#removeTicket.bind(this, ticket), 30_000);
        this.#tickets.set(ticket, { accountId, expiresAt, server, path, timeout });
        return { ticket, expiresAt: new Date(expiresAt).toISOString() };
    }

    /**
     * Invalidates tickets, removes owned listeners, and terminates active connections.
     * Repeated calls return the same shutdown promise.
     * @returns {Promise<void>} Resolves when the WebSocket server has closed.
     */
    close() {
        if (this.#closing) {
            return this.#closing;
        }
        this.#closed = true;
        for (const [server, { listener }] of this.#attachments) {
            server.off('upgrade', listener);
        }
        this.#attachments.clear();
        for (const ticket of this.#tickets.keys()) {
            this.#removeTicket(ticket);
        }
        for (const connection of this.#connections) {
            connection.terminate();
        }
        this.#closing = new Promise(resolve => this.#websocketServer.close(() => resolve()));
        return this.#closing;
    }
}

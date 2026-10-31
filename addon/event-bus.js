const lifecycleEvents = new Set(['bus.connected', 'bus.disconnected', 'bus.status']);
const serverEvents = new Set(['multiplayer.owner.changed', 'multiplayer.lorebooks.changed', 'multiplayer.participant.left']);
const retryDelays = [1000, 2000, 4000, 8000, 15000];
const identityFields = ['accountId', 'groupId', 'chatId'];

function busError(code, message = code.replaceAll('_', ' ')) {
    return Object.assign(new Error(message), { code });
}

function isIdentity(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && identityFields.every(key => typeof value[key] === 'string' && value[key].length > 0);
}

function sameChat(left, right) {
    return isIdentity(left) && isIdentity(right) && identityFields.every(key => left[key] === right[key]);
}

function identityOf(value) {
    if (!isIdentity(value)) {
        throw busError('invalid_request');
    }
    return { accountId: value.accountId, groupId: value.groupId, chatId: value.chatId };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((accept, decline) => {
        resolve = accept;
        reject = decline;
    });
    return { promise, resolve, reject };
}

export class BrowserEventBus {
    #fetch;
    #WebSocket;
    #getRequestHeaders;
    #getCurrentChat;
    #location;
    #setTimeout;
    #clearTimeout;
    #logger;
    #attempt = null;
    #retryTimer = null;
    #retryIndex = 0;
    #hasOpened = false;
    #handlers = new Map();
    #pending = new Map();
    #nextRequestId = 0;
    #intent = 0;
    #association = null;
    #associationIntent = 0;
    #status = null;
    #statusChat = null;

    /**
     * Creates a browser-safe bus without opening a connection or installing UI.
     * @param {object} [options] Browser dependencies and the integration's current-chat provider.
     * @param {typeof fetch} [options.fetch=globalThis.fetch] Ticket request transport.
     * @param {typeof WebSocket} [options.WebSocket=globalThis.WebSocket] Socket constructor.
     * @param {Function} [options.getRequestHeaders] Native CSRF headers; defaults to SillyTavern's context helper.
     * @param {() => object|null} [options.getCurrentChat] Returns the open accountId/groupId/chatId identity, or null.
     * @param {Location|URL} [options.location=globalThis.location] Same-server URL context.
     * @param {Function} [options.setTimeout=globalThis.setTimeout] Retry scheduler.
     * @param {Function} [options.clearTimeout=globalThis.clearTimeout] Retry cancellation.
     * @param {{error: Function}} [options.logger=console] Local handler-error logger.
     */
    constructor({
        fetch = globalThis.fetch,
        WebSocket = globalThis.WebSocket,
        getRequestHeaders = () => globalThis.SillyTavern.getContext().getRequestHeaders(),
        getCurrentChat = () => null,
        location = globalThis.location,
        setTimeout = globalThis.setTimeout,
        clearTimeout = globalThis.clearTimeout,
        logger = console,
    } = {}) {
        this.#fetch = fetch;
        this.#WebSocket = WebSocket;
        this.#getRequestHeaders = getRequestHeaders;
        this.#getCurrentChat = getCurrentChat;
        this.#location = location;
        this.#setTimeout = setTimeout;
        this.#clearTimeout = clearTimeout;
        this.#logger = logger;
    }

    /** @returns {{isOwner: boolean, ownerPresent: boolean}|null} Defensive last accepted status, or null before joining, after leaving or on disconnection. */
    get sessionStatus() {
        return this.#status ? { ...this.#status } : null;
    }

    /**
     * Opens the socket, or reuses the existing connection attempt. Restarts after authentication failure.
     * Resolution means socket open, not automatic rejoin acknowledgment. Calls during retry backoff reject as unavailable; retries continue unless HTTP 403 stops them.
     * @returns {Promise<void>} The current attempt's socket-open result.
     */
    connect() {
        if (this.#attempt && !this.#attempt.active) {
            return Promise.reject(busError('connection_unavailable', 'Connection retry is scheduled.'));
        }
        if (this.#attempt) {
            return this.#attempt.promise;
        }
        return this.#startAttempt();
    }

    /**
     * Registers one independent, synchronously invoked event consumer.
     * @param {string} eventName Namespaced application or reserved lifecycle event name.
     * @param {(chat: object|null, sender: object|null, body: *) => *} handler Receives independent deep copies; asynchronous completion is not awaited.
     * @returns {() => void} Idempotent unsubscribe for this registration only.
     */
    on(eventName, handler) {
        const registrations = this.#handlers.get(eventName) ?? new Set();
        this.#handlers.set(eventName, registrations);
        const registration = { handler };
        registrations.add(registration);
        return () => {
            registrations.delete(registration);
            if (registrations.size === 0 && this.#handlers.get(eventName) === registrations) {
                this.#handlers.delete(eventName);
            }
        };
    }

    /**
     * Requests association with a source-qualified chat, superseding earlier pending joins.
     * @param {{accountId: string, groupId: string, chatId: string}} chat Owning account, group and chat identity.
     * @returns {Promise<{isOwner: boolean, ownerPresent: boolean, lorebooks: object[]}>} Matching acknowledgment, or a coded server, superseded or unknown_outcome error. A failed join retains the prior association.
     */
    async join(chat) {
        const identity = identityOf(chat);
        this.#requireConnection();
        const intent = this.#newIntent();
        return this.#request({ op: 'join', ...identity }, { intent, chat: identity });
    }

    /**
     * Clears the server association, superseding pending joins; already-unjoined leave is valid.
     * @returns {Promise<void>} Matching acknowledgment, or a coded failure including unknown_outcome on connection loss.
     */
    async leave() {
        const intent = this.#newIntent();
        this.#requireConnection();
        return this.#request({ op: 'leave' }, { intent });
    }

    /**
     * Sends opaque JSON in the acknowledged, currently open chat without buffering or replay.
     * @param {string} destination Owner, all, server, or a connection ID in this chat.
     * @param {string} eventName Namespaced application event, excluding reserved lifecycle and server-only events.
     * @param {*} body JSON-serializable payload.
     * @returns {Promise<void>} Routing acknowledgment, not handler completion; rejects with a coded local/server error or unknown_outcome after connection loss.
     */
    async send(destination, eventName, body) {
        if (typeof destination !== 'string' || destination.length === 0
            || typeof eventName !== 'string' || !/^[^.\s]+\.[^\s.]+(?:\.[^\s.]+)*$/u.test(eventName)
            || lifecycleEvents.has(eventName) || serverEvents.has(eventName)) {
            throw busError('invalid_request');
        }
        let payload;
        try {
            payload = JSON.parse(JSON.stringify(body));
        } catch {
            throw busError('invalid_request', 'The event body cannot be serialized as JSON.');
        }
        this.#requireConnection();
        if (!sameChat(this.#association, this.#getCurrentChat()) || this.#hasPendingMembership()) {
            throw busError('not_joined');
        }
        if (destination === 'owner' && sameChat(this.#statusChat, this.#association) && this.#status?.ownerPresent === false) {
            throw busError('owner_unavailable');
        }
        return this.#request({ op: 'send', destination, eventName, body: payload });
    }

    #startAttempt() {
        const attempt = { ...deferred(), socket: null, active: true, opened: false };
        this.#attempt = attempt;
        this.#openSocket(attempt);
        return attempt.promise;
    }

    async #openSocket(attempt) {
        try {
            const response = await this.#fetch('/api/plugins/multiplayer/events/connect', {
                method: 'POST', credentials: 'same-origin', headers: this.#getRequestHeaders(),
            });
            if (!this.#isActive(attempt)) {
                return;
            }
            if (!response.ok) {
                this.#loseAttempt(attempt, busError(response.status === 403 ? 'forbidden' : 'connection_unavailable'), response.status === 403);
                return;
            }
            const { ticket } = await response.json();
            if (!this.#isActive(attempt)) {
                return;
            }
            if (typeof ticket !== 'string' || ticket.length === 0) {
                throw busError('connection_unavailable');
            }
            const url = new URL('/api/plugins/multiplayer/events', this.#location.href);
            url.protocol = this.#location.protocol === 'https:' ? 'wss:' : 'ws:';
            url.searchParams.set('ticket', ticket);
            const socket = new this.#WebSocket(url.href);
            attempt.socket = socket;
            socket.addEventListener('open', () => this.#opened(attempt));
            socket.addEventListener('close', () => this.#loseAttempt(attempt));
            socket.addEventListener('error', () => this.#loseAttempt(attempt));
            socket.addEventListener('message', event => {
                if (this.#isActive(attempt) && attempt.opened) {
                    this.#receive(event.data);
                }
            });
        } catch {
            this.#loseAttempt(attempt);
        }
    }

    #isActive(attempt) {
        return this.#attempt === attempt && attempt.active;
    }

    #opened(attempt) {
        if (!this.#isActive(attempt) || attempt.opened) {
            return;
        }
        const reconnecting = this.#hasOpened;
        const intent = this.#intent;
        attempt.opened = true;
        this.#hasOpened = true;
        this.#retryIndex = 0;
        attempt.resolve();
        this.#dispatch('bus.connected', null, null, null);
        if (!reconnecting || !this.#isActive(attempt) || this.#intent !== intent) {
            return;
        }
        const chat = this.#getCurrentChat();
        if (chat) {
            this.join(chat).catch(error => this.#log(error));
        }
    }

    #loseAttempt(attempt, error = busError('connection_unavailable'), stop = false) {
        if (!this.#isActive(attempt)) {
            return;
        }
        attempt.active = false;
        attempt.reject(error);
        this.#association = null;
        this.#status = null;
        this.#statusChat = null;
        for (const request of this.#pending.values()) {
            request.reject(busError('unknown_outcome', 'Connection lost before acknowledgment; request outcome is unknown.'));
        }
        this.#pending.clear();
        if (stop) {
            this.#attempt = null;
            this.#retryIndex = 0;
            if (this.#retryTimer !== null) {
                this.#clearTimeout(this.#retryTimer);
                this.#retryTimer = null;
            }
        } else {
            const delay = retryDelays[Math.min(this.#retryIndex++, retryDelays.length - 1)];
            this.#retryTimer = this.#setTimeout(() => {
                if (this.#attempt !== attempt) {
                    return;
                }
                this.#retryTimer = null;
                this.#startAttempt().catch(() => {});
            }, delay);
        }
        if (attempt.socket) {
            try {
                attempt.socket.close();
            } catch {
                this.#log(busError('connection_unavailable'));
            }
            this.#dispatch('bus.disconnected', null, null, null);
        }
    }

    #requireConnection() {
        if (!this.#attempt?.active || !this.#attempt.opened || this.#attempt.socket.readyState !== 1) {
            throw busError('connection_unavailable');
        }
    }

    #newIntent() {
        this.#intent++;
        for (const request of this.#pending.values()) {
            if (request.op === 'join' && !request.superseded) {
                request.superseded = true;
                request.reject(busError('superseded', 'Join superseded by a newer join or leave.'));
            }
        }
        return this.#intent;
    }

    #hasPendingMembership() {
        return [...this.#pending.values()].some(request => request.op === 'join' || request.op === 'leave');
    }

    #request(envelope, context = {}) {
        const requestId = String(++this.#nextRequestId);
        const request = { ...deferred(), ...context, op: envelope.op, superseded: false };
        this.#pending.set(requestId, request);
        try {
            this.#attempt.socket.send(JSON.stringify({ ...envelope, requestId }));
        } catch {
            this.#loseAttempt(this.#attempt);
        }
        return request.promise;
    }

    #receive(raw) {
        let envelope;
        try {
            envelope = JSON.parse(raw);
        } catch {
            return;
        }
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
            return;
        }
        if (envelope.op === 'result') {
            this.#result(envelope);
            return;
        }
        if (!sameChat(envelope.chat, this.#getCurrentChat())) {
            return;
        }
        if (envelope.op === 'status' && this.#acceptsStatus(envelope.chat)) {
            this.#setStatus(envelope.chat, envelope);
        } else if (envelope.op === 'event' && !lifecycleEvents.has(envelope.eventName)) {
            this.#dispatch(envelope.eventName, envelope.chat, envelope.sender, envelope.body);
        }
    }

    #acceptsStatus(chat) {
        const membership = [...this.#pending.values()].filter(request => request.op !== 'send');
        if (membership.length > 0) {
            const latest = membership.find(request => request.intent === this.#intent);
            return latest?.op === 'join' && (sameChat(latest.chat, chat) || sameChat(this.#association, chat));
        }
        return sameChat(this.#association, chat);
    }

    #result(envelope) {
        const request = this.#pending.get(envelope.requestId);
        if (!request || typeof envelope.ok !== 'boolean') {
            return;
        }
        this.#pending.delete(envelope.requestId);
        if (!envelope.ok) {
            request.reject(busError(envelope.error?.code ?? 'internal_error', envelope.error?.message));
            return;
        }
        if (request.op !== 'send' && request.intent >= this.#associationIntent) {
            this.#associationIntent = request.intent;
            this.#association = request.op === 'join' ? request.chat : null;
        }
        if (request.superseded) {
            return;
        }
        if (request.op === 'join') {
            if (request.intent === this.#intent && sameChat(request.chat, this.#getCurrentChat())) {
                this.#setStatus(request.chat, envelope.data, true);
            }
            request.resolve(structuredClone(envelope.data));
            return;
        }
        if (request.op === 'leave' && request.intent === this.#intent) {
            this.#status = null;
            this.#statusChat = null;
        }
        request.resolve();
    }

    #setStatus(chat, data, deduplicate = false) {
        if (typeof data?.isOwner !== 'boolean' || typeof data?.ownerPresent !== 'boolean') {
            return;
        }
        const status = { isOwner: data.isOwner, ownerPresent: data.ownerPresent };
        const unchanged = sameChat(this.#statusChat, chat) && this.#status?.isOwner === status.isOwner
            && this.#status?.ownerPresent === status.ownerPresent;
        this.#statusChat = identityOf(chat);
        this.#status = status;
        if (!deduplicate || !unchanged) {
            this.#dispatch('bus.status', chat, null, status);
        }
    }

    #dispatch(eventName, chat, sender, body) {
        for (const { handler } of [...(this.#handlers.get(eventName) ?? [])]) {
            try {
                Promise.resolve(handler(structuredClone(chat), structuredClone(sender), structuredClone(body)))
                    .catch(error => this.#log(error));
            } catch (error) {
                this.#log(error);
            }
        }
    }

    #log(error) {
        try {
            this.#logger.error(error);
        } catch {
            return;
        }
    }
}

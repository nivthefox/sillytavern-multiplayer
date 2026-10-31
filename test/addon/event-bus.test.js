import assert from 'node:assert/strict';
import { test } from 'node:test';

const moduleResult = await import('../../addon/event-bus.js').then(
    module => ({ module }),
    error => ({ error }),
);
const chatA = { accountId: 'host', groupId: 'group', chatId: 'first' };
const chatB = { accountId: 'guest', groupId: 'other', chatId: 'second' };
const joinedData = {
    isOwner: false,
    ownerPresent: true,
    lorebooks: [{ accountId: 'host', filename: 'world.json' }, { accountId: 'guest', filename: 'world.json' }],
};

async function flush() {
    for (let index = 0; index < 30; index++) {
        await Promise.resolve();
    }
}

function observe(promise) {
    assert.equal(typeof promise?.then, 'function', 'operation must return a promise');
    const result = { state: 'pending' };
    promise.then(value => Object.assign(result, { state: 'fulfilled', value }), error => Object.assign(result, { state: 'rejected', error }));
    return result;
}

function fulfilled(result, value) {
    assert.equal(result.state, 'fulfilled');
    assert.deepEqual(result.value, value);
}

function rejected(result, pattern) {
    assert.equal(result.state, 'rejected');
    assert.ok(result.error instanceof Error);
    if (pattern) {
        assert.match(`${result.error.code ?? ''} ${result.error.message}`, pattern);
    }
}

function createHarness(overrides = {}) {
    assert.ok(moduleResult.module, `addon/event-bus.js must load: ${moduleResult.error?.message}`);
    assert.equal(typeof moduleResult.module.BrowserEventBus, 'function', 'export BrowserEventBus');
    let now = 0;
    let timerId = 0;
    const timers = new Map();
    const sockets = [];
    const requests = [];
    const logs = [];
    const responses = [];
    const context = { chat: null, lookups: 0, headers: { 'X-CSRF-Token': 'native-token' } };

    class FakeWebSocket extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        readyState = FakeWebSocket.CONNECTING;
        sent = [];

        constructor(url) {
            super();
            this.url = String(url);
            sockets.push(this);
        }

        emit(type, properties = {}) {
            const event = Object.assign(new Event(type), properties);
            this.dispatchEvent(event);
            this[`on${type}`]?.(event);
        }

        open() {
            this.readyState = FakeWebSocket.OPEN;
            this.emit('open');
        }

        send(raw) {
            assert.equal(this.readyState, FakeWebSocket.OPEN);
            assert.equal(typeof raw, 'string');
            this.sent.push(JSON.parse(raw));
        }

        message(envelope) {
            this.emit('message', { data: JSON.stringify(envelope) });
        }

        close() {
            this.readyState = FakeWebSocket.CLOSED;
            this.emit('close', { code: 1006, reason: '', wasClean: false });
        }
    }

    const options = {
        fetch: async (url, init) => {
            requests.push({ url, init, time: now });
            const response = responses.shift();
            if (response instanceof Error) {
                throw response;
            }
            return response ?? Response.json({ ticket: `ticket +/&?${requests.length}`, expiresAt: '2099-01-01T00:00:00.000Z' });
        },
        WebSocket: FakeWebSocket,
        getRequestHeaders: () => ({ ...context.headers }),
        getCurrentChat: () => {
            context.lookups++;
            return context.chat;
        },
        location: new URL('https://tavern.example:8443/'),
        setTimeout: (callback, delay) => {
            const id = ++timerId;
            timers.set(id, { callback, at: now + delay });
            return id;
        },
        clearTimeout: id => timers.delete(id),
        logger: Object.fromEntries(['error', 'warn', 'info', 'debug', 'log'].map(level => [level, (...args) => logs.push({ level, args })])),
        ...overrides,
    };
    const bus = new moduleResult.module.BrowserEventBus(options);

    async function advance(milliseconds) {
        const end = now + milliseconds;
        for (;;) {
            const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!entry) {
                break;
            }
            const [id, timer] = entry;
            now = timer.at;
            timers.delete(id);
            timer.callback();
            await flush();
        }
        now = end;
        await flush();
    }

    async function connect() {
        const result = observe(bus.connect());
        await flush();
        const socket = sockets.at(-1);
        assert.ok(socket, 'ticket success must create a WebSocket');
        assert.equal(result.state, 'pending', 'connect waits for open');
        socket.open();
        await flush();
        assert.equal(result.state, 'fulfilled');
        return socket;
    }

    async function reply(socket, request, data = null, error) {
        assert.ok(request, 'expected an outgoing request');
        assert.ok(request.requestId, 'request has a correlation ID');
        socket.message(error
            ? { op: 'result', requestId: request.requestId, ok: false, error }
            : { op: 'result', requestId: request.requestId, ok: true, data });
        await flush();
    }

    async function join(socket, chat = chatA, data = joinedData) {
        context.chat = structuredClone(chat);
        const result = observe(bus.join(chat));
        await flush();
        const request = socket.sent.at(-1);
        assert.deepEqual(request, { op: 'join', requestId: request?.requestId, ...chat });
        assert.equal(result.state, 'pending');
        await reply(socket, request, data);
        fulfilled(result, data);
    }

    return { bus, options, sockets, requests, responses, logs, timers, context, advance, connect, reply, join };
}

function deliver(socket, chat = chatA, body = { nested: { value: 1 } }, eventName = 'rpg-companion.update', sender = { accountId: 'guest', connectionId: 'connection-2' }) {
    socket.message({ op: 'event', chat, sender, eventName, body });
}

test('browser event bus exposes the proposed public API and initially has no session status', () => {
    const { bus } = createHarness();
    for (const method of ['connect', 'send', 'on', 'join', 'leave']) {
        assert.equal(typeof bus[method], 'function', method);
    }
    assert.equal(bus.sessionStatus, null);
});

test('ticket request uses native CSRF headers, no body, same origin and an encoded ticket', async () => {
    const h = createHarness();
    const socket = await h.connect();
    const { url, init } = h.requests[0];
    assert.equal(new URL(url, h.options.location).href, 'https://tavern.example:8443/api/plugins/multiplayer/events/connect');
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('X-CSRF-Token'), 'native-token');
    assert.ok(init.body == null);
    assert.notEqual(init.credentials, 'omit');
    const wsUrl = new URL(socket.url);
    assert.equal(wsUrl.protocol, 'wss:');
    assert.equal(wsUrl.host, 'tavern.example:8443');
    assert.equal(wsUrl.pathname, '/api/plugins/multiplayer/events');
    assert.equal(wsUrl.searchParams.get('ticket'), 'ticket +/&?1');
    assert.equal(socket.sent.length, 0);
    await h.bus.connect();
    assert.equal(h.requests.length, 1);
    assert.equal(h.sockets.length, 1);
});

test('HTTP origins use ws rather than wss', async () => {
    const h = createHarness({ location: new URL('http://tavern.example:8080/') });
    const socket = await h.connect();
    assert.equal(new URL(socket.url).protocol, 'ws:');
});

test('connection lifecycle handlers receive three null arguments and loss clears status', async () => {
    const h = createHarness();
    const events = [];
    h.bus.on('bus.connected', (...args) => events.push(['connected', ...args]));
    h.bus.on('bus.disconnected', (...args) => events.push(['disconnected', ...args]));
    const socket = await h.connect();
    await h.join(socket);
    socket.close();
    await flush();
    assert.deepEqual(events, [['connected', null, null, null], ['disconnected', null, null, null]]);
    assert.equal(h.bus.sessionStatus, null);
});

test('network failures retry at 1, 2, 4, 8, 15, 15 seconds without a real clock', async () => {
    const h = createHarness();
    h.responses.push(...Array.from({ length: 8 }, () => new Error('offline')));
    const result = observe(h.bus.connect());
    await flush();
    rejected(result);
    let elapsed = 0;
    for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
        const count = h.requests.length;
        await h.advance(delay - 1);
        assert.equal(h.requests.length, count);
        await h.advance(1);
        elapsed += delay;
        assert.equal(h.requests.length, count + 1);
        assert.equal(h.requests.at(-1).time, elapsed);
    }
});

for (const failure of ['HTTP 500', 'socket error', 'socket close']) {
    test(`${failure} rejects connect but leaves automatic retry enabled`, async () => {
        const h = createHarness();
        if (failure === 'HTTP 500') {
            h.responses.push(new Response(null, { status: 500 }));
        }
        const result = observe(h.bus.connect());
        await flush();
        if (failure === 'socket error') {
            h.sockets[0].emit('error');
            h.sockets[0].close();
        }
        if (failure === 'socket close') {
            h.sockets[0].close();
        }
        await flush();
        rejected(result);
        await h.advance(999);
        assert.equal(h.requests.length, 1);
        await h.advance(1);
        assert.equal(h.requests.length, 2);
    });
}

test('403 halts retries and explicit connect restarts after authentication is restored', async () => {
    const h = createHarness();
    const socket = await h.connect();
    socket.close();
    h.responses.push(new Response(null, { status: 403 }));
    await h.advance(1000);
    assert.equal(h.requests.length, 2);
    await h.advance(120000);
    assert.equal(h.requests.length, 2);
    h.context.headers = { 'X-CSRF-Token': 'restored-token' };
    await h.connect();
    assert.equal(h.requests.length, 3);
    assert.equal(new Headers(h.requests[2].init.headers).get('X-CSRF-Token'), 'restored-token');
});

test('initial 403 rejects connect and does not retry', async () => {
    const h = createHarness();
    h.responses.push(new Response(null, { status: 403 }));
    const result = observe(h.bus.connect());
    await flush();
    rejected(result);
    await h.advance(60000);
    assert.equal(h.requests.length, 1);
    assert.equal(h.sockets.length, 0);
});

test('successful reconnection obtains a fresh ticket and resets the retry delay', async () => {
    const h = createHarness();
    const first = await h.connect();
    first.close();
    h.responses.push(new Error('offline'), new Error('offline'));
    await h.advance(1000 + 2000 + 4000);
    const second = h.sockets.at(-1);
    assert.notEqual(second, first);
    assert.notEqual(new URL(second.url).searchParams.get('ticket'), new URL(first.url).searchParams.get('ticket'));
    second.open();
    await flush();
    second.close();
    const count = h.requests.length;
    await h.advance(999);
    assert.equal(h.requests.length, count);
    await h.advance(1);
    assert.equal(h.requests.length, count + 1);
});

for (const currentChat of [chatB, null]) {
    test(`reconnection consults current open chat (${currentChat ? 'changed' : 'none'}) without replaying sends`, async () => {
        const h = createHarness();
        const socket = await h.connect();
        await h.join(socket);
        const sent = observe(h.bus.send('all', 'multiplayer.turn', { text: 'before loss' }));
        await flush();
        await h.reply(socket, socket.sent.at(-1));
        fulfilled(sent, undefined);
        socket.close();
        h.context.chat = currentChat;
        const lookups = h.context.lookups;
        await h.advance(1000);
        const recovered = h.sockets.at(-1);
        recovered.open();
        await flush();
        assert.ok(h.context.lookups > lookups);
        assert.deepEqual(recovered.sent.map(request => request.op), currentChat ? ['join'] : []);
        if (currentChat) {
            assert.deepEqual(recovered.sent[0], { op: 'join', requestId: recovered.sent[0].requestId, ...currentChat });
            await h.reply(recovered, recovered.sent[0], joinedData);
        }
    });
}

test('join acknowledgment supplies lorebooks and publishes current session status', async () => {
    const h = createHarness();
    const statuses = [];
    h.bus.on('bus.status', (...args) => statuses.push(args));
    const socket = await h.connect();
    await h.join(socket);
    assert.deepEqual(h.bus.sessionStatus, { isOwner: false, ownerPresent: true });
    assert.deepEqual(statuses, [[chatA, null, { isOwner: false, ownerPresent: true }]]);
    socket.message({ op: 'status', chat: chatA, isOwner: true, ownerPresent: true });
    await flush();
    assert.deepEqual(h.bus.sessionStatus, { isOwner: true, ownerPresent: true });
    assert.deepEqual(statuses.at(-1), [chatA, null, { isOwner: true, ownerPresent: true }]);
});

test('send envelopes contain only routing data and unique IDs; acknowledgments correlate out of order', async () => {
    const h = createHarness();
    const socket = await h.connect();
    await h.join(socket);
    const body = { sender: { accountId: 'claimed' }, arbitrary: [null, true, 5, 'text'] };
    const results = ['owner', 'all', 'server', 'connection-2'].map(destination => observe(h.bus.send(destination, 'rpg-companion.update', body)));
    await flush();
    const requests = socket.sent.slice(1);
    assert.equal(requests.length, 4);
    assert.equal(new Set(socket.sent.map(request => request.requestId)).size, 5);
    requests.forEach((request, index) => {
        assert.deepEqual(request, { op: 'send', requestId: request.requestId, destination: ['owner', 'all', 'server', 'connection-2'][index], eventName: 'rpg-companion.update', body });
        assert.equal(results[index].state, 'pending');
    });
    socket.message({ op: 'result', requestId: 'unrecognized', ok: true, data: null });
    await flush();
    assert.ok(results.every(result => result.state === 'pending'));
    for (const index of [3, 1, 2, 0]) {
        await h.reply(socket, requests[index]);
        fulfilled(results[index], undefined);
    }
});

for (const code of ['invalid_request', 'forbidden', 'not_found', 'not_joined', 'owner_unavailable', 'connection_unavailable', 'internal_error']) {
    test(`server ${code} errors reject the matching promise with code and message`, async () => {
        const h = createHarness();
        const socket = await h.connect();
        await h.join(socket);
        const result = observe(h.bus.send('all', 'multiplayer.turn', null));
        await flush();
        await h.reply(socket, socket.sent.at(-1), null, { code, message: `Server says ${code}` });
        rejected(result);
        assert.equal(result.error.code, code);
        assert.equal(result.error.message, `Server says ${code}`);
        assert.equal(socket.readyState, 1);
    });
}

test('leave waits for acknowledgment, clears status, and succeeds again when unjoined', async () => {
    const h = createHarness();
    const socket = await h.connect();
    await h.join(socket);
    for (let index = 0; index < 2; index++) {
        const result = observe(h.bus.leave());
        await flush();
        const request = socket.sent.at(-1);
        assert.deepEqual(request, { op: 'leave', requestId: request.requestId });
        assert.equal(result.state, 'pending');
        await h.reply(socket, request);
        fulfilled(result, undefined);
        assert.equal(h.bus.sessionStatus, null);
    }
});

test('failed join rejects while preserving the previous association', async () => {
    const h = createHarness();
    const socket = await h.connect();
    await h.join(socket);
    const result = observe(h.bus.join(chatB));
    await flush();
    await h.reply(socket, socket.sent.at(-1), null, { code: 'forbidden', message: 'Denied' });
    rejected(result, /forbidden/);
    assert.deepEqual(h.bus.sessionStatus, { isOwner: false, ownerPresent: true });
    const send = observe(h.bus.send('all', 'multiplayer.turn', null));
    await flush();
    assert.equal(socket.sent.at(-1).op, 'send');
    await h.reply(socket, socket.sent.at(-1));
    fulfilled(send, undefined);
});

for (const latest of ['join', 'leave']) {
    test(`newer ${latest} supersedes an outstanding join and late results cannot restore old status`, async () => {
        const h = createHarness();
        const socket = await h.connect();
        const statuses = [];
        h.bus.on('bus.status', (...args) => statuses.push(args));
        h.context.chat = chatA;
        const old = observe(h.bus.join(chatA));
        await flush();
        const oldRequest = socket.sent.at(-1);
        h.context.chat = latest === 'join' ? chatB : null;
        const current = observe(latest === 'join' ? h.bus.join(chatB) : h.bus.leave());
        await flush();
        rejected(old, /superseded/i);
        const currentRequest = socket.sent.at(-1);
        assert.equal(currentRequest.op, latest);
        await h.reply(socket, currentRequest, latest === 'join' ? joinedData : null);
        fulfilled(current, latest === 'join' ? joinedData : undefined);
        const before = structuredClone(statuses);
        const status = structuredClone(h.bus.sessionStatus);
        await h.reply(socket, oldRequest, { ...joinedData, isOwner: true });
        assert.deepEqual(statuses, before);
        assert.deepEqual(h.bus.sessionStatus, status);
        assert.deepEqual(socket.sent.map(request => request.op), ['join', latest]);
    });
}

for (const operation of ['send', 'join', 'leave']) {
    test(`connection loss gives pending ${operation} an explicit unknown outcome and never replays it`, async () => {
        const h = createHarness();
        const socket = await h.connect();
        await h.join(socket);
        const result = observe(operation === 'send' ? h.bus.send('all', 'multiplayer.turn', null) : operation === 'join' ? h.bus.join(chatB) : h.bus.leave());
        await flush();
        assert.equal(result.state, 'pending');
        socket.close();
        await flush();
        rejected(result, /unknown[ _-]?outcome/i);
        h.context.chat = null;
        await h.advance(1000);
        const recovered = h.sockets.at(-1);
        recovered.open();
        await flush();
        assert.deepEqual(recovered.sent, []);
    });
}

for (const state of ['disconnected', 'unjoined', 'no open chat', 'owner absent']) {
    test(`send fails immediately with ${state}, without queueing`, async () => {
        const h = createHarness();
        let socket;
        if (state !== 'disconnected') {
            socket = await h.connect();
        }
        if (state === 'no open chat' || state === 'owner absent') {
            await h.join(socket, chatA, { ...joinedData, ownerPresent: false });
        }
        if (state === 'no open chat') {
            h.context.chat = null;
        }
        const count = socket?.sent.length ?? 0;
        const result = observe(h.bus.send(state === 'owner absent' ? 'owner' : 'all', 'multiplayer.turn', null));
        await flush();
        rejected(result);
        assert.equal(socket?.sent.length ?? 0, count);
        if (!socket) {
            socket = await h.connect();
        }
        await h.join(socket);
        assert.equal(socket.sent.filter(request => request.op === 'send').length, 0);
    });
}

test('handlers receive independent deep copies in order without awaiting completion; failures are isolated and logged', async () => {
    const h = createHarness();
    const socket = await h.connect();
    await h.join(socket);
    const calls = [];
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    h.bus.on('rpg-companion.update', (chat, sender, body) => {
        calls.push('mutator');
        chat.chatId = 'mutated';
        sender.connectionId = 'mutated';
        body.nested.value = 99;
        throw new Error('synchronous failure');
    });
    h.bus.on('rpg-companion.update', () => {
        calls.push('pending');
        return pending;
    });
    h.bus.on('rpg-companion.update', async () => {
        calls.push('rejecting');
        throw new Error('asynchronous failure');
    });
    h.bus.on('rpg-companion.update', (...args) => calls.push(args));
    deliver(socket);
    await flush();
    assert.deepEqual(calls, ['mutator', 'pending', 'rejecting', [chatA, { accountId: 'guest', connectionId: 'connection-2' }, { nested: { value: 1 } }]]);
    assert.ok(h.logs.some(entry => entry.args.some(value => String(value).includes('synchronous failure'))));
    assert.ok(h.logs.some(entry => entry.args.some(value => String(value).includes('asynchronous failure'))));
    release();
    await flush();
});

test('unsubscribe removes only its registration, including duplicate callback registrations', async () => {
    const h = createHarness();
    const socket = await h.connect();
    await h.join(socket);
    const calls = [];
    const handler = () => calls.push('duplicate');
    const unsubscribe = h.bus.on('multiplayer.turn', handler);
    assert.equal(typeof unsubscribe, 'function');
    h.bus.on('multiplayer.turn', handler);
    h.bus.on('multiplayer.turn', () => calls.push('other'));
    unsubscribe();
    unsubscribe();
    deliver(socket, chatA, null, 'multiplayer.turn');
    deliver(socket, chatA, null, 'unregistered.event');
    await flush();
    assert.deepEqual(calls, ['duplicate', 'other']);
});

test('consecutive incoming events retain order and server-originated events keep null sender', async () => {
    const h = createHarness();
    const socket = await h.connect();
    await h.join(socket);
    const calls = [];
    for (const name of ['multiplayer.owner.changed', 'multiplayer.lorebooks.changed', 'multiplayer.participant.left', 'rpg-companion.update']) {
        h.bus.on(name, (...args) => calls.push([name, ...args]));
    }
    deliver(socket, chatA, {}, 'multiplayer.owner.changed', null);
    deliver(socket, chatA, { lorebooks: joinedData.lorebooks }, 'multiplayer.lorebooks.changed', null);
    deliver(socket, chatA, { accountId: 'guest' }, 'multiplayer.participant.left', null);
    deliver(socket, chatA, [1, 2], 'rpg-companion.update', null);
    await flush();
    assert.deepEqual(calls, [
        ['multiplayer.owner.changed', chatA, null, {}],
        ['multiplayer.lorebooks.changed', chatA, null, { lorebooks: joinedData.lorebooks }],
        ['multiplayer.participant.left', chatA, null, { accountId: 'guest' }],
        ['rpg-companion.update', chatA, null, [1, 2]],
    ]);
});

for (const field of ['accountId', 'groupId', 'chatId', 'no current chat']) {
    test(`stale event/status filtering compares current chat ${field}, not remembered membership`, async () => {
        const h = createHarness();
        const socket = await h.connect();
        await h.join(socket);
        const calls = [];
        h.bus.on('bus.status', (...args) => calls.push(args));
        h.bus.on('rpg-companion.update', (...args) => calls.push(args));
        h.context.chat = field === 'no current chat' ? null : { ...chatA, [field]: 'changed' };
        const before = structuredClone(h.bus.sessionStatus);
        deliver(socket);
        socket.message({ op: 'status', chat: chatA, isOwner: true, ownerPresent: false });
        await flush();
        assert.deepEqual(calls, []);
        assert.deepEqual(h.bus.sessionStatus, before);
    });
}

test('status handlers cannot mutate another handler input or internal session status', async () => {
    const h = createHarness();
    const socket = await h.connect();
    await h.join(socket);
    let received;
    h.bus.on('bus.status', (chat, sender, body) => {
        chat.accountId = 'changed';
        body.isOwner = false;
    });
    h.bus.on('bus.status', (...args) => { received = args; });
    socket.message({ op: 'status', chat: chatA, isOwner: true, ownerPresent: true });
    await flush();
    assert.deepEqual(received, [chatA, null, { isOwner: true, ownerPresent: true }]);
    assert.deepEqual(h.bus.sessionStatus, { isOwner: true, ownerPresent: true });
});

for (const eventName of ['bus.connected', 'bus.disconnected', 'bus.status', 'multiplayer.owner.changed', 'multiplayer.lorebooks.changed', 'multiplayer.participant.left']) {
    test(`application send rejects reserved event ${eventName}`, async () => {
        const h = createHarness();
        const socket = await h.connect();
        await h.join(socket);
        const count = socket.sent.length;
        const result = observe(h.bus.send('all', eventName, {}));
        await flush();
        rejected(result);
        assert.equal(socket.sent.length, count);
        assert.equal(socket.readyState, 1);
    });
}

for (const [label, destination, eventName] of [
    ['empty destination', '', 'addon.event'],
    ['non-string destination', {}, 'addon.event'],
    ['unqualified name', 'all', 'event'],
    ['empty namespace', 'all', '.event'],
    ['empty event', 'all', 'addon.'],
    ['whitespace', 'all', 'addon.bad event'],
    ['non-string name', 'all', null],
]) {
    test(`routing validation rejects ${label} locally`, async () => {
        const h = createHarness();
        const socket = await h.connect();
        await h.join(socket);
        const count = socket.sent.length;
        const result = observe(h.bus.send(destination, eventName, {}));
        await flush();
        rejected(result);
        assert.equal(socket.sent.length, count);
    });
}

for (const [label, makeBody] of [
    ['circular object', () => { const body = {}; body.self = body; return body; }],
    ['BigInt', () => 1n],
    ['nested BigInt', () => ({ nested: [1n] })],
    ['undefined root', () => undefined],
    ['function root', () => () => {}],
    ['symbol root', () => Symbol('body')],
]) {
    test(`non-JSON ${label} rejects locally without damaging the socket`, async () => {
        const h = createHarness();
        const socket = await h.connect();
        await h.join(socket);
        const count = socket.sent.length;
        const result = observe(h.bus.send('all', 'addon.event', makeBody()));
        await flush();
        rejected(result);
        assert.equal(socket.sent.length, count);
        assert.equal(socket.readyState, 1);
        const valid = observe(h.bus.send('all', 'addon.event', null));
        await flush();
        await h.reply(socket, socket.sent.at(-1));
        fulfilled(valid, undefined);
    });
}

test('superseded join acknowledgment arriving before the latest acknowledgment is ignored', async () => {
    const h = createHarness();
    const socket = await h.connect();
    const statuses = [];
    h.bus.on('bus.status', (...args) => statuses.push(args));
    h.context.chat = chatA;
    const first = observe(h.bus.join(chatA));
    await flush();
    const firstRequest = socket.sent.at(-1);
    h.context.chat = chatB;
    const latest = observe(h.bus.join(chatB));
    await flush();
    const latestRequest = socket.sent.at(-1);
    rejected(first, /superseded/i);
    await h.reply(socket, firstRequest, { ...joinedData, isOwner: true });
    assert.equal(h.bus.sessionStatus, null);
    assert.deepEqual(statuses, []);
    assert.equal(latest.state, 'pending');
    await h.reply(socket, latestRequest, joinedData);
    fulfilled(latest, joinedData);
    assert.deepEqual(statuses, [[chatB, null, { isOwner: false, ownerPresent: true }]]);
});

test('join result for a no-longer-open chat does not publish current status', async () => {
    const h = createHarness();
    const socket = await h.connect();
    const statuses = [];
    h.bus.on('bus.status', (...args) => statuses.push(args));
    h.context.chat = chatA;
    observe(h.bus.join(chatA));
    await flush();
    h.context.chat = chatB;
    await h.reply(socket, socket.sent.at(-1), joinedData);
    assert.deepEqual(statuses, []);
    assert.equal(h.bus.sessionStatus, null);
});

test('failed leave rejects rather than reporting successful departure', async () => {
    const h = createHarness();
    const socket = await h.connect();
    await h.join(socket);
    const result = observe(h.bus.leave());
    await flush();
    await h.reply(socket, socket.sent.at(-1), null, { code: 'internal_error', message: 'Leave failed' });
    rejected(result, /internal_error/);
});

test('concurrent connect calls share a single ticket and socket attempt', async () => {
    const h = createHarness();
    const first = observe(h.bus.connect());
    const second = observe(h.bus.connect());
    await flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.sockets.length, 1);
    h.sockets[0].open();
    await flush();
    fulfilled(first, undefined);
    fulfilled(second, undefined);
});

test('current chat must match acknowledged association before sending', async () => {
    const h = createHarness();
    const socket = await h.connect();
    await h.join(socket);
    h.context.chat = chatB;
    const count = socket.sent.length;
    const result = observe(h.bus.send('all', 'addon.event', {}));
    await flush();
    rejected(result);
    assert.equal(socket.sent.length, count);
});

test('server status before a join acknowledgment reaches the current chat', async () => {
    const h = createHarness();
    const socket = await h.connect();
    h.context.chat = chatA;
    const statuses = [];
    h.bus.on('bus.status', (...args) => statuses.push(args));
    const joined = observe(h.bus.join(chatA));
    await flush();
    socket.message({ op: 'status', chat: chatA, isOwner: true, ownerPresent: true });
    await flush();
    assert.deepEqual(statuses, [[chatA, null, { isOwner: true, ownerPresent: true }]]);
    assert.equal(joined.state, 'pending');
    await h.reply(socket, socket.sent.at(-1), { ...joinedData, isOwner: true });
    fulfilled(joined, { ...joinedData, isOwner: true });
});

test('old socket messages and close callbacks cannot affect a recovered connection', async () => {
    const h = createHarness();
    const old = await h.connect();
    await h.join(old);
    old.close();
    await h.advance(1000);
    const recovered = h.sockets.at(-1);
    recovered.open();
    await flush();
    await h.reply(recovered, recovered.sent.at(-1), joinedData);
    const calls = [];
    h.bus.on('addon.event', (...args) => calls.push(args));
    h.bus.on('bus.disconnected', (...args) => calls.push(args));
    deliver(old, chatA, {}, 'addon.event');
    old.message({ op: 'status', chat: chatA, isOwner: true, ownerPresent: false });
    old.close();
    await flush();
    assert.deepEqual(calls, []);
    assert.deepEqual(h.bus.sessionStatus, { isOwner: false, ownerPresent: true });
    await h.advance(30000);
    assert.equal(h.requests.length, 2);
});

for (const intent of ['join', 'leave']) {
    test(`reconnection does not override a connected handler's explicit ${intent} intent`, async () => {
        const h = createHarness();
        const first = await h.connect();
        await h.join(first);
        first.close();
        let latest;
        h.bus.on('bus.connected', () => {
            if (intent === 'join') {
                h.context.chat = chatB;
                latest = observe(h.bus.join(chatB));
                return;
            }
            h.context.chat = null;
            latest = observe(h.bus.leave());
        });
        await h.advance(1000);
        const recovered = h.sockets.at(-1);
        recovered.open();
        await flush();
        assert.deepEqual(recovered.sent.map(request => request.op), [intent]);
        await h.reply(recovered, recovered.sent[0], intent === 'join' ? joinedData : null);
        fulfilled(latest, intent === 'join' ? joinedData : undefined);
    });
}

test('failed replacement join retains ownership updates for the still-open previous chat', async () => {
    const h = createHarness();
    const socket = await h.connect();
    await h.join(socket, chatA, { ...joinedData, ownerPresent: false });
    const statuses = [];
    h.bus.on('bus.status', (...args) => statuses.push(args));
    const replacement = observe(h.bus.join(chatB));
    await flush();
    const request = socket.sent.at(-1);
    socket.message({ op: 'status', chat: chatA, isOwner: false, ownerPresent: true });
    await flush();
    await h.reply(socket, request, null, { code: 'forbidden', message: 'Denied' });
    rejected(replacement, /forbidden/);
    assert.deepEqual(statuses, [[chatA, null, { isOwner: false, ownerPresent: true }]]);
    assert.deepEqual(h.bus.sessionStatus, { isOwner: false, ownerPresent: true });
    const send = observe(h.bus.send('owner', 'addon.event', {}));
    await flush();
    assert.equal(socket.sent.at(-1).op, 'send');
    await h.reply(socket, socket.sent.at(-1));
    fulfilled(send, undefined);
});

test('connect during backoff cannot reuse a closed socket successful opening result', async () => {
    const h = createHarness();
    const socket = await h.connect();
    let fromHandler;
    h.bus.on('bus.disconnected', () => {
        fromHandler = observe(h.bus.connect());
    });
    socket.close();
    await flush();
    rejected(fromHandler, /connection_unavailable/);
    const explicit = observe(h.bus.connect());
    await flush();
    rejected(explicit, /connection_unavailable/);
    assert.equal(h.requests.length, 1);
    await h.advance(999);
    assert.equal(h.requests.length, 1);
    await h.advance(1);
    assert.equal(h.requests.length, 2);
    const retry = observe(h.bus.connect());
    h.sockets.at(-1).open();
    await flush();
    fulfilled(retry, undefined);
});

test('session status getter cannot mutate the library state', async () => {
    const h = createHarness();
    const socket = await h.connect();
    await h.join(socket);
    const snapshot = h.bus.sessionStatus;
    snapshot.ownerPresent = false;
    assert.deepEqual(h.bus.sessionStatus, { isOwner: false, ownerPresent: true });
});

test('open idle sockets generate no application heartbeat messages', async () => {
    const h = createHarness();
    const socket = await h.connect();
    await h.advance(60000);
    assert.deepEqual(socket.sent, []);
    assert.equal(h.requests.length, 1);
});

for (const body of [null, false, 0, '', ['value', { deep: [true, null] }], { arbitrary: { field: 'no schema' } }]) {
    test(`JSON body ${JSON.stringify(body)} is transmitted unchanged`, async () => {
        const h = createHarness();
        const socket = await h.connect();
        await h.join(socket);
        const result = observe(h.bus.send('server', 'other-addon.custom.event', body));
        await flush();
        assert.deepEqual(socket.sent.at(-1).body, body);
        await h.reply(socket, socket.sent.at(-1));
        fulfilled(result, undefined);
    });
}

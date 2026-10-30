import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { inspect } from 'node:util';

import { WebSocket } from 'ws';

import * as transportModule from '../../plugin/event-transport.js';

const mount = '/api/plugins/multiplayer';
const start = Date.parse('2026-10-30T18:00:00.000Z');

function createClock() {
    let time = start;
    let sequence = 0;
    const tasks = new Map();
    function schedule(callback, delay, interval) {
        const id = ++sequence;
        tasks.set(id, { callback, due: time + delay, interval });
        return id;
    }
    return {
        now: () => time,
        timers: {
            setTimeout: (callback, delay) => schedule(callback, delay, 0),
            clearTimeout: id => tasks.delete(id),
            setInterval: (callback, delay) => schedule(callback, delay, delay),
            clearInterval: id => tasks.delete(id),
        },
        get pending() { return tasks.size; },
        advance(milliseconds) {
            const end = time + milliseconds;
            while (true) {
                const next = [...tasks.entries()].sort((a, b) => a[1].due - b[1].due)[0];
                if (!next || next[1].due > end) {
                    break;
                }
                const [id, task] = next;
                time = task.due;
                if (task.interval) {
                    task.due += task.interval;
                } else {
                    tasks.delete(id);
                }
                task.callback();
            }
            time = end;
        },
    };
}

function createBus() {
    const connections = [];
    return {
        connections,
        connect(accountId, deliver) {
            const connection = {
                id: `connection-${connections.length + 1}`,
                accountId,
                deliver,
                received: [],
                disconnects: 0,
                receive(rawJSON) {
                    this.received.push(rawJSON);
                    deliver({ op: 'result', requestId: 'barrier', ok: true, data: null });
                },
                disconnect() { this.disconnects += 1; },
            };
            connections.push(connection);
            return connection;
        },
    };
}

async function serve(t, transport, baseUrl = mount) {
    const server = createServer(async (req, res) => {
        req.baseUrl = baseUrl;
        req.user = { profile: { handle: req.headers['x-test-account'] ?? 'owner' } };
        try {
            const ticket = await transport.issueTicket(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(ticket));
        } catch {
            res.writeHead(500);
            res.end();
        }
    });
    const sockets = new Set();
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        for (const socket of sockets) {
            socket.destroy();
        }
        await new Promise(resolve => server.close(resolve));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    return {
        server,
        origin,
        async ticket(accountId = 'owner') {
            const response = await fetch(`${origin}${baseUrl}/events/connect`, {
                method: 'POST', headers: { 'x-test-account': accountId },
            });
            assert.equal(response.status, 200, 'authenticated ticket issuance must succeed');
            return response.json();
        },
        url(ticket, path = `${baseUrl}/events`) {
            const url = new URL(path, origin.replace('http:', 'ws:'));
            if (ticket !== undefined) {
                url.searchParams.set('ticket', ticket);
            }
            return url.href;
        },
    };
}

async function setup(t) {
    const clock = createClock();
    const bus = createBus();
    const logs = [];
    const logger = Object.fromEntries(['debug', 'info', 'warn', 'error', 'log'].map(level => [level, (...args) => logs.push(args)]));
    assert.equal(typeof transportModule.EventTransport, 'function', 'EventTransport must be an exported constructor');
    const transport = new transportModule.EventTransport({ bus, now: clock.now, timers: clock.timers, logger });
    const host = await serve(t, transport);
    t.after(() => transport.close());
    return { ...host, transport, clock, bus, logs };
}

async function open(t, url, options = {}) {
    const socket = new WebSocket(url, { handshakeTimeout: 1000, ...options });
    t.after(() => socket.terminate());
    await once(socket, 'open');
    return socket;
}

async function rejectedUpgrade(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = request(url.replace('ws:', 'http:'), {
            agent: false,
            headers: {
                Connection: 'Upgrade', Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                ...headers,
            },
        });
        req.setTimeout(1000, () => req.destroy(new Error('Upgrade was not answered')));
        req.on('error', reject);
        req.on('response', response => {
            response.resume();
            resolve(response.statusCode);
        });
        req.on('upgrade', (_response, socket) => {
            socket.destroy();
            reject(new Error('Expected upgrade rejection, received 101'));
        });
        req.end();
    });
}

async function barrier(socket) {
    const response = once(socket, 'message');
    socket.send('{"op":"leave","requestId":"barrier"}');
    await response;
}

test('tickets expire exactly 30 seconds after issuance and attach once per underlying server', async t => {
    const fixture = await setup(t);
    assert.equal(fixture.server.listenerCount('upgrade'), 0);
    const first = await fixture.ticket();
    assert.equal(fixture.server.listenerCount('upgrade'), 1);
    const second = await fixture.ticket();
    assert.equal(fixture.server.listenerCount('upgrade'), 1);
    assert.equal(first.expiresAt, new Date(start + 30_000).toISOString());
    assert.equal(typeof first.ticket, 'string');
    assert.ok(first.ticket.length > 0);
    assert.notEqual(first.ticket, second.ticket);
    const other = await serve(t, fixture.transport);
    await other.ticket();
    assert.equal(other.server.listenerCount('upgrade'), 1);
});

test('unused tickets release expiry timers and shutdown invalidates outstanding tickets', async t => {
    const fixture = await setup(t);
    await fixture.ticket();
    assert.ok(fixture.clock.pending > 0);
    fixture.clock.advance(30_000);
    assert.equal(fixture.clock.pending, 0);
    await fixture.ticket();
    await fixture.transport.close();
    assert.equal(fixture.clock.pending, 0);
    assert.equal(fixture.server.listenerCount('upgrade'), 0);
    await assert.rejects(async () => fixture.transport.issueTicket({
        user: { profile: { handle: 'owner' } },
        socket: { server: fixture.server },
        baseUrl: mount,
    }), /closed/i);
    assert.equal(fixture.server.listenerCount('upgrade'), 0);
    assert.equal(fixture.clock.pending, 0);
});

test('unauthenticated direct issuance does not attach or allocate a ticket', async t => {
    const fixture = await setup(t);
    await assert.rejects(async () => fixture.transport.issueTicket({
        socket: { server: fixture.server }, baseUrl: mount,
    }), { status: 403 });
    assert.equal(fixture.server.listenerCount('upgrade'), 0);
    assert.equal(fixture.clock.pending, 0);
});

test('successful upgrade consumes the ticket and binds the native account, not URL identity', async t => {
    const fixture = await setup(t);
    const { ticket } = await fixture.ticket('guest');
    const socket = await open(t, `${fixture.url(ticket)}&accountId=forged`);
    assert.equal(fixture.bus.connections.length, 1);
    assert.equal(fixture.bus.connections[0].accountId, 'guest');
    assert.equal(await rejectedUpgrade(fixture.url(ticket)), 403);
    assert.equal(socket.readyState, WebSocket.OPEN);
    assert.equal(fixture.bus.connections.length, 1);
});

test('missing and unknown tickets reject with 403 without opening a bus connection', async t => {
    const fixture = await setup(t);
    await fixture.ticket();
    for (const ticket of [undefined, '', 'unknown-ticket']) {
        assert.equal(await rejectedUpgrade(fixture.url(ticket)), 403);
    }
    assert.equal(fixture.bus.connections.length, 0);
});

test('ticket remains valid just before expiry and is rejected at the expiry boundary', async t => {
    const fixture = await setup(t);
    const valid = await fixture.ticket();
    const expired = await fixture.ticket();
    fixture.clock.advance(29_999);
    await open(t, fixture.url(valid.ticket));
    fixture.clock.advance(1);
    assert.equal(await rejectedUpgrade(fixture.url(expired.ticket)), 403);
    assert.equal(fixture.bus.connections.length, 1);
});

test('failed WebSocket handshake does not consume a valid ticket', async t => {
    const fixture = await setup(t);
    const { ticket } = await fixture.ticket();
    const status = await rejectedUpgrade(fixture.url(ticket), { 'Sec-WebSocket-Key': 'invalid' });
    assert.notEqual(status, 101);
    assert.equal(fixture.bus.connections.length, 0);
    await open(t, fixture.url(ticket));
    assert.equal(fixture.bus.connections.length, 1);
});

test('unrelated upgrade paths are untouched and do not consume tickets', async t => {
    const fixture = await setup(t);
    const { ticket } = await fixture.ticket();
    const handled = [];
    fixture.server.on('upgrade', (req, socket) => {
        const path = new URL(req.url, fixture.origin).pathname;
        if (path === `${mount}/events`) {
            return;
        }
        handled.push({ path, destroyed: socket.destroyed, bytesWritten: socket.bytesWritten });
        socket.end('HTTP/1.1 418 Other Handler\r\nContent-Length: 0\r\n\r\n');
    });
    const paths = ['/events', `${mount}/events/extra`, '/api/plugins/other/events'];
    for (const path of paths) {
        assert.equal(await rejectedUpgrade(fixture.url(ticket, path)), 418);
    }
    assert.deepEqual(handled, paths.map(path => ({ path, destroyed: false, bytesWritten: 0 })));
    await open(t, fixture.url(ticket));
});

test('event path follows request.baseUrl rather than a hard-coded plugin mount', async t => {
    const fixture = await setup(t);
    const other = await serve(t, fixture.transport, '/custom/multiplayer');
    const { ticket } = await other.ticket('guest');
    await open(t, other.url(ticket));
    assert.equal(fixture.bus.connections[0].accountId, 'guest');
});

test('transport passes raw JSON to the bus and serializes delivered envelopes', async t => {
    const fixture = await setup(t);
    const { ticket } = await fixture.ticket();
    const socket = await open(t, fixture.url(ticket));
    await barrier(socket);
    assert.deepEqual(fixture.bus.connections[0].received, ['{"op":"leave","requestId":"barrier"}']);
    const envelope = { op: 'event', eventName: 'example.event', body: { text: 'hello ü' } };
    const message = once(socket, 'message');
    fixture.bus.connections[0].deliver(envelope);
    const [data] = await message;
    assert.deepEqual(JSON.parse(data.toString()), envelope);
});

test('native pings occur every 15 seconds and pongs keep the connection alive without application heartbeats', async t => {
    const fixture = await setup(t);
    const { ticket } = await fixture.ticket();
    const socket = await open(t, fixture.url(ticket));
    const messages = [];
    let pings = 0;
    socket.on('ping', () => { pings += 1; });
    socket.on('message', data => messages.push(JSON.parse(data.toString())));
    fixture.clock.advance(14_999);
    await barrier(socket);
    assert.equal(pings, 0);
    for (const delay of [1, 15_000, 15_000]) {
        const ping = once(socket, 'ping');
        fixture.clock.advance(delay);
        await ping;
        await barrier(socket);
        assert.equal(socket.readyState, WebSocket.OPEN);
    }
    assert.equal(pings, 3);
    assert.equal(messages.length, 4);
    assert.ok(messages.every(message => message.requestId === 'barrier'));
    assert.equal(fixture.bus.connections[0].disconnects, 0);
});

test('missing pong terminates after 15 seconds and disconnects the bus exactly once', async t => {
    const fixture = await setup(t);
    const { ticket } = await fixture.ticket();
    const socket = await open(t, fixture.url(ticket), { autoPong: false });
    const ping = once(socket, 'ping');
    fixture.clock.advance(15_000);
    await ping;
    fixture.clock.advance(14_999);
    await barrier(socket);
    assert.equal(socket.readyState, WebSocket.OPEN);
    const closed = once(socket, 'close');
    fixture.clock.advance(1);
    const [code] = await closed;
    assert.equal(code, 1006);
    assert.equal(fixture.bus.connections[0].disconnects, 1);
    fixture.clock.advance(60_000);
    await fixture.transport.close();
    assert.equal(fixture.bus.connections[0].disconnects, 1);
    assert.equal(fixture.clock.pending, 0);
});

test('normal client closure disconnects the bus once and shutdown clears timers', async t => {
    const fixture = await setup(t);
    const { ticket } = await fixture.ticket();
    const socket = await open(t, fixture.url(ticket));
    const closed = once(socket, 'close');
    socket.close();
    await closed;
    assert.equal(fixture.bus.connections[0].disconnects, 1);
    fixture.clock.advance(60_000);
    assert.equal(fixture.bus.connections[0].disconnects, 1);
    await fixture.transport.close();
    assert.equal(fixture.clock.pending, 0);
});

test('shutdown closes sockets across servers, removes only owned listeners and is idempotent', async t => {
    const fixture = await setup(t);
    const other = await serve(t, fixture.transport);
    const foreign = () => {};
    fixture.server.on('upgrade', foreign);
    const first = await fixture.ticket();
    const second = await other.ticket();
    const sockets = [await open(t, fixture.url(first.ticket)), await open(t, other.url(second.ticket))];
    const closed = sockets.map(socket => once(socket, 'close'));
    await fixture.transport.close();
    await Promise.all(closed);
    assert.deepEqual(fixture.server.listeners('upgrade'), [foreign]);
    assert.equal(other.server.listenerCount('upgrade'), 0);
    assert.deepEqual(fixture.bus.connections.map(connection => connection.disconnects), [1, 1]);
    assert.equal(fixture.clock.pending, 0);
    await fixture.transport.close();
    assert.deepEqual(fixture.bus.connections.map(connection => connection.disconnects), [1, 1]);
});

test('issuance, successful and rejected upgrades never log ticket values', async t => {
    const fixture = await setup(t);
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
        t.mock.method(console, method, (...args) => fixture.logs.push(args));
    }
    const first = await fixture.ticket();
    const expired = await fixture.ticket();
    await open(t, fixture.url(first.ticket));
    assert.equal(await rejectedUpgrade(fixture.url(first.ticket)), 403);
    fixture.clock.advance(30_000);
    assert.equal(await rejectedUpgrade(fixture.url(expired.ticket)), 403);
    const unknown = 'unknown-secret-ticket';
    assert.equal(await rejectedUpgrade(fixture.url(unknown)), 403);
    const output = inspect(fixture.logs, { depth: null });
    for (const secret of [first.ticket, expired.ticket, unknown]) {
        assert.ok(!output.includes(secret), 'ticket values must not appear in logs');
    }
});

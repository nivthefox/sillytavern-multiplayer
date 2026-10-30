import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createServer as createSecureServer, request as secureRequest } from 'node:https';
import { test } from 'node:test';

import express from 'express';
import { WebSocket } from 'ws';

import { createEventBus } from '../../plugin/event-bus.js';
import { createEventTransport } from '../../plugin/event-transport.js';
import { exit, init } from '../../plugin/index.js';

const mount = '/api/plugins/multiplayer';
const chat = { accountId: 'owner', groupId: 'shared', chatId: 'scene' };
const cert = await readFile(new URL('../../fixtures/tls/localhost-cert.pem', import.meta.url));
const key = await readFile(new URL('../../fixtures/tls/localhost-key.pem', import.meta.url));

function createClock() {
    let time = Date.parse('2026-10-30T19:00:00Z');
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

async function listen(t, server) {
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
    return server.address().port;
}

async function post(url, headers) {
    const send = url.startsWith('https:') ? secureRequest : request;
    return new Promise((resolve, reject) => {
        const req = send(url, { method: 'POST', headers, ca: cert, agent: false }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body }));
            response.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}

async function runtime(t, secure = false) {
    const clock = createClock();
    const authorizations = [];
    const bus = createEventBus({
        async authorizeJoin(accountId, identity) {
            authorizations.push({ accountId, identity });
            assert.ok(['owner', 'guest'].includes(accountId));
            assert.deepEqual(identity, chat);
        },
    });
    const transport = createEventTransport({ bus, now: clock.now, timers: clock.timers });
    const observedServers = [];
    const handler = async (req, res) => {
        req.user = { profile: { handle: req.headers['x-test-account'] } };
        req.baseUrl = mount;
        observedServers.push(req.socket.server);
        try {
            const ticket = await transport.issueTicket(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(ticket));
        } catch {
            res.writeHead(500);
            res.end();
        }
    };
    const server = secure ? createSecureServer({ cert, key }, handler) : createServer(handler);
    const port = await listen(t, server);
    t.after(async () => {
        await transport.close();
        bus.close();
    });
    const base = `${secure ? 'https' : 'http'}://127.0.0.1:${port}${mount}`;
    return { bus, transport, server, base, clock, observedServers, authorizations };
}

async function connect(t, base, accountId, options = {}) {
    const response = await post(`${base}/events/connect`, { 'x-test-account': accountId });
    assert.equal(response.status, 200);
    const { ticket } = JSON.parse(response.body);
    const socket = new WebSocket(`${base.replace(/^http/u, 'ws')}/events?ticket=${ticket}`, {
        ca: cert, handshakeTimeout: 1000, ...options,
    });
    const messages = [];
    socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
    t.after(() => socket.terminate());
    await once(socket, 'open');
    let sequence = 0;
    async function send(body) {
        const requestId = String(++sequence);
        const result = new Promise(resolve => {
            function receive(raw) {
                const envelope = JSON.parse(raw.toString());
                if (envelope.op === 'result' && envelope.requestId === requestId) {
                    socket.off('message', receive);
                    resolve(envelope);
                }
            }
            socket.on('message', receive);
        });
        socket.send(JSON.stringify({ ...body, requestId }));
        return result;
    }
    return { socket, messages, send };
}

test('real heartbeat timeout reselects the longest-connected owner and updates surviving chat clients', { timeout: 5000 }, async t => {
    const fixture = await runtime(t);
    const original = await connect(t, fixture.base, 'owner', { autoPong: false });
    const replacement = await connect(t, fixture.base, 'owner');
    const laterOwner = await connect(t, fixture.base, 'owner');
    const guest = await connect(t, fixture.base, 'guest');
    for (const [index, client] of [original, replacement, laterOwner, guest].entries()) {
        const joined = await client.send({ op: 'join', ...chat });
        assert.equal(joined.ok, true);
        assert.equal(joined.data.isOwner, index === 0);
    }
    const clients = [original, replacement, laterOwner, guest];
    const pings = clients.map(client => once(client.socket, 'ping'));
    fixture.clock.advance(15_000);
    await Promise.all(pings);
    for (const client of clients) {
        assert.equal((await client.send({ op: 'join', ...chat })).ok, true);
        client.messages.length = 0;
    }
    fixture.clock.advance(14_999);
    assert.equal(original.socket.readyState, WebSocket.OPEN);
    const closed = once(original.socket, 'close');
    fixture.clock.advance(1);
    assert.equal((await closed)[0], 1006);
    for (const client of [replacement, laterOwner, guest]) {
        const joined = await client.send({ op: 'join', ...chat });
        assert.equal(joined.data.isOwner, client === replacement);
        assert.equal(joined.data.ownerPresent, true);
        assert.equal(client.socket.readyState, WebSocket.OPEN);
        assert.deepEqual(client.messages.filter(message => message.eventName === 'multiplayer.owner.changed'), [{
            op: 'event', chat, eventName: 'multiplayer.owner.changed', sender: null, body: {},
        }]);
    }
    assert.ok(replacement.messages.some(message => message.op === 'status' && message.isOwner && message.ownerPresent));
    const delivered = once(replacement.socket, 'message');
    await fixture.bus.send(chat, 'owner', 'review.owner', { selected: true });
    assert.deepEqual(JSON.parse((await delivered)[0]), {
        op: 'event', chat, eventName: 'review.owner', sender: null, body: { selected: true },
    });
    assert.ok(!laterOwner.messages.some(message => message.eventName === 'review.owner'));
    assert.ok(!guest.messages.some(message => message.eventName === 'review.owner'));
    await fixture.transport.close();
    assert.equal(fixture.clock.pending, 0);
    await assert.rejects(fixture.bus.send(chat, 'owner', 'review.owner', {}));
});

test('HTTPS ticket requests attach their native server, accept verified WSS and shut down cleanly', { timeout: 5000 }, async t => {
    const fixture = await runtime(t, true);
    assert.equal(fixture.server.listenerCount('upgrade'), 0);
    const client = await connect(t, fixture.base, 'owner');
    assert.equal(client.socket._socket.authorized, true);
    assert.deepEqual(fixture.observedServers, [fixture.server]);
    assert.equal(fixture.server.listenerCount('upgrade'), 1);
    assert.equal((await client.send({ op: 'join', ...chat })).data.isOwner, true);
    assert.deepEqual(fixture.authorizations, [{ accountId: 'owner', identity: chat }]);
    const guest = await connect(t, fixture.base, 'guest');
    assert.equal((await guest.send({ op: 'join', ...chat })).data.ownerPresent, true);
    assert.equal(fixture.server.listenerCount('upgrade'), 1);
    const closed = [once(client.socket, 'close'), once(guest.socket, 'close')];
    await fixture.transport.close();
    await Promise.all(closed);
    assert.equal(fixture.server.listenerCount('upgrade'), 0);
    assert.equal(fixture.clock.pending, 0);
    await assert.rejects(fixture.bus.send(chat, 'owner', 'review.owner', {}));
});

test('default plugin auth and upstream CSRF denial do not attach upgrade listeners', { timeout: 5000 }, async t => {
    const app = express();
    app.use((req, res, next) => {
        if (req.headers['x-test-account']) {
            req.user = { profile: { handle: req.headers['x-test-account'] } };
        }
        if (req.headers['x-csrf-token'] !== 'valid') {
            res.sendStatus(403);
            return;
        }
        next();
    });
    const router = express.Router();
    await init(router, { host: {} });
    t.after(exit);
    app.use(mount, router);
    const server = createServer(app);
    const port = await listen(t, server);
    const url = `http://127.0.0.1:${port}${mount}/events/connect`;
    for (const headers of [{}, { 'x-test-account': 'owner' }, { 'x-csrf-token': 'valid' }]) {
        assert.equal((await post(url, headers)).status, 403);
        assert.equal(server.listenerCount('upgrade'), 0);
    }
    const allowed = await post(url, { 'x-test-account': 'owner', 'x-csrf-token': 'valid' });
    assert.equal(allowed.status, 200);
    assert.equal(typeof JSON.parse(allowed.body).ticket, 'string');
    assert.equal(server.listenerCount('upgrade'), 1);
    await exit();
    assert.equal(server.listenerCount('upgrade'), 0);
});

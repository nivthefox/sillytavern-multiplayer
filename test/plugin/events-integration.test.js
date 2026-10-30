import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import express from 'express';
import { WebSocket } from 'ws';

import * as plugin from '../../plugin/index.js';
import { createFixture } from './fixtures.js';

async function serve(t) {
    const fixture = await createFixture(t);
    const app = express();
    app.use((request, response, next) => {
        if (request.headers['x-test-account']) {
            request.user = { profile: { handle: request.headers['x-test-account'] } };
        }
        if (request.method === 'POST' && request.headers['x-csrf-token'] !== 'valid') {
            return response.sendStatus(403);
        }
        next();
    });
    const router = express.Router();
    await plugin.init(router, { host: fixture.host });
    app.use('/api/plugins/multiplayer', router);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        await plugin.exit();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    const base = `http://127.0.0.1:${server.address().port}/api/plugins/multiplayer`;
    return { fixture, server, base };
}

async function connect(t, base, account) {
    const response = await fetch(`${base}/events/connect`, {
        method: 'POST',
        headers: { 'x-test-account': account, 'x-csrf-token': 'valid' },
    });
    assert.equal(response.status, 200, 'initialized plugin must issue real tickets without an injected issuer');
    const ticket = await response.json();
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/events?ticket=${ticket.ticket}`);
    t.after(() => socket.terminate());
    await once(socket, 'open');
    let sequence = 0;
    const request = body => new Promise((resolve, reject) => {
        const requestId = String(++sequence);
        const receive = data => {
            const message = JSON.parse(data);
            if (message.op === 'result' && message.requestId === requestId) {
                socket.off('message', receive);
                resolve(message);
            }
        };
        socket.on('message', receive);
        socket.once('error', reject);
        socket.send(JSON.stringify({ ...body, requestId }));
    });
    return { socket, request };
}

const chat = { accountId: 'owner', groupId: 'shared', chatId: 'first' };

test('plugin initializes ticket transport and authorizes websocket joins against native storage', { timeout: 5000 }, async t => {
    const { base, fixture } = await serve(t);
    await fixture.put('owner', 'groups', 'shared.json', {
        id: 'shared', members: [], chats: ['first'], multiplayer: { accounts: ['guest'] },
    });
    await fixture.put('owner', 'groupChats', 'first.jsonl', '');
    const guest = await connect(t, base, 'guest');
    const joined = await guest.request({ op: 'join', ...chat });
    assert.equal(joined.ok, true);
    assert.deepEqual(joined.data, { isOwner: false, ownerPresent: false, lorebooks: [] });
    const missingMembership = await guest.request({ op: 'join', ...chat, chatId: 'outside' });
    assert.equal(missingMembership.error.code, 'forbidden');
    const outsider = await connect(t, base, 'outsider');
    assert.equal((await outsider.request({ op: 'join', ...chat })).error.code, 'forbidden');
    const owner = await connect(t, base, 'owner');
    assert.equal((await owner.request({ op: 'join', ...chat, chatId: 'outside' })).error.code, 'forbidden');
    await fixture.put('owner', 'groups', 'shared.json', {
        id: 'shared', members: [], chats: ['missing'], multiplayer: { accounts: ['guest'] },
    });
    assert.equal((await guest.request({ op: 'join', ...chat, chatId: 'missing' })).error.code, 'not_found');
});

test('plugin exposes server registration and send using the same live bus and closes it on exit', { timeout: 5000 }, async t => {
    const { base, fixture, server } = await serve(t);
    assert.equal(typeof plugin.on, 'function', 'server consumers need public handler registration');
    assert.equal(typeof plugin.send, 'function', 'server consumers need public explicit-chat sending');
    await fixture.put('owner', 'groups', 'shared.json', {
        id: 'shared', members: [], chats: ['first'], multiplayer: { accounts: ['guest'] },
    });
    await fixture.put('owner', 'groupChats', 'first.jsonl', '');
    const client = await connect(t, base, 'owner');
    await client.request({ op: 'join', ...chat });
    const received = [];
    const unsubscribe = plugin.on('extension.request', (...args) => received.push(args));
    t.after(unsubscribe);
    assert.equal((await client.request({ op: 'send', destination: 'server', eventName: 'extension.request', body: { value: 7 } })).ok, true);
    assert.deepEqual(received[0][0], chat);
    assert.equal(received[0][1].accountId, 'owner');
    assert.deepEqual(received[0][2], { value: 7 });
    const event = once(client.socket, 'message');
    assert.equal(await plugin.send(chat, 'all', 'extension.reply', { value: 8 }), undefined);
    assert.deepEqual(JSON.parse((await event)[0]), {
        op: 'event', chat, sender: null, eventName: 'extension.reply', body: { value: 8 },
    });
    const closed = once(client.socket, 'close');
    await plugin.exit();
    await closed;
    assert.equal(server.listenerCount('upgrade'), 0);
    await assert.rejects(plugin.send(chat, 'all', 'extension.reply', {}));
});

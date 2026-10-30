import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import express from 'express';
import { WebSocket } from 'ws';

import * as plugin from '../../plugin/index.js';
import { createFixture } from '../plugin/fixtures.js';

const chat = { accountId: 'owner', groupId: 'shared', chatId: 'first' };

async function loadLibrary() {
    const library = await import('../../addon/event-bus.js').catch(error => {
        assert.fail(`Browser event-bus library must be importable: ${error.message}`);
    });
    assert.equal(typeof library.BrowserEventBus, 'function');
    return library.BrowserEventBus;
}

async function serve(t) {
    const fixture = await createFixture(t);
    await fixture.put('owner', 'groups', 'shared.json', {
        id: 'shared', members: [], chats: ['first'], multiplayer: { accounts: ['guest'] },
    });
    await fixture.put('owner', 'groupChats', 'first.jsonl', '');
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
    return `http://127.0.0.1:${server.address().port}`;
}

function nextEvent(bus, name) {
    return new Promise(resolve => {
        const unsubscribe = bus.on(name, (...args) => {
            unsubscribe();
            resolve(args);
        });
    });
}

test('browser library interoperates with authenticated tickets, ownership, routing, lorebooks, and backend errors', { timeout: 5000 }, async t => {
    const BrowserEventBus = await loadLibrary();
    const origin = await serve(t);
    const makeBus = accountId => new BrowserEventBus({
        fetch: (url, options) => fetch(new URL(url, origin), options),
        WebSocket,
        location: new URL(origin),
        getRequestHeaders: () => ({ 'x-test-account': accountId, 'x-csrf-token': 'valid' }),
        getCurrentChat: () => chat,
        setTimeout: () => 0,
        clearTimeout: () => {},
    });
    const owner = makeBus('owner');
    const guest = makeBus('guest');
    await owner.connect();
    assert.deepEqual(await owner.join(chat), { isOwner: true, ownerPresent: true, lorebooks: [] });
    await owner.send('server', 'multiplayer.lorebooks.set', { lorebooks: ['world.json'] });
    await guest.connect();
    assert.deepEqual(await guest.join(chat), {
        isOwner: false, ownerPresent: true,
        lorebooks: [{ accountId: 'owner', filename: 'world.json' }],
    });
    const delivered = nextEvent(owner, 'companion.request');
    assert.equal(await guest.send('owner', 'companion.request', { text: 'hello' }), undefined);
    const [identity, sender, body] = await delivered;
    assert.deepEqual(identity, chat);
    assert.equal(sender.accountId, 'guest');
    assert.equal(typeof sender.connectionId, 'string');
    assert.deepEqual(body, { text: 'hello' });
    const reply = nextEvent(guest, 'companion.reply');
    await owner.send(sender.connectionId, 'companion.reply', { text: 'received' });
    assert.deepEqual((await reply)[2], { text: 'received' });
    const serverEvent = nextEvent(guest, 'companion.server');
    await plugin.send(chat, 'all', 'companion.server', [1, 2]);
    assert.deepEqual(await serverEvent, [chat, null, [1, 2]]);
    await assert.rejects(guest.join({ ...chat, chatId: 'outside' }), { code: 'forbidden' });
    await assert.rejects(guest.send('absent-connection', 'companion.request', {}), { code: 'connection_unavailable' });
    const status = nextEvent(guest, 'bus.status');
    assert.equal(await owner.leave(), undefined);
    assert.deepEqual(await status, [chat, null, { isOwner: false, ownerPresent: false }]);
    await assert.rejects(guest.send('owner', 'companion.request', {}), { code: 'owner_unavailable' });
    assert.equal(await guest.leave(), undefined);
    await assert.rejects(guest.send('all', 'companion.request', {}), { code: 'not_joined' });
});

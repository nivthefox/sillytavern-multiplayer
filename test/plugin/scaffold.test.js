import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exit, info, init } from '../../plugin/index.js';

test('entry exposes the SillyTavern plugin contract', () => {
    assert.equal(typeof init, 'function');
    assert.equal(typeof exit, 'function');
    assert.match(info.id, /^[a-z0-9_-]+$/);
    assert.ok(info.name.length > 0);
    assert.ok(info.description.length > 0);
});

test('initialization registers only the resource GET routes and ticket POST route', async () => {
    const registrations = [];
    const router = {
        get(path, handler) {
            assert.equal(typeof handler, 'function');
            registrations.push(['GET', path]);
        },
        post(path, handler) {
            assert.equal(typeof handler, 'function');
            registrations.push(['POST', path]);
        },
    };

    const result = init(router, { host: {} });
    assert.ok(result instanceof Promise);
    assert.equal(await result, undefined);
    assert.deepEqual(registrations, [
        ['GET', '/accounts'],
        ['GET', '/accounts/:accountID/characters/:characterID/card'],
        ['GET', '/accounts/:accountID/characters/:characterID'],
        ['GET', '/accounts/:accountID/personas/:filename'],
        ['GET', '/accounts/:accountID/lore/:filename'],
        ['GET', '/chats'],
        ['GET', '/chats/:accountID/groups'],
        ['GET', '/chats/:accountID/groups/:groupID'],
        ['GET', '/chats/:accountID/groups/:groupID/chats'],
        ['GET', '/chats/:accountID/groups/:groupID/chats/:chatID'],
        ['POST', '/events/connect'],
    ]);
});

test('shutdown is safe before initialization and on repeated calls', async () => {
    assert.equal(await exit(), undefined);
    assert.equal(await exit(), undefined);
});

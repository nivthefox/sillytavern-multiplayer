import test from 'node:test';
import assert from 'node:assert/strict';

const { mountLorebookLifecycle } = await import('../../addon/lorebook-bootstrap.js').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') { throw error; }
    return {};
});

const chat = { accountId: 'owner', groupId: 'group', chatId: 'scene' };

function fixture() {
    const calls = [];
    const handlers = new Map();
    let current = chat;
    let result = { isOwner: false, ownerPresent: true, lorebooks: [{ accountId: 'owner', filename: 'World.json' }] };
    const bus = {
        on(name, handler) {
            handlers.set(name, handler);
            return () => handlers.delete(name);
        },
        async join(identity) { calls.push(['join', identity]); return structuredClone(result); },
        async leave() { calls.push(['leave']); },
        async send(...args) { calls.push(['send', ...args]); },
    };
    const session = Object.fromEntries(['open', 'joined', 'status', 'disconnected', 'receiveList', 'saved', 'deleted', 'leave'].map(name => [name, async (...args) => calls.push([name, ...args])]));
    const originalJoin = bus.join;
    assert.equal(typeof mountLorebookLifecycle, 'function');
    const controller = mountLorebookLifecycle({ bus, session, getCurrentChat: () => current, randomUUID: () => 'browser-nonce', onError: error => { throw error; } });
    return { bus, session, controller, calls, originalJoin, handlers,
        setCurrent(value) { current = value; },
        setResult(value) { result = value; },
        async emit(name, body, sender = null, identity = current) { await handlers.get(name)?.(identity, sender, body); },
    };
}

test('lorebook lifecycle consumes initial and automatic rejoin results without joining twice', async () => {
    const f = fixture();
    await f.bus.join(chat);
    assert.equal(f.calls.filter(call => call[0] === 'join').length, 1);
    assert.deepEqual(f.calls.find(call => call[0] === 'open'), ['open', chat]);
    assert.deepEqual(f.calls.find(call => call[0] === 'joined'), ['joined', { isOwner: false, ownerPresent: true, lorebooks: [{ accountId: 'owner', filename: 'World.json' }] }]);
    await f.emit('bus.disconnected', null, null, null);
    assert.equal(f.calls.filter(call => call[0] === 'disconnected').length, 1);
    f.setResult({ isOwner: true, ownerPresent: true, lorebooks: [] });
    await f.bus.join(chat);
    assert.equal(f.calls.filter(call => call[0] === 'open').length, 1);
    assert.deepEqual(f.calls.filter(call => call[0] === 'joined').at(-1)[1].lorebooks, []);
});

test('lorebook lifecycle forwards status, lists and notifications only for the current chat', async () => {
    const f = fixture();
    await f.bus.join(chat);
    await f.emit('bus.status', { isOwner: true, ownerPresent: true });
    await f.emit('multiplayer.lorebooks.changed', { lorebooks: [] });
    await f.emit('multiplayer.lorebooks.changed', { lorebooks: ['stale'] }, null, { ...chat, chatId: 'old' });
    const sender = { accountId: 'guest', connectionId: 'other' };
    await f.emit('multiplayer.lorebook.saved', { filename: 'PC.json' }, sender);
    await f.emit('multiplayer.lorebook.deleted', { filename: 'PC.json' }, sender);
    assert.deepEqual(f.calls.filter(call => call[0] === 'receiveList'), [['receiveList', { lorebooks: [] }]]);
    assert.deepEqual(f.calls.find(call => call[0] === 'status'), ['status', { isOwner: true, ownerPresent: true }]);
    assert.deepEqual(f.calls.find(call => call[0] === 'saved'), ['saved', sender, { filename: 'PC.json' }]);
    assert.deepEqual(f.calls.find(call => call[0] === 'deleted'), ['deleted', sender, { filename: 'PC.json' }]);
});

test('self identification distinguishes this browser from another tab in the same account', async () => {
    const f = fixture();
    await f.bus.join(chat);
    const probe = f.calls.find(call => call[0] === 'send' && call[2] === 'multiplayer.lorebooks.identify');
    assert.deepEqual(probe, ['send', 'all', 'multiplayer.lorebooks.identify', { nonce: 'browser-nonce' }]);
    const self = { accountId: 'owner', connectionId: 'this-tab' };
    await f.emit('multiplayer.lorebooks.identify', { nonce: 'not-ours' }, self);
    assert.equal(f.controller.isSelf(self), false);
    await f.emit('multiplayer.lorebooks.identify', probe[3], self);
    assert.equal(f.controller.isSelf(self), true);
    assert.equal(f.controller.isSelf({ ...self, connectionId: 'other-tab' }), false);
    await f.emit('bus.disconnected', null, null, null);
    assert.equal(f.controller.isSelf(self), false);
});

test('leaving clears shared access immediately and disposal restores bus methods and listeners', async () => {
    const f = fixture();
    await f.bus.join(chat);
    await f.bus.leave();
    assert.equal(f.calls.filter(call => call[0] === 'leave').length, 2);
    await f.controller.dispose();
    assert.equal(f.bus.join, f.originalJoin);
    assert.equal(f.handlers.size, 0);
});

test('a superseded join result cannot populate the newly selected chat', async () => {
    const f = fixture();
    const pending = f.bus.join(chat);
    f.setCurrent({ ...chat, chatId: 'different' });
    await pending;
    assert.equal(f.calls.filter(call => call[0] === 'joined').length, 0);
});

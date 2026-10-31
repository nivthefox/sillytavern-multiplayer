import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';

import { EventBus, EventConnection } from '../../plugin/event-bus.js';

const chat = { accountId: 'host', groupId: 'group', chatId: 'scene' };
const otherChat = { ...chat, chatId: 'other' };
const eventName = 'rpg-companion.update';

function setup(t, authorizeJoin = async () => {}) {
    const logs = [];
    const bus = new EventBus({ authorizeJoin, logger: { error: (...args) => logs.push(args) } });
    t.after(() => bus.close());
    function connect(accountId = 'guest', deliver) {
        const messages = [];
        const connection = bus.connect(accountId, envelope => {
            messages.push(structuredClone(envelope));
            deliver?.(envelope);
        });
        assert.ok(connection instanceof EventConnection);
        return { connection, messages, accountId };
    }
    return { bus, connect, logs };
}

async function request(client, fields, requestId = 'request') {
    const start = client.messages.length;
    await client.connection.receive(JSON.stringify({ ...fields, requestId }));
    const results = client.messages.slice(start).filter(message => message.op === 'result' && message.requestId === requestId);
    assert.equal(results.length, 1, 'each request receives exactly one correlated result');
    return results[0];
}

function success(result, data = null) {
    assert.deepEqual(result, { op: 'result', requestId: result.requestId, ok: true, data });
}

function failure(result, code) {
    assert.equal(result.op, 'result');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, code);
    assert.equal(typeof result.error?.message, 'string');
    assert.ok(result.error.message.length > 0);
    assert.equal(Object.hasOwn(result, 'data'), false);
}

async function join(client, identity = chat) {
    const result = await request(client, { op: 'join', ...identity });
    assert.equal(result.ok, true);
    return result.data;
}

function send(client, destination = 'all', body = { value: 1 }, name = eventName, requestId) {
    return request(client, { op: 'send', destination, eventName: name, body }, requestId);
}

function events(client, name = eventName) {
    return client.messages.filter(message => message.op === 'event' && message.eventName === name);
}

function clear(...clients) {
    for (const client of clients) {
        client.messages.length = 0;
    }
}

function delivered(client, body, sender, identity = chat, name = eventName) {
    assert.deepEqual(events(client, name), [{ op: 'event', chat: identity, eventName: name, sender, body }]);
}

function sender(client, isOwner = client.accountId === 'host') {
    return { accountId: client.accountId, connectionId: client.connection.id, isOwner };
}

for (const accountId of ['guest', 'host']) {
    for (const departure of ['leave', 'disconnect', 'switch']) {
        test(`participant departure broadcasts only after the last ${accountId} connection: ${departure}`, async t => {
            const { connect } = setup(t);
            const first = connect(accountId);
            const last = connect(accountId);
            const observer = connect('observer');
            const owner = connect(accountId === 'host' ? 'another-guest' : 'host');
            for (const client of [first, last, observer, owner]) {
                await join(client);
            }
            clear(first, last, observer, owner);
            first.connection.disconnect();
            assert.deepEqual(events(observer, 'multiplayer.participant.left'), []);
            assert.deepEqual(events(owner, 'multiplayer.participant.left'), []);
            if (departure === 'disconnect') {
                last.connection.disconnect();
            } else if (departure === 'leave') {
                success(await request(last, { op: 'leave' }));
            } else {
                await join(last, otherChat);
            }
            for (const client of [observer, owner]) {
                delivered(client, { accountId }, null, chat, 'multiplayer.participant.left');
            }
            assert.deepEqual(events(last, 'multiplayer.participant.left'), []);
            last.connection.disconnect();
            assert.equal(events(observer, 'multiplayer.participant.left').length, 1);
        });
    }
}

function deferred() {
    return Promise.withResolvers();
}

async function contribute(client, lorebooks, extra = {}) {
    success(await send(client, 'server', { ...extra, lorebooks }, 'multiplayer.lorebooks.set'));
}

function books(client) {
    const notification = events(client, 'multiplayer.lorebooks.changed').at(-1);
    assert.ok(notification, 'a changed combined list is broadcast');
    assert.deepEqual(notification.chat, chat);
    assert.equal(notification.sender, null);
    return notification.body.lorebooks;
}

function sortedBooks(value) {
    return [...value].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

test('EventBus and EventConnection expose class prototype methods rather than per-instance closures', t => {
    const { bus, connect } = setup(t);
    assert.ok(bus instanceof EventBus);
    const { connection } = connect();
    for (const [instance, constructor, methods] of [
        [bus, EventBus, ['connect', 'on', 'send', 'close']],
        [connection, EventConnection, ['receive', 'disconnect']],
    ]) {
        for (const method of methods) {
            assert.equal(typeof constructor.prototype[method], 'function');
            assert.equal(Object.hasOwn(instance, method), false);
            assert.equal(instance[method], constructor.prototype[method]);
        }
    }
});

test('connections have unique server-generated nonreserved string identities', t => {
    const { connect } = setup(t);
    const ids = Array.from({ length: 20 }, () => connect('host').connection.id);
    for (const id of ids) {
        assert.equal(typeof id, 'string');
        assert.ok(id.length > 0);
        assert.ok(!['owner', 'all', 'server'].includes(id));
    }
    assert.equal(new Set(ids).size, ids.length);
});

test('join authorizes the authenticated account and returns only public session data', async t => {
    const calls = [];
    const { connect } = setup(t, async (...args) => calls.push(args));
    const guest = connect();
    assert.deepEqual(await join(guest), { isOwner: false, ownerPresent: false, lorebooks: [] });
    assert.deepEqual(calls, [['guest', chat]]);
    const owner = connect('host');
    assert.deepEqual(await join(owner), { isOwner: true, ownerPresent: true, lorebooks: [] });
    assert.deepEqual(guest.messages.filter(message => message.op === 'status').at(-1), {
        op: 'status', chat, isOwner: false, ownerPresent: true,
    });
});

test('the first owner to join wins, but replacement uses connection age rather than join age', async t => {
    const { connect } = setup(t);
    const oldest = connect('host');
    const second = connect('host');
    const firstToJoin = connect('host');
    const guest = connect();
    assert.equal((await join(firstToJoin)).isOwner, true);
    assert.equal((await join(second)).isOwner, false);
    assert.equal((await join(oldest)).isOwner, false);
    await join(guest);
    assert.equal((await join(second)).isOwner, false);
    clear(oldest, second, guest);
    firstToJoin.connection.disconnect();
    await setImmediate();
    for (const client of [oldest, second, guest]) {
        delivered(client, {}, null, chat, 'multiplayer.owner.changed');
    }
    assert.deepEqual(oldest.messages.filter(message => message.op === 'status').at(-1), {
        op: 'status', chat, isOwner: true, ownerPresent: true,
    });
    success(await send(guest, 'owner'));
    assert.equal(events(oldest).length, 1);
    assert.equal(events(second).length, 0);
});

for (const departure of ['leave', 'disconnect']) {
    test(`owner ${departure} notifies remaining guests and never promotes them`, async t => {
        const { connect } = setup(t);
        const owner = connect('host');
        const guest = connect();
        await join(owner);
        await join(guest);
        clear(guest);
        if (departure === 'leave') {
            success(await request(owner, { op: 'leave' }));
        } else {
            owner.connection.disconnect();
            await setImmediate();
        }
        delivered(guest, {}, null, chat, 'multiplayer.owner.changed');
        assert.deepEqual(guest.messages.filter(message => message.op === 'status').at(-1), {
            op: 'status', chat, isOwner: false, ownerPresent: false,
        });
        failure(await send(guest, 'owner'), 'owner_unavailable');
        success(await send(guest));
    });
}

test('join and leave effects follow arrival order even while authorization is pending', async t => {
    const gate = deferred();
    const calls = [];
    const { connect } = setup(t, async (accountId, identity) => {
        calls.push(identity);
        if (identity.chatId === chat.chatId) {
            await gate.promise;
        }
    });
    const client = connect();
    const first = request(client, { op: 'join', ...chat }, 'first');
    const second = request(client, { op: 'join', ...otherChat }, 'second');
    const leave = request(client, { op: 'leave' }, 'third');
    const completion = Promise.all([first, second, leave]);
    completion.catch(() => {});
    await setImmediate();
    assert.equal(client.messages.filter(message => message.op === 'result').length, 0);
    gate.resolve();
    const results = await completion;
    assert.ok(results.every(result => result.ok));
    assert.deepEqual(calls, [chat, otherChat]);
    assert.deepEqual(client.messages.filter(message => message.op === 'result').map(result => result.requestId), ['first', 'second', 'third']);
    failure(await send(client), 'not_joined');
});

for (const [status, code] of [[403, 'forbidden'], [404, 'not_found'], [500, 'internal_error'], [undefined, 'internal_error']]) {
    test(`authorization status ${status} maps to ${code} and preserves previous membership`, async t => {
        const { connect } = setup(t, async (accountId, identity) => {
            if (identity.chatId === 'other') {
                throw Object.assign(new Error('resource failure'), { status });
            }
        });
        const client = connect('host');
        await join(client);
        failure(await request(client, { op: 'join', ...otherChat }), code);
        clear(client);
        success(await send(client, 'owner'));
        delivered(client, { value: 1 }, sender(client));
    });
}

test('successful chat replacement removes the old association and does not disturb another chat', async t => {
    const { connect } = setup(t);
    const client = connect('host');
    const guest = connect();
    const other = connect('host');
    await join(client);
    await join(guest);
    await join(other, otherChat);
    clear(guest, other);
    assert.equal((await join(client, otherChat)).isOwner, false);
    delivered(guest, {}, null, chat, 'multiplayer.owner.changed');
    assert.equal(events(other, 'multiplayer.owner.changed').length, 0);
    clear(client, guest, other);
    success(await send(client));
    assert.equal(events(guest).length, 0);
    delivered(other, { value: 1 }, sender(client, false), otherChat);
});

test('leave is idempotent and subsequent sends fail without joining', async t => {
    const { connect } = setup(t);
    const client = connect();
    success(await request(client, { op: 'leave' }));
    await join(client);
    success(await request(client, { op: 'leave' }));
    success(await request(client, { op: 'leave' }));
    failure(await send(client), 'not_joined');
});

for (const destination of ['all', 'owner', 'direct', 'self']) {
    test(`${destination} routing selects only same-chat recipients and preserves opaque body`, async t => {
        const { connect } = setup(t);
        const owner = connect('host');
        const guest = connect();
        const sameAccount = connect();
        const outsider = connect();
        await join(owner);
        await join(guest);
        await join(sameAccount);
        await join(outsider, otherChat);
        clear(owner, guest, sameAccount, outsider);
        const target = destination === 'direct' ? sameAccount.connection.id : destination === 'self' ? guest.connection.id : destination;
        const body = { sender: { accountId: 'forged' }, nested: [null, false, 1, { text: 'hello' }] };
        success(await send(guest, target, body));
        const recipients = destination === 'all' ? [owner, guest, sameAccount] : destination === 'owner' ? [owner] : destination === 'self' ? [guest] : [sameAccount];
        for (const client of [owner, guest, sameAccount, outsider]) {
            if (recipients.includes(client)) {
                delivered(client, body, sender(guest));
            } else {
                assert.deepEqual(events(client), []);
            }
        }
    });
}

test('sender ownership is server-derived for browser and server deliveries and follows owner replacement', async t => {
    const { bus, connect } = setup(t);
    const owner = connect('host');
    const secondary = connect('host');
    const guest = connect();
    for (const client of [owner, secondary, guest]) {
        await join(client);
    }
    const seen = [];
    bus.on(eventName, (identity, source, body) => seen.push({ source, body }));
    const body = { sender: { isOwner: true }, isOwner: true };
    let selectedOwner = owner;
    async function verify(client, isOwner) {
        for (const destination of ['all', 'owner', guest.connection.id, 'server']) {
            clear(guest);
            success(await request(client, {
                op: 'send', destination, eventName, body, sender: { isOwner: true }, isOwner: true,
            }));
            if (destination === 'server') {
                assert.deepEqual(seen.at(-1), { source: sender(client, isOwner), body });
            } else if (destination === 'owner') {
                assert.deepEqual(events(selectedOwner).at(-1)?.sender, sender(client, isOwner));
            } else {
                delivered(guest, body, sender(client, isOwner));
            }
        }
    }
    await verify(owner, true);
    await verify(secondary, false);
    await verify(guest, false);
    success(await request(owner, { op: 'leave' }));
    selectedOwner = secondary;
    await verify(secondary, true);
    await join(owner);
    await verify(owner, false);
    await verify(guest, false);
});

test('owner destination includes the owning sender', async t => {
    const { connect } = setup(t);
    const owner = connect('host');
    await join(owner);
    success(await send(owner, 'owner', null));
    delivered(owner, null, sender(owner));
});

for (const state of ['missing', 'unjoined', 'other-chat', 'disconnected']) {
    test(`direct routing rejects a ${state} destination without redirecting to its account`, async t => {
        const { connect } = setup(t);
        const client = connect();
        const target = connect();
        await join(client);
        if (state === 'other-chat') {
            await join(target, otherChat);
        }
        if (state === 'disconnected') {
            await join(target);
            target.connection.disconnect();
        }
        clear(client, target);
        failure(await send(client, state === 'missing' ? 'missing-id' : target.connection.id), 'connection_unavailable');
        assert.deepEqual(events(client), []);
        assert.deepEqual(events(target), []);
    });
}

test('request IDs correlate but do not deduplicate messages and per-sender order is preserved', async t => {
    const { connect } = setup(t);
    const client = connect();
    await join(client);
    for (const value of [1, 2]) {
        success(await send(client, 'all', value, eventName, 'same-id'));
    }
    const results = await Promise.all([3, 4, 5].map(value => send(client, 'all', value, eventName, `ordered-${value}`)));
    assert.ok(results.every(result => result.ok));
    assert.deepEqual(events(client).map(message => message.body), [1, 2, 3, 4, 5]);
});

const malformed = [
    ['broken JSON', '{', null],
    ['null', 'null', null],
    ['array', '[]', null],
    ['scalar', '42', null],
    ['missing ID', JSON.stringify({ op: 'leave' }), null],
    ['object ID', JSON.stringify({ op: 'leave', requestId: {} }), null],
    ['unknown operation', JSON.stringify({ op: 'unknown', requestId: 'bad' }), 'bad'],
    ['missing group', JSON.stringify({ op: 'join', requestId: 'bad', accountId: 'host', chatId: 'scene' }), 'bad'],
    ['invalid chat', JSON.stringify({ op: 'join', requestId: 'bad', ...chat, chatId: {} }), 'bad'],
    ['missing destination', JSON.stringify({ op: 'send', requestId: 'bad', eventName, body: null }), 'bad'],
    ['invalid destination', JSON.stringify({ op: 'send', requestId: 'bad', destination: [], eventName, body: null }), 'bad'],
    ['unnamespaced event', JSON.stringify({ op: 'send', requestId: 'bad', destination: 'all', eventName: 'update', body: null }), 'bad'],
    ['missing namespace', JSON.stringify({ op: 'send', requestId: 'bad', destination: 'all', eventName: '.update', body: null }), 'bad'],
    ['missing event', JSON.stringify({ op: 'send', requestId: 'bad', destination: 'all', eventName: 'addon.', body: null }), 'bad'],
    ['missing body', JSON.stringify({ op: 'send', requestId: 'bad', destination: 'all', eventName }), 'bad'],
];

for (const [name, raw, requestId] of malformed) {
    test(`malformed ${name} returns invalid_request while retaining the connection and chat`, async t => {
        const { connect } = setup(t);
        const client = connect('host');
        await join(client);
        clear(client);
        await client.connection.receive(raw);
        const results = client.messages.filter(message => message.op === 'result');
        assert.equal(results.length, 1);
        assert.equal(results[0].requestId, requestId);
        failure(results[0], 'invalid_request');
        assert.deepEqual(events(client), []);
        success(await send(client, 'owner'));
        delivered(client, { value: 1 }, sender(client));
    });
}

for (const name of ['multiplayer.owner.changed', 'multiplayer.lorebooks.changed', 'multiplayer.participant.left', 'bus.connected', 'bus.disconnected', 'bus.status']) {
    test(`clients cannot publish reserved ${name}`, async t => {
        const { connect } = setup(t);
        const client = connect();
        await join(client);
        clear(client);
        for (const destination of ['all', 'server', 'owner', client.connection.id]) {
            const result = await send(client, destination, {}, name);
            assert.equal(result.ok, false);
            assert.equal(typeof result.error?.message, 'string');
        }
        assert.deepEqual(events(client, name), []);
    });
}

test('server handlers receive independent deep copies in registration order without waiting for completion', async t => {
    const { bus, connect, logs } = setup(t);
    const client = connect();
    await join(client);
    const gate = deferred();
    t.after(() => gate.resolve());
    const seen = [];
    bus.on(eventName, (identity, source, body) => {
        seen.push('first');
        identity.chatId = 'mutated';
        source.accountId = 'mutated';
        body.nested.value = 'mutated';
        return gate.promise;
    });
    bus.on(eventName, () => { seen.push('throw'); throw new Error('sync failure'); });
    bus.on(eventName, async () => { seen.push('reject'); throw new Error('async failure'); });
    bus.on(eventName, (...args) => seen.push(args));
    const body = { nested: { value: 'original' } };
    success(await send(client, 'server', body));
    assert.deepEqual(seen, ['first', 'throw', 'reject', [chat, sender(client), body]]);
    assert.deepEqual(events(client), []);
    await setImmediate();
    assert.equal(logs.length, 2);
    success(await send(client, 'all', body));
    delivered(client, body, sender(client));
});

test('unsubscription removes only that registration and unknown server events are accepted', async t => {
    const { bus, connect } = setup(t);
    const client = connect();
    await join(client);
    const seen = [];
    const handler = () => seen.push('called');
    const unsubscribe = bus.on(eventName, handler);
    bus.on(eventName, handler);
    assert.equal(typeof unsubscribe, 'function');
    unsubscribe();
    unsubscribe();
    success(await send(client, 'server'));
    assert.deepEqual(seen, ['called']);
    success(await send(client, 'server', null, 'another.unregistered'));
});

test('server send uses explicit chat, null sender and acceptance-only promise semantics', async t => {
    const { bus, connect } = setup(t);
    const owner = connect('host');
    const other = connect('host');
    await join(owner);
    await join(other, otherChat);
    const body = { nested: [1, 2] };
    assert.equal(await bus.send(chat, 'owner', eventName, body), undefined);
    delivered(owner, body, null);
    assert.deepEqual(events(other), []);
    const gate = deferred();
    t.after(() => gate.resolve());
    const seen = [];
    bus.on(eventName, (...args) => { seen.push(args); return gate.promise; });
    assert.equal(await bus.send(otherChat, 'server', eventName, body), undefined);
    assert.deepEqual(seen, [[otherChat, null, body]]);
    await assert.rejects(bus.send(chat, other.connection.id, eventName, body), { code: 'connection_unavailable' });
});

test('delivery callbacks cannot mutate another recipient envelope or retained chat state', async t => {
    const { bus, connect } = setup(t);
    const mutator = connect('host', envelope => {
        if (envelope.op === 'event' && envelope.eventName === eventName) {
            envelope.chat.chatId = 'corrupted';
            envelope.body.nested.value = 'corrupted';
            if (envelope.sender) {
                envelope.sender.accountId = 'corrupted';
            }
        }
    });
    const recipient = connect();
    await join(mutator);
    await join(recipient);
    const body = { nested: { value: 'safe' } };
    success(await send(mutator, 'all', body));
    delivered(recipient, body, sender(mutator));
    clear(recipient);
    await bus.send(chat, 'all', eventName, body);
    delivered(recipient, body, null);
    assert.deepEqual(body, { nested: { value: 'safe' } });
});

test('a throwing delivery callback does not prevent other recipients from receiving accepted sends', async t => {
    const { connect } = setup(t);
    const broken = connect('guest', envelope => {
        if (envelope.op === 'event') {
            throw new Error('transport failed');
        }
    });
    const healthy = connect();
    await join(broken);
    await join(healthy);
    success(await send(healthy));
    delivered(healthy, { value: 1 }, sender(healthy));
});

test('lorebook contributions replace only the authenticated account and deduplicate qualified names', async t => {
    const { connect } = setup(t);
    const owner = connect('host');
    const guest = connect();
    await join(owner);
    await join(guest);
    await contribute(owner, ['shared.json', 'host.json']);
    await contribute(guest, ['shared.json', 'shared.json'], { accountId: 'forged' });
    assert.deepEqual(sortedBooks(books(owner)), sortedBooks([
        { accountId: 'host', filename: 'shared.json' },
        { accountId: 'host', filename: 'host.json' },
        { accountId: 'guest', filename: 'shared.json' },
    ]));
    await contribute(guest, ['replacement.json']);
    const expected = [
        { accountId: 'host', filename: 'shared.json' },
        { accountId: 'host', filename: 'host.json' },
        { accountId: 'guest', filename: 'replacement.json' },
    ];
    assert.deepEqual(sortedBooks(books(owner)), sortedBooks(expected));
    assert.deepEqual(sortedBooks((await join(connect('newcomer'))).lorebooks), sortedBooks(expected));
    await contribute(guest, []);
    assert.deepEqual(sortedBooks(books(owner)), sortedBooks(expected.slice(0, 2)));
});

test('only the selected owning-account connection can update its contribution, including after handoff', async t => {
    const { connect } = setup(t);
    const owner = connect('host');
    const secondary = connect('host');
    const guest = connect();
    await join(owner);
    await join(secondary);
    await join(guest);
    await contribute(owner, ['original.json']);
    clear(owner, secondary, guest);
    await contribute(secondary, ['ignored.json']);
    assert.deepEqual(events(guest, 'multiplayer.lorebooks.changed'), []);
    assert.deepEqual((await join(guest)).lorebooks, [{ accountId: 'host', filename: 'original.json' }]);
    owner.connection.disconnect();
    await contribute(secondary, ['replacement.json']);
    assert.deepEqual(books(guest), [{ accountId: 'host', filename: 'replacement.json' }]);
});

for (const departure of ['leave', 'disconnect', 'switch']) {
    test(`lorebooks survive one same-account departure and disappear on its last ${departure}`, async t => {
        const { connect } = setup(t);
        const observer = connect('observer');
        const first = connect();
        const last = connect();
        await join(observer);
        await join(first);
        await join(last);
        await contribute(first, ['guest.json']);
        clear(observer);
        first.connection.disconnect();
        await setImmediate();
        assert.deepEqual(events(observer, 'multiplayer.lorebooks.changed'), []);
        assert.deepEqual((await join(observer)).lorebooks, [{ accountId: 'guest', filename: 'guest.json' }]);
        if (departure === 'disconnect') {
            last.connection.disconnect();
            await setImmediate();
        } else if (departure === 'switch') {
            await join(last, otherChat);
        } else {
            success(await request(last, { op: 'leave' }));
        }
        assert.deepEqual(books(observer), []);
    });
}

test('unchanged lorebook sets do not broadcast redundant combined-list updates', async t => {
    const { connect } = setup(t);
    const client = connect();
    await join(client);
    await contribute(client, ['book.json']);
    clear(client);
    await contribute(client, ['book.json', 'book.json']);
    assert.deepEqual(events(client, 'multiplayer.lorebooks.changed'), []);
    assert.deepEqual((await join(client)).lorebooks, [{ accountId: 'guest', filename: 'book.json' }]);
});

test('last departure discards contributions and reconnecting creates fresh state without replay', async t => {
    const { connect } = setup(t);
    const old = connect('host');
    await join(old);
    await contribute(old, ['old.json']);
    success(await send(old));
    old.connection.disconnect();
    const fresh = connect('host');
    assert.notEqual(fresh.connection.id, old.connection.id);
    assert.deepEqual(await join(fresh), { isOwner: true, ownerPresent: true, lorebooks: [] });
    assert.deepEqual(events(fresh), []);
});

test('disconnect during pending authorization cannot resurrect membership', async t => {
    const gate = deferred();
    const { bus, connect } = setup(t, () => gate.promise);
    const client = connect('host');
    const pending = client.connection.receive(JSON.stringify({ op: 'join', requestId: 'pending', ...chat }));
    await setImmediate();
    client.connection.disconnect();
    gate.resolve();
    await pending;
    await assert.rejects(bus.send(chat, client.connection.id, eventName, null), { code: 'connection_unavailable' });
    assert.deepEqual(events(client), []);
});

test('disconnected senders cannot submit events or authorize another join', async t => {
    const authorizations = [];
    const { bus, connect } = setup(t, async (...args) => authorizations.push(args));
    const client = connect();
    const observer = connect('observer');
    await join(client);
    await join(observer);
    const seen = [];
    bus.on(eventName, (...args) => seen.push(args));
    client.connection.disconnect();
    clear(client, observer);
    const count = authorizations.length;
    await client.connection.receive(JSON.stringify({ op: 'send', requestId: 'closed-send', destination: 'all', eventName, body: null }));
    await client.connection.receive(JSON.stringify({ op: 'send', requestId: 'closed-server', destination: 'server', eventName, body: null }));
    await client.connection.receive(JSON.stringify({ op: 'join', requestId: 'closed-join', ...chat }));
    assert.equal(authorizations.length, count);
    assert.deepEqual(seen, []);
    assert.deepEqual(client.messages, []);
    assert.deepEqual(observer.messages, []);
});

test('disconnect discards sends queued behind a pending join', async t => {
    const gate = deferred();
    const { connect } = setup(t, async accountId => {
        if (accountId === 'guest') {
            await gate.promise;
        }
    });
    const observer = connect('observer');
    await join(observer);
    const client = connect();
    const pendingJoin = client.connection.receive(JSON.stringify({ op: 'join', requestId: 'joining', ...chat }));
    const pendingSend = client.connection.receive(JSON.stringify({ op: 'send', requestId: 'queued', destination: 'all', eventName, body: null }));
    await setImmediate();
    client.connection.disconnect();
    clear(observer);
    gate.resolve();
    await Promise.all([pendingJoin, pendingSend]);
    assert.deepEqual(client.messages, []);
    assert.deepEqual(observer.messages, []);
});

test('shutdown while authorization is pending never recreates chat or delivers a late result', async t => {
    const gate = deferred();
    const { bus, connect } = setup(t, () => gate.promise);
    const client = connect('host');
    const pending = client.connection.receive(JSON.stringify({ op: 'join', requestId: 'joining', ...chat }));
    await setImmediate();
    bus.close();
    gate.resolve();
    await pending;
    assert.deepEqual(client.messages, []);
    await assert.rejects(bus.send(chat, client.connection.id, eventName, null), { code: 'connection_unavailable' });
    assert.throws(() => connect(), { code: 'connection_unavailable' });
});

test('close clears connected routing targets and repeated cleanup is safe', async t => {
    const { bus, connect } = setup(t);
    const client = connect();
    await join(client);
    bus.close();
    bus.close();
    client.connection.disconnect();
    await assert.rejects(bus.send(chat, client.connection.id, eventName, null), { code: 'connection_unavailable' });
    assert.deepEqual(events(client), []);
});

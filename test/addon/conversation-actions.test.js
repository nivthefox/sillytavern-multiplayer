import test from 'node:test';
import assert from 'node:assert/strict';

const api = await import('../../addon/conversation-actions.js').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') { throw error; }
    return {};
});
const id = '5ad90182-f1e2-4f6b-a143-c9d20d0b20d1';
const sender = { accountId: 'guest', connectionId: 'guest-tab' };
const message = () => ({ mes: 'Prepared {{text}}', name: 'PC', force_avatar: '/api/plugins/multiplayer/accounts/guest/personas/PC%20one.png', send_date: 'date', is_user: true, is_system: false, extra: { extension: { value: 3 }, multiplayer: { messageId: id, accountId: 'forged' } } });

function setup(initial = [], saveStatus = 'saved') {
    assert.equal(typeof api.createConversationActions, 'function', 'authoritative action queue is implemented');
    let messages = structuredClone(initial);
    let saved = structuredClone(initial);
    const events = [];
    const operations = [];
    const localFailures = [];
    const native = {
        getMessages: () => messages,
        loadSaved: async () => { operations.push('load'); messages = structuredClone(saved); return messages; },
        insertMessage: async value => { messages.push(value); operations.push('insert'); },
        deleteMessage: async (index, { bulk }) => { messages.splice(index, bulk ? messages.length - index : 1); operations.push('delete'); },
        editMessage: async (index, text) => { messages[index].mes = text; operations.push('edit'); },
        render: async () => { operations.push('render'); },
        save: async () => { operations.push('save'); if (saveStatus === 'saved') { saved = structuredClone(messages); } return { status: saveStatus }; },
    };
    const queue = api.createConversationActions({ native, accountId: 'owner', bus: { send: async (...args) => events.push(args) }, onLocalFailure: (...args) => localFailures.push(args) });
    queue.setAuthority(true);
    return { queue, native, events, operations, localFailures, messages: () => messages, saved: () => saved };
}

test('accepted guest turn preserves preparation and attributes authenticated account before saving', async () => {
    const h = setup();
    await h.queue.enqueue('send', { message: message(), iteration: 0 }, sender);
    assert.equal(h.saved()[0].mes, 'Prepared {{text}}');
    assert.equal(h.saved()[0].send_date, 'date');
    assert.deepEqual(h.saved()[0].extra.extension, { value: 3 });
    assert.equal(h.saved()[0].extra.multiplayer.accountId, 'guest');
    assert.deepEqual(h.events, [['all', 'multiplayer.chat.saved', {}]]);
});

test('portrait cannot retain a different account source', async () => {
    const h = setup();
    const prepared = message();
    prepared.force_avatar = '/api/plugins/multiplayer/accounts/forged/personas/PC%20one.png';
    await h.queue.enqueue('send', { message: prepared, iteration: 0 }, sender);
    assert.equal(h.saved()[0].force_avatar, '/api/plugins/multiplayer/accounts/guest/personas/PC%20one.png');
});

for (const patch of [{ is_user: false }, { is_system: true }, { mes: 5 }, { extra: {} }]) {
    test(`malformed message is rejected: ${JSON.stringify(patch)}`, async () => {
        const h = setup();
        await h.queue.enqueue('send', { message: { ...message(), ...patch }, iteration: 0 }, sender);
        assert.deepEqual(h.saved(), []);
        assert.ok(!h.operations.includes('save'));
    });
}

test('guest and local actions share one save-completion queue', async () => {
    const h = setup();
    let release;
    h.native.save = () => new Promise(resolve => { release = () => resolve({ status: 'saved' }); });
    const first = h.queue.enqueue('send', { message: message(), iteration: 0 }, sender);
    await new Promise(resolve => setImmediate(resolve));
    const secondMessage = message();
    secondMessage.extra.multiplayer.messageId = '121c9cf0-9998-4e80-a831-0d474a99d2fa';
    const second = h.queue.enqueue('send', { message: secondMessage, iteration: 0 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.messages().length, 1);
    assert.equal(h.operations.includes('render'), false, 'unsaved native messages must not duplicate pending overlays');
    release();
    await first;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.messages().length, 2);
    release();
    await second;
    assert.equal(h.messages()[1].extra.multiplayer.accountId, 'owner');
});

for (const status of ['failed', 'uncertain', undefined]) {
    test(`save outcome ${status} is not a successful notification`, async () => {
        const h = setup([], status ?? 'saved');
        if (status === undefined) { h.native.save = async () => undefined; }
        await h.queue.enqueue('send', { message: message(), iteration: 0 }, sender);
        assert.ok(!h.events.some(event => event[1] === 'multiplayer.chat.saved'));
        if (status === 'failed') {
            assert.deepEqual(h.messages(), []);
            assert.equal(h.events[0][0], 'guest-tab');
            assert.equal(h.events[0][1], 'multiplayer.message.send_failure');
            assert.equal(h.events[0][2].iteration, 0);
        } else {
            assert.deepEqual(h.events, []);
        }
    });
}

test('player edits retain original and independent revision metadata', async () => {
    const original = message(); original.extra.multiplayer.accountId = 'guest';
    const h = setup([original]);
    await h.queue.enqueue('edit', { messageId: id, text: 'one', iteration: 0 }, sender);
    await h.queue.enqueue('edit', { messageId: id, text: 'two', iteration: 0 }, sender);
    const edited = h.messages()[0];
    assert.deepEqual(edited.swipes, [original.mes, 'one', 'two']);
    assert.equal(edited.swipe_id, 2);
    assert.equal(edited.mes, 'two');
    assert.equal(edited.swipe_info[0].send_date, 'date');
    assert.equal(edited.swipe_info[2].extra.multiplayer.messageId, id);
    edited.swipe_info[2].extra.extension.value = 99;
    assert.equal(edited.swipe_info[0].extra.extension.value, 3);
    assert.equal(edited.extra.extension.value, 3);
    assert.equal(edited.swipe_info[2].gen_started, undefined);
});

for (const type of ['edit', 'delete']) {
    test(`${type} rejects another account and AI targets, including owning-account remote tab`, async () => {
        for (const target of [message(), { ...message(), is_user: false }]) {
            const h = setup([target]);
            await h.queue.enqueue(type, { messageId: id, text: 'changed', iteration: 0 }, { accountId: 'owner', connectionId: 'other-owner' });
            assert.deepEqual(h.saved(), [target]);
            assert.equal(h.events[0][1], `multiplayer.message.${type}_failure`);
        }
    });
}

test('owner cannot edit guest text but can delete any message and bulk-delete locally', async () => {
    const h = setup([message(), message()]);
    await h.queue.enqueue('edit', { messageId: id, text: 'changed', iteration: 0 });
    assert.equal(h.messages()[0].mes, message().mes);
    assert.equal(h.localFailures.length, 1);
    await h.queue.enqueue('delete', { messageId: id, bulk: true, iteration: 0 });
    assert.deepEqual(h.saved(), []);
});

test('remote bulk deletion is rejected without partial mutation', async () => {
    const own = message(); own.extra.multiplayer.accountId = 'guest';
    const h = setup([own]);
    await h.queue.enqueue('delete', { messageId: id, bulk: true, iteration: 0 }, sender);
    assert.deepEqual(h.saved(), [own]);
    assert.equal(h.events[0][1], 'multiplayer.message.delete_failure');
});

test('deleted edit target fails while absent delete confirms directly without saving', async () => {
    const h = setup();
    await h.queue.enqueue('edit', { messageId: id, text: 'changed', iteration: 2 }, sender);
    assert.deepEqual(h.events[0], ['guest-tab', 'multiplayer.message.edit_failure', { messageId: id, text: 'changed', iteration: 2, reason: 'This message has been deleted.' }]);
    await h.queue.enqueue('delete', { messageId: id, iteration: 0 }, sender);
    assert.deepEqual(h.events[1], ['guest-tab', 'multiplayer.chat.saved', {}]);
    assert.ok(!h.operations.includes('save'));
});

test('retry checks disk and acknowledges already saved turn without reinsertion', async () => {
    const original = message(); original.extra.multiplayer.accountId = 'guest';
    const h = setup([original]);
    await h.queue.enqueue('send', { message: message(), iteration: 1 }, sender);
    assert.equal(h.messages().length, 1);
    assert.ok(h.operations.includes('load'));
    assert.ok(!h.operations.includes('insert'));
    assert.deepEqual(h.events, [['guest-tab', 'multiplayer.chat.saved', {}]]);
});

test('generation rejects action at arrival rather than postponing it', async () => {
    const h = setup();
    h.queue.setGenerating(true);
    const pending = h.queue.enqueue('send', { message: message(), iteration: 0 }, sender);
    h.queue.setGenerating(false);
    await pending;
    assert.deepEqual(h.messages(), []);
    assert.equal(h.events[0][1], 'multiplayer.message.send_failure');
});

test('revoked authority cannot apply queued changes or begin generation', async () => {
    const h = setup();
    h.queue.setAuthority(false);
    await h.queue.enqueue('send', { message: message(), iteration: 0 }, sender);
    let generated = false;
    await h.queue.runGeneration(() => { generated = true; });
    assert.equal(generated, false);
    assert.deepEqual(h.operations, []);
});

test('confirmed failure is reported even when restoring disk state fails, and later changes remain blocked', async () => {
    const h = setup([], 'failed');
    h.native.loadSaved = async () => { throw new Error('Read unavailable'); };
    await assert.rejects(h.queue.enqueue('send', { message: message(), iteration: 0 }, sender), /Read unavailable/);
    assert.equal(h.events[0]?.[1], 'multiplayer.message.send_failure');
    const next = message(); next.extra.multiplayer.messageId = '121c9cf0-9998-4e80-a831-0d474a99d2fa';
    await assert.rejects(h.queue.enqueue('send', { message: next, iteration: 0 }, sender), /Read unavailable/);
    assert.equal(h.messages().length, 1);
    assert.equal(h.operations.filter(operation => operation === 'save').length, 1);
});

test('edit confirmation matches current text, never historical swipe', () => {
    assert.equal(typeof api.confirmAction, 'function');
    const target = message(); target.swipes = ['old', target.mes];
    assert.equal(api.confirmAction('edit', { messageId: id, text: 'old' }, [target]), false);
    assert.equal(api.confirmAction('edit', { messageId: id, text: target.mes }, [target]), true);
    assert.equal(api.confirmAction('delete', { messageId: id }, []), true);
});

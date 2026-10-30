import assert from 'node:assert/strict';
import { test } from 'node:test';
const { createConversationSession } = await import('../../addon/conversation-session.js').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') {
        throw error;
    }
    return {};
});

const chat = { accountId: 'owner', groupId: 'group', chatId: 'scene' };
const owner = { accountId: 'owner', connectionId: 'owner-connection' };
const guest = { accountId: 'guest', connectionId: 'guest-connection' };
const messageId = 'dfe18217-1820-49e0-900e-864941ba03aa';

function message(mes = 'Prepared turn', id = messageId) {
    return {
        mes, name: 'Player', force_avatar: '/api/plugins/multiplayer/accounts/guest/personas/pc.png',
        is_user: true, is_system: false, send_date: '2026-10-30T20:00:00.000Z',
        extra: { multiplayer: { messageId: id, accountId: 'guest' }, extension: { retained: true } },
    };
}

function fixture({ isOwner = false, ownerPresent = true, messages = [] } = {}) {
    const handlers = new Map();
    const sends = [];
    const loads = [];
    const actions = [];
    const renders = [];
    const errors = [];
    let saved = structuredClone(messages);
    let stops = 0;
    let joins = 0;
    let leaves = 0;
    let sendError;
    const bus = {
        async connect() {},
        async join(identity) {
            joins++;
            assert.deepEqual(identity, chat);
            return { isOwner, ownerPresent, lorebooks: [] };
        },
        async leave() { leaves++; },
        async send(...args) {
            sends.push(structuredClone(args));
            if (sendError) {
                throw sendError;
            }
        },
        on(name, handler) {
            const listeners = handlers.get(name) ?? new Set();
            handlers.set(name, listeners);
            listeners.add(handler);
            return () => listeners.delete(handler);
        },
    };
    assert.equal(typeof createConversationSession, 'function', 'conversation-session.js exports createConversationSession');
    const session = createConversationSession({
        bus,
        async loadChat(identity, options) {
            loads.push({ chat: identity, ...options });
            return structuredClone(saved);
        },
        render(snapshot) { renders.push(structuredClone(snapshot)); },
        onAction(action) { actions.push(structuredClone(action)); },
        stopAuthority() { stops++; },
        onError(error) { errors.push(error); },
    });
    return {
        session, sends, loads, actions, renders, errors, bus,
        setSaved(value) { saved = structuredClone(value); },
        failSend(error) { sendError = error; },
        get stops() { return stops; },
        get joins() { return joins; },
        get leaves() { return leaves; },
        async emit(name, body, sender = owner, identity = chat) {
            await Promise.all([...handlers.get(name) ?? []].map(handler => handler(identity, sender, body)));
        },
    };
}

async function open(options) {
    const harness = fixture(options);
    await harness.session.open(chat);
    return harness;
}

test('join adopts authority, loads guest saved chat and requests current generation status', async () => {
    const h = await open();
    assert.equal(h.joins, 1);
    assert.deepEqual(h.loads, [{ chat, isOwner: false }]);
    assert.equal(h.session.getState().canChange, true);
    assert.equal(h.session.getState().isOwner, false);
    assert.deepEqual(h.sends, [['owner', 'multiplayer.generation.status_request', {}]]);
});

test('ownerless chat remains readable but rejects changes', async () => {
    const h = await open({ ownerPresent: false, messages: [message()] });
    assert.deepEqual(h.session.getState().messages, [message()]);
    assert.equal(h.session.getState().canChange, false);
    await assert.rejects(async () => h.session.submit('send', { message: message() }));
    assert.deepEqual(h.sends, []);
});

for (const [type, body] of [
    ['send', { message: message() }],
    ['edit', { messageId, text: 'Prepared edit' }],
    ['delete', { messageId }],
]) {
    test(`${type} starts at iteration zero and routing acceptance is not persistence`, async () => {
        const h = await open({ messages: type === 'send' ? [] : [message()] });
        const id = await h.session.submit(type, body);
        assert.deepEqual(h.sends.at(-1), ['owner', `multiplayer.message.${type}`, { ...body, iteration: 0 }]);
        assert.deepEqual(h.session.getState().pending, [{ id, type, body: { ...body, iteration: 0 }, status: 'pending' }]);
        assert.deepEqual(h.actions, []);
        await h.emit('multiplayer.chat.saved', {});
        assert.equal(h.session.getState().pending.length, 1);
    });

    test(`${type} confirms only its persisted outcome`, async () => {
        const h = await open({ messages: type === 'send' ? [] : [message()] });
        await h.session.submit(type, body);
        h.setSaved(type === 'delete' ? [] : [message(type === 'edit' ? body.text : 'Saved turn')]);
        await h.emit('multiplayer.chat.saved', {});
        assert.deepEqual(h.session.getState().pending, []);
    });

    test(`${type} explicit failure supports exact prepared retry and ignores old failure`, async () => {
        const h = await open({ messages: [message()] });
        const id = await h.session.submit(type, body);
        const failure = { messageId, iteration: 0, reason: 'Save rejected', ...(type === 'edit' ? { text: body.text } : {}) };
        await h.emit(`multiplayer.message.${type}_failure`, failure);
        assert.equal(h.session.getState().pending[0].status, 'failed');
        await h.session.retry(id);
        assert.deepEqual(h.sends.at(-1), ['owner', `multiplayer.message.${type}`, { ...body, iteration: 1 }]);
        await h.emit(`multiplayer.message.${type}_failure`, failure);
        assert.equal(h.session.getState().pending[0].status, 'pending');
        await h.emit(`multiplayer.message.${type}_failure`, { ...failure, iteration: 1 });
        h.session.discard(id);
        assert.deepEqual(h.session.getState().pending, []);
        assert.deepEqual(h.session.getState().messages, [message()]);
    });
}

test('edit history alone does not confirm current replacement text', async () => {
    const h = await open({ messages: [message()] });
    await h.session.submit('edit', { messageId, text: 'Attempted' });
    h.setSaved([{ ...message('Superseded'), swipes: ['Attempted', 'Superseded'] }]);
    await h.emit('multiplayer.chat.saved', {});
    await h.emit('multiplayer.message.edit_failure', { messageId, iteration: 0, text: 'Different', reason: 'Rejected' });
    await h.emit('multiplayer.message.delete_failure', { messageId, iteration: 0, reason: 'Rejected' });
    assert.equal(h.session.getState().pending[0].status, 'pending');
});

test('unknown send outcome remains pending and reconnect reload does not resend or rejoin', async () => {
    const h = await open();
    h.failSend(Object.assign(new Error('Unknown outcome'), { code: 'unknown_outcome' }));
    await h.session.submit('send', { message: message() });
    const sentActions = () => h.sends.filter(([, name]) => name === 'multiplayer.message.send');
    await h.emit('bus.disconnected', null, null, null);
    assert.equal(h.session.getState().canChange, false);
    assert.equal(h.session.getState().pending[0].status, 'pending');
    h.failSend(undefined);
    await h.emit('bus.status', { isOwner: false, ownerPresent: true }, null);
    assert.equal(h.joins, 1);
    assert.equal(sentActions().length, 1);
    assert.equal(h.loads.length, 2);
    assert.equal(h.session.getState().pending[0].status, 'pending');
    h.setSaved([message()]);
    await h.emit('bus.disconnected', null, null, null);
    await h.emit('bus.status', { isOwner: false, ownerPresent: true }, null);
    assert.deepEqual(h.session.getState().pending, []);
    assert.equal(sentActions().length, 1);
});

test('local owner actions and received requests delegate to the same authoritative handler', async () => {
    const h = await open({ isOwner: true });
    const body = { message: message() };
    await h.session.submit('send', body);
    await h.emit('multiplayer.message.edit', { messageId, text: 'Edit', iteration: 0 }, guest);
    assert.deepEqual(h.actions, [
        { type: 'send', body: { ...body, iteration: 0 }, sender: null },
        { type: 'edit', body: { messageId, text: 'Edit', iteration: 0 }, sender: guest },
    ]);
    assert.deepEqual(h.sends, []);
    assert.deepEqual(h.loads, [{ chat, isOwner: true }]);
});

test('non-authoritative owning-account tab does not process remote actions', async () => {
    const h = await open();
    await h.emit('multiplayer.message.send', { message: message(), iteration: 0 }, guest);
    assert.deepEqual(h.actions, []);
});

for (const event of ['disconnect', 'revoke', 'leave']) {
    test(`authority ${event} immediately stops native generation and queue work`, async () => {
        const h = await open({ isOwner: true });
        if (event === 'disconnect') {
            await h.emit('bus.disconnected', null, null, null);
        } else if (event === 'revoke') {
            await h.emit('bus.status', { isOwner: false, ownerPresent: true }, null);
        } else {
            await h.session.close();
            assert.equal(h.leaves, 1);
        }
        assert.equal(h.stops, 1);
        await h.emit('multiplayer.message.send', { message: message(), iteration: 0 }, guest);
        assert.deepEqual(h.actions, []);
    });
}

test('replacement authority reloads saved chat via native owner path', async () => {
    const h = await open();
    await h.emit('bus.status', { isOwner: true, ownerPresent: true }, null);
    assert.deepEqual(h.loads.at(-1), { chat, isOwner: true });
    assert.equal(h.session.getState().isOwner, true);
});

test('generation status blocks changes and previews replace accumulated text then yield to saved identity', async () => {
    const h = await open();
    await h.emit('multiplayer.generation.status', { generating: true });
    assert.equal(h.session.getState().canChange, false);
    await assert.rejects(async () => h.session.submit('delete', { messageId }));
    const preview = { messageId, name: 'GM', force_avatar: '/gm.png', text: 'First' };
    await h.emit('multiplayer.generation.preview', preview);
    await h.emit('multiplayer.generation.preview', { ...preview, text: 'First second' });
    assert.deepEqual(h.session.getState().previews, [{ ...preview, text: 'First second' }]);
    h.setSaved([{ ...message('First second'), is_user: false }]);
    await h.emit('multiplayer.chat.saved', {});
    assert.deepEqual(h.session.getState().previews, []);
    assert.equal(h.session.getState().messages.length, 1);
    await h.emit('multiplayer.generation.status', { generating: false });
    assert.equal(h.session.getState().canChange, true);
});

test('owner change clears interrupted previews even when replacement keeps owner present', async () => {
    const h = await open({ messages: [message()] });
    await h.emit('multiplayer.generation.status', { generating: true });
    await h.emit('multiplayer.generation.preview', { messageId: 'ai', name: 'GM', force_avatar: '/gm.png', text: 'Partial' });
    await h.emit('multiplayer.owner.changed', {}, null);
    assert.deepEqual(h.session.getState().previews, []);
    assert.equal(h.session.getState().generating, false);
    assert.equal(h.session.getState().interruption, 'AI generation interrupted.');
    assert.deepEqual(h.session.getState().messages, [message()]);
    assert.deepEqual(h.sends.at(-1), ['owner', 'multiplayer.generation.status_request', {}]);
});

test('owner publishes generation boundaries and responds to status requests without receiving own previews', async () => {
    const h = await open({ isOwner: true });
    await h.session.generationStatus(true);
    await h.emit('multiplayer.generation.status_request', {}, guest);
    const preview = { messageId, name: 'GM', force_avatar: '/gm.png', text: 'Response' };
    await h.session.generationPreview(preview);
    await h.emit('multiplayer.generation.preview', preview);
    await h.session.generationStatus(false);
    await h.session.saved();
    await h.emit('multiplayer.chat.saved', {});
    assert.deepEqual(h.sends, [
        ['all', 'multiplayer.generation.status', { generating: true }],
        ['all', 'multiplayer.generation.status', { generating: true }],
        ['all', 'multiplayer.generation.preview', preview],
        ['all', 'multiplayer.generation.status', { generating: false }],
        ['all', 'multiplayer.chat.saved', {}],
    ]);
    assert.deepEqual(h.session.getState().previews, []);
    assert.equal(h.loads.length, 1);
});

test('closed controller unsubscribes and ignores later events', async () => {
    const h = await open();
    await h.session.close();
    const count = h.renders.length;
    await h.emit('multiplayer.chat.saved', {});
    await h.emit('bus.status', { isOwner: true, ownerPresent: true }, null);
    assert.equal(h.loads.length, 1);
    assert.equal(h.renders.length, count);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountConversations } from '../../addon/conversation-bootstrap.js';

const id = '5ad90182-f1e2-4f6b-a143-c9d20d0b20d1';
const chat = { accountId: 'owner', groupId: 'g', chatId: 'c' };

async function fixture(t, isOwner = true) {
    const dom = new JSDOM('<textarea id="send_textarea"></textarea><button id="send_but"></button><div id="chat"></div><button id="option_continue"></button><div class="group_member" data-chid="0"><button data-action="speak"></button></div>', { url: 'http://localhost/' });
    const events = new Map();
    const handlers = new Map();
    const sent = [];
    const saves = [];
    const generated = [];
    let saved = [];
    const native = {
        groups: [{ id: 'g', chat_id: 'c', multiplayer: { owner: 'owner', accounts: ['guest'] } }], selectedGroup: 'g', chat: [], chat_metadata: {},
        event_types: { CHAT_CHANGED: 'changed', MESSAGE_RECEIVED: 'received', STREAM_TOKEN_RECEIVED: 'stream', GROUP_WRAPPER_STARTED: 'started', GROUP_WRAPPER_FINISHED: 'finished' },
        eventSource: { on(name, listener) { const list = events.get(name) ?? []; list.push(listener); events.set(name, list); }, removeListener() {}, async emit(name, ...args) { for (const listener of events.get(name) ?? []) { await listener(...args); } } },
        name1: 'PC', user_avatar: 'pc.png', power_user: {}, regex_placement: { USER_INPUT: 1 },
        getBiasStrings: () => ({}), getRegexedString: text => text, substituteParams: text => text,
        getMessageTimeStamp: () => 'now', populateFileAttachment: async () => {}, processCommands: async text => text.startsWith('/'),
        async getGroupChat() { native.chat.splice(0, native.chat.length, ...structuredClone(saved)); },
        async clearChat({ clearData = false } = {}) { if (clearData) { native.chat.splice(0); } dom.window.document.querySelector('#chat').replaceChildren(); },
        updateChatMetadata() {},
        async printMessages() { for (const [index, message] of native.chat.entries()) { const node = dom.window.document.createElement('div'); node.className = 'mes'; node.setAttribute('mesid', index); node.textContent = message.mes; dom.window.document.querySelector('#chat').append(node); } },
        async saveChatConditional() { await dom.window.fetch('/api/chats/group/save', { method: 'POST', body: JSON.stringify({ id: 'c', chat: native.chat }) }); },
        async Generate(...args) { generated.push(args); }, stopGeneration() {}, shouldSendOnEnter: () => true, isPopupOpen: () => false,
    };
    dom.window.fetch = async (url, options) => {
        if (url === '/api/chats/group/save') { saves.push(JSON.parse(options.body)); saved = structuredClone(native.chat); return Response.json({ result: 'ok' }); }
        return Response.json(saved);
    };
    const bus = {
        async connect() {}, async join() { return { isOwner, ownerPresent: true }; }, async leave() {},
        async send(...args) { sent.push(args); },
        on(name, listener) { const list = handlers.get(name) ?? []; list.push(listener); handlers.set(name, list); return () => { handlers.set(name, list.filter(value => value !== listener)); }; },
    };
    const integration = await mountConversations({ native, window: dom.window, document: dom.window.document, accountId: isOwner ? 'owner' : 'guest', bus });
    t.after(async () => { await integration.dispose(); dom.window.close(); });
    return { integration, native, dom, sent, saves, generated, async emit(name, body, sender = { accountId: 'guest', connectionId: 'tab' }) { for (const listener of handlers.get(name) ?? []) { await listener(chat, sender, body); } } };
}

async function settle() { for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); } }

test('mounted owner text submission prepares and saves without generating or bus action request', async t => {
    const h = await fixture(t);
    h.dom.window.document.querySelector('#send_textarea').value = 'turn';
    h.dom.window.document.querySelector('#send_but').click();
    await settle();
    assert.equal(h.saves.length, 1);
    assert.equal(h.saves[0].chat[0].extra.multiplayer.accountId, 'owner');
    assert.deepEqual(h.generated, []);
    assert.deepEqual(h.sent, [['all', 'multiplayer.chat.saved', {}]]);
    assert.equal(h.dom.window.document.querySelectorAll('.mes').length, 1);
    assert.deepEqual(h.integration.session.getState().pending, []);
});

test('mounted guest routes prepared text and never saves locally', async t => {
    const h = await fixture(t, false);
    h.dom.window.document.querySelector('#send_textarea').value = 'guest turn';
    h.dom.window.document.querySelector('#send_but').click();
    await settle();
    assert.equal(h.sent.at(-1)[1], 'multiplayer.message.send');
    assert.deepEqual(h.saves, []);
    assert.equal(h.integration.session.getState().pending.length, 1);
});

test('mounted Continue and member-trigger controls preserve native generation arguments', async t => {
    const h = await fixture(t);
    h.dom.window.document.querySelector('#option_continue').click();
    await settle();
    h.dom.window.document.querySelector('[data-action="speak"]').click();
    await settle();
    assert.deepEqual(h.generated, [['continue', {}], ['normal', { force_chid: 0 }]]);
});

test('mounted command processing does not add a second human turn', async t => {
    const h = await fixture(t);
    h.dom.window.document.querySelector('#send_textarea').value = '/echo hello';
    h.dom.window.document.querySelector('#send_but').click();
    await settle();
    assert.deepEqual(h.saves, []);
    assert.deepEqual(h.generated, []);
});

test('native generation saves notify viewers and assign AI identity before persistence', async t => {
    const h = await fixture(t);
    const ai = { mes: 'AI response', name: 'GM', is_user: false, extra: {} };
    h.native.chat.push(ai);
    await h.native.eventSource.emit('received', 0);
    await h.native.saveChatConditional();
    assert.match(h.saves[0].chat[0].extra.multiplayer.messageId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(h.sent, [['all', 'multiplayer.chat.saved', {}]]);
});

test('remote human turn is attributed and saved through the mounted owner queue', async t => {
    const h = await fixture(t);
    await h.emit('multiplayer.message.send', { iteration: 0, message: { mes: 'remote', name: 'PC', force_avatar: '/api/plugins/multiplayer/accounts/guest/personas/pc.png', send_date: 'then', is_user: true, is_system: false, extra: { multiplayer: { messageId: id } } } });
    assert.equal(h.saves[0].chat[0].extra.multiplayer.accountId, 'guest');
    assert.deepEqual(h.sent, [['all', 'multiplayer.chat.saved', {}]]);
});

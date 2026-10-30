import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountConversations } from '../../addon/conversation-bootstrap.js';

const id = '5ad90182-f1e2-4f6b-a143-c9d20d0b20d1';
const chat = { accountId: 'owner', groupId: 'g', chatId: 'c' };

async function fixture(t, isOwner = true) {
    const dom = new JSDOM('<textarea id="send_textarea"></textarea><button id="send_but"></button><div id="chat"></div><button id="option_continue"></button><button id="option_regenerate"></button><button class="swipe_right"></button><div class="group_member" data-chid="0"><button data-action="speak"></button></div>', { url: 'http://localhost/' });
    const events = new Map();
    const handlers = new Map();
    const sent = [];
    const saves = [];
    const generated = [];
    let saved = [];
    let failSave = false;
    const native = {
        groups: [{ id: 'g', chat_id: 'c', multiplayer: { owner: 'owner', accounts: ['guest'] } }], selectedGroup: 'g', chat: [], chat_metadata: {},
        event_types: { CHAT_CHANGED: 'changed', GENERATION_STARTED: 'generation-started', GENERATION_AFTER_COMMANDS: 'after-commands', GENERATION_STOPPED: 'stopped', MESSAGE_RECEIVED: 'received', STREAM_TOKEN_RECEIVED: 'stream', GROUP_WRAPPER_STARTED: 'started', GROUP_WRAPPER_FINISHED: 'finished' },
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
        if (url === '/api/chats/group/save' && failSave) { failSave = false; return Response.json({ error: 'save failed' }, { status: 500 }); }
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
    return { integration, native, dom, sent, saves, generated, failNextSave() { failSave = true; }, async emit(name, body, sender = { accountId: 'guest', connectionId: 'tab' }) { for (const listener of handlers.get(name) ?? []) { await listener(chat, sender, body); } } };
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

test('owner submission clears only its submitted draft before waiting for persistence', async t => {
    const h = await fixture(t);
    let finish;
    h.native.saveChatConditional = () => new Promise(resolve => { finish = resolve; });
    const composer = h.dom.window.document.querySelector('#send_textarea');
    composer.value = 'submitted';
    h.dom.window.document.querySelector('#send_but').click();
    await settle();
    assert.equal(composer.value, '');
    composer.value = 'next draft';
    finish();
    await settle();
    assert.equal(composer.value, 'next draft');
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

test('Regenerate preserves native group regeneration and right swipe selects native history', async t => {
    const h = await fixture(t);
    let regenerated = 0;
    let swiped = 0;
    h.native.regenerateGroup = async () => { regenerated++; };
    h.native.swipe_right = async () => { swiped++; };
    h.dom.window.document.querySelector('#option_regenerate').click();
    await settle();
    h.dom.window.document.querySelector('.swipe_right').click();
    await settle();
    assert.equal(regenerated, 1);
    assert.equal(swiped, 1);
    assert.deepEqual(h.generated, []);
});

test('native swipe receives the clicked message and awaits its persistence barrier', async t => {
    const h = await fixture(t);
    const target = { mes: 'older AI', is_user: false, extra: { multiplayer: { messageId: id } } };
    h.native.chat.push(target, { mes: 'last AI', is_user: false });
    h.integration.session.localSaved(h.native.chat);
    const row = h.dom.window.document.createElement('div'); row.className = 'mes'; row.setAttribute('mesid', '0');
    const button = h.dom.window.document.createElement('button'); button.className = 'swipe_right'; row.append(button); h.dom.window.document.querySelector('#chat').append(row);
    let swiped;
    let cancelled = false;
    h.native.swipe_right = async (_event, options) => { swiped = options?.message; };
    h.native.cancelDebouncedChatSave = () => { cancelled = true; };
    button.click();
    await settle();
    assert.equal(swiped, target);
    assert.equal(cancelled, true);
    assert.equal(h.saves.length, 1);
});

test('a queued swipe aborts when its stable target has disappeared', async t => {
    const h = await fixture(t);
    const target = { mes: 'older AI', is_user: false, extra: { multiplayer: { messageId: id } } };
    h.native.chat.push(target, { mes: 'last AI', is_user: false });
    h.integration.session.localSaved(h.native.chat);
    const row = h.dom.window.document.createElement('div'); row.className = 'mes'; row.setAttribute('mesid', '0');
    const button = h.dom.window.document.createElement('button'); button.className = 'swipe_right'; row.append(button); h.dom.window.document.querySelector('#chat').append(row);
    let swiped = false;
    h.native.swipe_right = async () => { swiped = true; };
    button.click();
    h.native.chat.shift();
    await settle();
    assert.equal(swiped, false);
    assert.deepEqual(h.saves, []);
});

test('failed restoration cancels external generation after native replaces its abort controller', async t => {
    const h = await fixture(t);
    const fetch = h.dom.window.fetch;
    h.dom.window.fetch = (url, options) => url === '/api/chats/group/get' ? Promise.resolve(Response.json({}, { status: 500 })) : fetch(url, options);
    h.native.chat.push({ mes: 'unsaved AI', is_user: false });
    h.failNextSave();
    await h.native.saveChatConditional();
    const emit = h.native.eventSource.emit;
    h.native.eventSource.emit = async (...args) => { try { await emit(...args); } catch {} };
    let aborted = false;
    let modelRequests = 0;
    h.native.stopGeneration = () => { aborted = true; };
    const externalGenerate = async () => {
        await h.native.eventSource.emit('generation-started', 'normal', {}, false);
        aborted = false;
        await h.native.eventSource.emit('after-commands', 'normal', {}, false);
        if (!aborted) { modelRequests++; }
    };
    await externalGenerate();
    await externalGenerate();
    assert.equal(modelRequests, 0);
});

test('mounted command processing does not add a second human turn', async t => {
    const h = await fixture(t);
    h.dom.window.document.querySelector('#send_textarea').value = '/echo hello';
    h.dom.window.document.querySelector('#send_but').click();
    await settle();
    assert.deepEqual(h.saves, []);
    assert.deepEqual(h.generated, []);
});

test('stream previews wait for native rendered content and never publish reasoning', async t => {
    const h = await fixture(t);
    await h.integration.session.generationStatus(true);
    h.native.chat.push({ mes: 'previous', name: 'GM', is_user: false, extra: { reasoning: 'secret' } });
    h.native.streamingProcessor = { messageId: 0, type: 'normal' };
    const row = h.dom.window.document.createElement('div'); row.className = 'mes'; row.setAttribute('mesid', '0');
    const text = h.dom.window.document.createElement('div'); text.className = 'mes_text'; row.append(text); h.dom.window.document.querySelector('#chat').append(row);
    await h.native.eventSource.emit('stream', 'new response');
    assert.equal(h.sent.filter(([, event]) => event === 'multiplayer.generation.preview').length, 0);
    h.native.chat[0].mes = 'new response';
    text.textContent = 'new response';
    await settle();
    const preview = h.sent.filter(([, event]) => event === 'multiplayer.generation.preview').at(-1)?.[2];
    assert.equal(preview?.text, 'new response');
    assert.equal(JSON.stringify(preview).includes('secret'), false);
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

test('a guest reload arriving after leaving cannot replace an ordinary chat', async t => {
    const h = await fixture(t, false);
    let finish;
    h.dom.window.fetch = () => new Promise(resolve => { finish = resolve; });
    const reload = h.emit('multiplayer.chat.saved', {});
    await settle();
    h.native.selectedGroup = null;
    await h.native.eventSource.emit('changed');
    h.native.chat.splice(0, h.native.chat.length, { mes: 'ordinary' });
    finish(Response.json([{ mes: 'old shared chat' }]));
    await reload;
    assert.deepEqual(h.native.chat, [{ mes: 'ordinary' }]);
});

test('failed native generation is restored before a later player action can save it', async t => {
    const h = await fixture(t);
    h.native.chat.push({ mes: 'failed AI response', is_user: false, extra: {} });
    h.failNextSave();
    await h.native.saveChatConditional();
    assert.deepEqual(h.native.chat, []);
    h.dom.window.document.querySelector('#send_textarea').value = 'later turn';
    h.dom.window.document.querySelector('#send_but').click();
    await settle();
    assert.deepEqual(h.saves.at(-1).chat.map(message => message.mes), ['later turn']);
});

test('remote human turn is attributed and saved through the mounted owner queue', async t => {
    const h = await fixture(t);
    await h.emit('multiplayer.message.send', { iteration: 0, message: { mes: 'remote', name: 'PC', force_avatar: '/api/plugins/multiplayer/accounts/guest/personas/pc.png', send_date: 'then', is_user: true, is_system: false, extra: { multiplayer: { messageId: id } } } });
    assert.equal(h.saves[0].chat[0].extra.multiplayer.accountId, 'guest');
    assert.deepEqual(h.sent, [['all', 'multiplayer.chat.saved', {}]]);
});

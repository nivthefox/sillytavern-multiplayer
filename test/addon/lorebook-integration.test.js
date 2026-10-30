import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const { mountLorebooks } = await import('../../addon/lorebook-bootstrap.js').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') { throw error; }
    return {};
});
const chat = { accountId: 'owner', groupId: 'g', chatId: 'scene' };
const data = text => ({ entries: { 0: { uid: 0, content: text, key: ['scene'] } } });

async function fixture(t, isOwner = false) {
    const dom = new JSDOM('<div></div>', { url: 'https://tavern.test/' });
    const handlers = new Map();
    const events = new Map();
    const sent = [];
    const requests = [];
    const errors = [];
    let current = chat;
    let contents = 'complete shared book';
    let lorebooks = [{ accountId: 'owner', filename: 'World.json' }, { accountId: 'guest', filename: 'PC.json' }];
    const native = {
        worldInfoCache: new Map(), world_names: ['PC'], selected_world_info: ['Global'], world_info: {},
        chat_metadata: { world_info: 'Chat' }, power_user: { persona_description_lorebook: 'PC' },
        selected_group: 'g', groups: [{ id: 'g', members: ['npc.png'] }],
        characters: [{ avatar: 'npc.png', data: { extensions: { world: 'Primary' } } }],
        event_types: { PERSONA_CHANGED: 'persona', WORLDINFO_ENTRIES_LOADED: 'entries' },
        eventSource: {
            on(name, fn) { const list = events.get(name) ?? []; list.push(fn); events.set(name, list); },
            removeListener(name, fn) { events.set(name, (events.get(name) ?? []).filter(item => item !== fn)); },
        },
    };
    dom.window.fetch = async (url, options) => {
        requests.push([url, options]);
        if (String(url).includes('/lore/')) { return Response.json(data(contents)); }
        if (url === '/api/worldinfo/get') { return Response.json(data('local book')); }
        return Response.json({ ok: true });
    };
    const bus = {
        on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); return () => handlers.set(name, list.filter(item => item !== fn)); },
        async join() { return { isOwner, ownerPresent: true, lorebooks }; },
        async leave() {},
        async send(...args) {
            sent.push(args);
            if (args[1] === 'multiplayer.lorebooks.identify') {
                for (const fn of handlers.get(args[1]) ?? []) { await fn(current, { accountId: isOwner ? 'owner' : 'guest', connectionId: 'self' }, args[2]); }
            }
        },
    };
    assert.equal(typeof mountLorebooks, 'function');
    const mounted = mountLorebooks({ native, window: dom.window, document: dom.window.document, accountId: isOwner ? 'owner' : 'guest', bus, getCurrentChat: () => current, onError: error => errors.push(error) });
    t.after(() => { mounted.dispose(); dom.window.close(); });
    async function emit(name, body, sender = null) {
        for (const fn of handlers.get(name) ?? []) { await fn(current, sender, body); }
    }
    async function load(name) {
        if (native.worldInfoCache.has(name)) { return native.worldInfoCache.get(name); }
        const response = await dom.window.fetch('/api/worldinfo/get', { method: 'POST', body: JSON.stringify({ name }) });
        const book = await response.json();
        native.worldInfoCache.set(name, book);
        return book;
    }
    return { mounted, native, bus, sent, requests, errors, load, emit,
        setContents(value) { contents = value; }, setList(value) { lorebooks = value; },
        leaveChat() { current = null; return bus.leave(); },
        async nativeEvent(name) { for (const fn of events.get(name) ?? []) { await fn(); } },
    };
}

test('mounted lorebooks combines join lists and loaded discovery, publishes persona, and exposes native reads', async t => {
    const h = await fixture(t);
    await h.bus.join(chat);
    assert.deepEqual(h.sent.filter(item => item[1] === 'multiplayer.lorebooks.set'), [['server', 'multiplayer.lorebooks.set', { lorebooks: ['PC.json'] }]]);
    assert.equal((await h.load('World')).entries[0].content, 'complete shared book');
    assert.ok(h.requests.some(([url]) => url.endsWith('/accounts/owner/lore/Primary.json')));
    assert.ok(h.requests.some(([url]) => url.endsWith('/accounts/owner/lore/Chat.json')));
    assert.deepEqual(h.native.world_names, ['PC']);
    h.native.power_user.persona_description_lorebook = '';
    await h.nativeEvent('persona');
    assert.deepEqual(h.sent.filter(item => item[1] === 'multiplayer.lorebooks.set').at(-1)[2], { lorebooks: [] });
    assert.deepEqual(h.errors, []);
});

test('mounted owner publishes all selections and remote saved notifications refresh native cached reads', async t => {
    const h = await fixture(t, true);
    await h.bus.join(chat);
    assert.deepEqual(new Set(h.sent.find(item => item[1] === 'multiplayer.lorebooks.set')[2].lorebooks), new Set(['Global.json', 'Chat.json', 'PC.json', 'Primary.json']));
    const qualified = 'multiplayer-lorebook:["guest","PC.json"]';
    assert.equal((await h.load(qualified)).entries[0].content, 'complete shared book');
    h.setContents('saved revision');
    await h.emit('multiplayer.lorebook.saved', { filename: 'PC.json' }, { accountId: 'guest', connectionId: 'other' });
    assert.equal((await h.load(qualified)).entries[0].content, 'saved revision');
});

test('another tab saving an own-account shared book invalidates stale native cache without treating it as self', async t => {
    const h = await fixture(t);
    h.native.worldInfoCache.set('PC', data('stale native cache'));
    await h.bus.join(chat);
    await h.emit('multiplayer.lorebook.saved', { filename: 'PC.json' }, { accountId: 'guest', connectionId: 'another-tab' });
    assert.equal((await h.load('PC')).entries[0].content, 'local book');
    h.native.worldInfoCache.set('PC', data('current local edit'));
    const before = h.requests.length;
    await h.emit('multiplayer.lorebook.saved', { filename: 'PC.json' }, { accountId: 'guest', connectionId: 'self' });
    assert.equal(h.requests.length, before);
    assert.equal((await h.load('PC')).entries[0].content, 'current local edit');
});

test('rejoin refreshes native reads, disconnect retains cache, deletion and leave remove shared availability', async t => {
    const h = await fixture(t);
    await h.bus.join(chat);
    await h.emit('bus.disconnected', null);
    assert.equal((await h.load('World')).entries[0].content, 'complete shared book');
    h.setContents('offline revision');
    await h.bus.join(chat);
    assert.equal((await h.load('World')).entries[0].content, 'offline revision');
    await h.emit('multiplayer.lorebook.deleted', { filename: 'World.json' }, { accountId: 'owner', connectionId: 'other' });
    assert.equal((await h.load('World')).entries[0].content, 'local book');
    await h.leaveChat();
    assert.equal((await h.load('Primary')).entries[0].content, 'local book');
});

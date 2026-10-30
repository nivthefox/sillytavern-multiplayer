import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createLorebookNative } from '../../addon/lorebook-native.js';

const eventNames = [
    'WORLDINFO_ENTRIES_LOADED', 'WORLDINFO_SETTINGS_UPDATED', 'WORLDINFO_UPDATED',
    'PERSONA_CHANGED', 'PERSONA_UPDATED', 'CHARACTER_EDITED', 'GROUP_UPDATED',
    'CHAT_CHANGED', 'CHAT_LOADED', 'SETTINGS_UPDATED', 'SETTINGS_LOADED',
    'GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_STOPPED', 'GENERATION_ENDED',
];

function qualifiedName(accountId, filename) {
    return `multiplayer-lorebook:${JSON.stringify([accountId, filename])}`;
}

function book(content, entries = {}) {
    return { entries: { 0: { uid: 0, key: ['scene'], content, order: 10, disable: false }, ...entries } };
}

function fixture() {
    const dom = new JSDOM('<select id="world_info"><option>Local</option></select><select id="world_editor_select"><option>Local</option></select>', { url: 'https://tavern.test/' });
    const handlers = new Map();
    const calls = [];
    const saved = [];
    const deleted = [];
    const changes = [];
    const local = new Map([['Local', book('local original')], ['Shared', book('local collision')]]);
    const cache = new Map([['Shared', structuredClone(local.get('Shared'))]]);
    const state = { books: [], isOwner: false, response: () => Response.json({ ok: true }) };
    const native = {
        worldInfoCache: cache,
        world_names: ['Local', 'Shared'],
        selected_world_info: ['Global', 'Duplicate'],
        chat_metadata: { world_info: 'Chat' },
        power_user: { persona_description_lorebook: 'Persona' },
        world_info: { charLore: [
            { name: 'Active', extraBooks: ['Active extra', 'Duplicate'] },
            { name: 'Disabled', extraBooks: ['Disabled extra'] },
            { name: 'Outside', extraBooks: ['Outside extra'] },
        ] },
        selected_group: 'group',
        groups: [{ id: 'group', members: ['Active.png', 'Disabled.png'], disabled_members: ['Disabled.png'] }],
        characters: [
            { avatar: 'Active.png', data: { extensions: { world: 'Active primary' } } },
            { avatar: 'Disabled.png', data: { extensions: { world: 'Disabled primary' } } },
            { avatar: 'Outside.png', data: { extensions: { world: 'Outside primary' } } },
        ],
        this_chid: 0,
        event_types: Object.fromEntries(eventNames.map(name => [name, name.toLowerCase()])),
        eventSource: {
            on(name, callback) {
                const listeners = handlers.get(name) ?? new Set();
                listeners.add(callback);
                handlers.set(name, listeners);
            },
            removeListener(name, callback) { handlers.get(name)?.delete(callback); },
            async emit(name, ...args) {
                for (const callback of handlers.get(name) ?? []) {
                    await callback(...args);
                }
            },
        },
        $: { event: { dispatch(event) { return event.nativeHandler?.(); } } },
    };
    const window = {
        async fetch(input, options) {
            const url = new URL(typeof input === 'string' ? input : input.url, dom.window.document.baseURI);
            const body = options?.body ? JSON.parse(options.body) : input instanceof Request ? await input.clone().json() : undefined;
            calls.push({ path: url.pathname, body });
            if (url.pathname === '/api/worldinfo/get') {
                return local.has(body.name) ? Response.json(local.get(body.name)) : Response.json({}, { status: 404 });
            }
            return state.response();
        },
    };
    const originalFetch = window.fetch;
    const originalCacheMethods = { has: cache.has, get: cache.get, set: cache.set };
    const originalDispatch = native.$.event.dispatch;
    const adapter = createLorebookNative({
        native, window, document: dom.window.document, accountId: 'viewer',
        getBooks: () => state.books,
        isOwner: () => state.isOwner,
        onSaved: filename => saved.push(filename),
        onDeleted: filename => deleted.push(filename),
        onSelectionsChanged: () => changes.push(adapter.getContribution(state.isOwner)),
    });
    const emit = (name, ...args) => native.eventSource.emit(native.event_types[name], ...args);
    const post = (operation, name, data) => window.fetch(`/api/worldinfo/${operation}`, {
        method: 'POST', body: JSON.stringify({ name, ...(data ? { data } : {}) }),
    });
    async function loadWorldInfo(name) {
        if (!name) {
            return;
        }
        if (cache.has(name)) {
            return cache.get(name);
        }
        const response = await post('get', name);
        if (!response.ok) {
            return null;
        }
        const data = await response.json();
        cache.set(name, data);
        return data;
    }
    async function saveWorldInfo(name, data, immediately = false) {
        cache.set(name, data);
        if (!immediately) {
            return;
        }
        await post('edit', name, data);
        await emit('WORLDINFO_UPDATED', name, data);
    }
    return { adapter, native, window, document: dom.window.document, state, calls, saved, deleted, changes, local, cache, emit, post, loadWorldInfo, saveWorldInfo, originalFetch, originalCacheMethods, originalDispatch };
}

function share(f, accountId = 'owner', filename = 'Shared.json', data = book('shared source')) {
    f.state.books.push({ accountId, filename, data });
}

test('collects global/chat/persona and every member primary/additional book, including disabled members', () => {
    const f = fixture();
    assert.deepEqual(f.adapter.getContribution(true), [
        'Global.json', 'Duplicate.json', 'Chat.json', 'Persona.json',
        'Active primary.json', 'Active extra.json', 'Disabled primary.json', 'Disabled extra.json',
    ]);
    f.native.this_chid = 1;
    assert.ok(f.adapter.getContribution(true).includes('Active primary.json'));
    f.native.selected_world_info = [];
    assert.ok(f.adapter.getContribution(true).includes('Duplicate.json'));
});

test('guest and additional owning-account tabs contribute only their active persona and append the native extension', () => {
    const f = fixture();
    assert.deepEqual(f.adapter.getContribution(false), ['Persona.json']);
    f.native.power_user.persona_description_lorebook = 'Already.json';
    assert.deepEqual(f.adapter.getContribution(false), ['Already.json.json']);
    f.native.power_user.persona_description_lorebook = '';
    assert.deepEqual(f.adapter.getContribution(false), []);
});

test('native cached reads and uncached HTTP reads override a same-name local book without replacing local storage', async () => {
    const f = fixture();
    const data = book('shared secret', { 1: { uid: 1, disable: true, content: 'disabled GM secret' } });
    share(f, 'owner', 'Shared.json', data);
    f.adapter.mount();
    assert.deepEqual(await f.loadWorldInfo('Shared'), data);
    assert.deepEqual(await (await f.post('get', 'Shared')).json(), data);
    assert.equal(f.calls.length, 0);
    const loaded = await f.loadWorldInfo('Shared');
    loaded.entries[0].content = 'reader mutation';
    assert.equal((await f.loadWorldInfo('Shared')).entries[0].content, 'shared secret');
    assert.equal(f.local.get('Shared').entries[0].content, 'local collision');
    f.state.books = [];
    assert.equal((await f.loadWorldInfo('Shared')).entries[0].content, 'local collision');
});

test('qualified identities remain distinct and name-only cached/HTTP reads reject ambiguity', async () => {
    const f = fixture();
    share(f, 'first');
    share(f, 'second', 'Shared.json', book('second source'));
    f.adapter.mount();
    assert.deepEqual(await f.loadWorldInfo(qualifiedName('first', 'Shared.json')), book('shared source'));
    assert.deepEqual(await f.loadWorldInfo(qualifiedName('second', 'Shared.json')), book('second source'));
    await assert.rejects(f.loadWorldInfo('Shared'), /ambig/i);
    await assert.rejects(f.post('get', 'Shared'), /ambig/i);
    assert.equal(f.calls.length, 0);
});

test('an advertised book without cached contents never falls back to an unrelated local book or empty contents', async () => {
    const f = fixture();
    share(f, 'owner', 'Shared.json', null);
    f.adapter.mount();
    await assert.rejects(f.loadWorldInfo('Shared'), /unavailable|not loaded/i);
    await assert.rejects(f.post('get', 'Shared'), /unavailable|not loaded/i);
    assert.equal(f.calls.length, 0);
});

test('shared books do not enter selector/editor lists and a colliding local editor still reads local contents', async () => {
    const f = fixture();
    share(f);
    share(f, 'owner', 'Remote only.json');
    const markup = f.document.body.innerHTML;
    f.adapter.mount();
    assert.deepEqual(f.native.world_names, ['Local', 'Shared']);
    assert.equal(f.document.body.innerHTML, markup);
    const editor = f.document.querySelector('#world_editor_select');
    const editorData = await f.native.$.event.dispatch.call(editor, {
        type: 'change', target: editor, nativeHandler: () => f.loadWorldInfo('Shared'),
    });
    assert.equal(editorData.entries[0].content, 'local collision');
    assert.equal((await f.loadWorldInfo('Shared')).entries[0].content, 'shared source');
});

test('shared reads are read-only while own-account books preserve native saves and selector access', async () => {
    const f = fixture();
    share(f);
    share(f, 'viewer', 'Local.json', book('irrelevant shared copy'));
    f.adapter.mount();
    const sharedData = await f.loadWorldInfo('Shared');
    await assert.rejects(f.saveWorldInfo('Shared', sharedData, true), /read.only/i);
    const denied = await f.post('edit', qualifiedName('owner', 'Shared.json'), book('overwrite'));
    assert.equal(denied.status, 403);
    const deletion = await f.post('delete', qualifiedName('owner', 'Shared.json'));
    assert.equal(deletion.status, 403);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.loadWorldInfo('Local')).entries[0].content, 'local original');
    await f.saveWorldInfo('Local', book('local edit'), true);
    assert.deepEqual(f.saved, ['Local.json']);
    assert.ok(f.native.world_names.includes('Local'));
});

test('guest books enter the native entries-loaded seam before activation, decorators, sorting, and budgets', async () => {
    const f = fixture();
    f.state.isOwner = true;
    const data = book('@@activate\nguest entry', {
        1: { uid: 1, content: 'disabled', disable: true, constant: true, order: 100, probability: 5, ignoreBudget: false },
    });
    share(f, 'guest', 'Persona.json', data);
    share(f, 'viewer', 'Local.json', book('not injected twice'));
    f.adapter.mount();
    const nativeEntry = { uid: 7, world: 'Local', content: 'unchanged native', disable: false };
    const collections = { globalLore: [nativeEntry], characterLore: [], chatLore: [], personaLore: [] };
    await f.emit('WORLDINFO_ENTRIES_LOADED', collections);
    assert.deepEqual(collections.globalLore, [nativeEntry]);
    assert.deepEqual(collections.personaLore, Object.values(data.entries).map(entry => ({ ...entry, world: qualifiedName('guest', 'Persona.json') })));
    collections.personaLore[0].content = 'evaluation mutates its copy';
    assert.equal(data.entries[0].content, '@@activate\nguest entry');
    f.state.isOwner = false;
    const guestCollections = { globalLore: [], characterLore: [], chatLore: [], personaLore: [] };
    await f.emit('WORLDINFO_ENTRIES_LOADED', guestCollections);
    assert.deepEqual(guestCollections.personaLore, []);
});

test('native owner collection reads its selected local books before adding same-name qualified guest entries', async () => {
    const f = fixture();
    f.state.isOwner = true;
    f.native.selected_world_info = ['Shared'];
    share(f, 'viewer', 'Shared.json', book('unused owner snapshot'));
    share(f, 'guest', 'Shared.json', book('guest persona'));
    f.adapter.mount();
    await assert.rejects(f.loadWorldInfo('Shared'), /ambig/i);
    await f.emit('GENERATION_AFTER_COMMANDS');
    const ownerBook = await f.loadWorldInfo('Shared');
    assert.equal(ownerBook.entries[0].content, 'local collision');
    assert.deepEqual(await f.loadWorldInfo(qualifiedName('guest', 'Shared.json')), book('guest persona'));
    const collections = {
        globalLore: Object.values(ownerBook.entries).map(entry => ({ ...entry, world: 'Shared' })),
        characterLore: [], chatLore: [], personaLore: [],
    };
    await f.emit('WORLDINFO_ENTRIES_LOADED', collections);
    assert.equal(collections.globalLore[0].content, 'local collision');
    assert.equal(collections.personaLore[0].content, 'guest persona');
    assert.equal(collections.personaLore[0].world, qualifiedName('guest', 'Shared.json'));
    assert.deepEqual(f.native.selected_world_info, ['Shared']);
    const secondScan = await f.loadWorldInfo('Shared');
    assert.equal(secondScan.entries[0].content, 'local collision');
    await f.emit('GENERATION_ENDED');
    await assert.rejects(f.loadWorldInfo('Shared'), /ambig/i);
    await f.emit('GENERATION_AFTER_COMMANDS');
    await f.emit('GENERATION_STOPPED');
    await assert.rejects(f.loadWorldInfo('Shared'), /ambig/i);
});

test('command-only generation startup never bypasses shared-name ambiguity', async () => {
    const f = fixture();
    f.state.isOwner = true;
    f.native.selected_world_info = ['Shared'];
    share(f, 'viewer');
    share(f, 'guest');
    f.adapter.mount();
    await f.emit('GENERATION_STARTED', 'normal');
    await assert.rejects(f.loadWorldInfo('Shared'), /ambig/i);
    await assert.rejects(f.loadWorldInfo('Shared'), /ambig/i);
});

test('parsed shared HTTP reads remain read-only and cannot overwrite a colliding local book', async () => {
    const f = fixture();
    share(f);
    f.adapter.mount();
    const response = await f.post('get', 'Shared');
    const contents = await response.json();
    contents.entries[0].content = 'attempted shared edit';
    await assert.rejects(f.saveWorldInfo('Shared', contents, true), /read.only/i);
    const clonedResponse = (await f.post('get', 'Shared')).clone();
    await assert.rejects(f.saveWorldInfo('Shared', await clonedResponse.json(), true), /read.only/i);
    assert.equal(f.calls.length, 0);
    f.state.books = [];
    assert.equal((await f.loadWorldInfo('Shared')).entries[0].content, 'local collision');
});

test('generation keeps same-name guest books separate and does not inject already loaded qualified entries twice', async () => {
    const f = fixture();
    f.state.isOwner = true;
    share(f, 'first', 'Persona.json', book('first'));
    share(f, 'second', 'Persona.json', book('second'));
    f.adapter.mount();
    const existing = { uid: 0, world: qualifiedName('first', 'Persona.json'), content: 'first' };
    const collections = { globalLore: [existing], characterLore: [], chatLore: [], personaLore: [] };
    await f.emit('WORLDINFO_ENTRIES_LOADED', collections);
    assert.deepEqual(collections.personaLore.map(entry => entry.world), [qualifiedName('second', 'Persona.json')]);
});

test('only confirmed successful native HTTP persistence notifies, never helper completion or update events', async () => {
    const f = fixture();
    share(f, 'viewer', 'Local.json');
    f.adapter.mount();
    await f.saveWorldInfo('Local', book('pending debounce'));
    await f.emit('WORLDINFO_UPDATED', 'Local', book('unconfirmed update'));
    assert.deepEqual(f.saved, []);
    f.state.response = () => Response.json({ error: 'failed' }, { status: 500 });
    await f.saveWorldInfo('Local', book('failed save'), true);
    await f.post('delete', 'Local');
    assert.deepEqual(f.saved, []);
    assert.deepEqual(f.deleted, []);
    f.state.response = () => { throw new TypeError('lost response'); };
    await assert.rejects(f.saveWorldInfo('Local', book('uncertain save'), true), /lost response/);
    await assert.rejects(f.post('delete', 'Local'), /lost response/);
    assert.deepEqual(f.saved, []);
    assert.deepEqual(f.deleted, []);
    f.state.response = () => Response.json({ ok: true });
    await f.saveWorldInfo('Local', book('saved'), true);
    await f.post('delete', 'Local');
    assert.deepEqual(f.saved, ['Local.json']);
    assert.deepEqual(f.deleted, ['Local.json']);
});

test('confirmation waits for the response, handles Request bodies, and ignores unrelated or unshared saves', async () => {
    const f = fixture();
    share(f, 'viewer', 'Local.json');
    f.adapter.mount();
    let resolve;
    f.state.response = () => new Promise(done => { resolve = done; });
    const pending = f.window.fetch(new Request('https://tavern.test/api/worldinfo/edit', {
        method: 'POST', body: JSON.stringify({ name: 'Local', data: book('pending') }),
    }));
    await new Promise(done => setImmediate(done));
    assert.deepEqual(f.saved, []);
    resolve(Response.json({ ok: true }));
    const response = await pending;
    assert.equal(response.ok, true);
    assert.deepEqual(f.saved, ['Local.json']);
    f.state.response = () => Response.json({ ok: true });
    await f.post('edit', 'Unshared', book('unshared'));
    await f.window.fetch('/api/settings/save', { method: 'POST', body: '{}' });
    await f.window.fetch('/api/worldinfo/edit', { method: 'GET' });
    assert.deepEqual(f.saved, ['Local.json']);
});

test('native selection events and jQuery changes notify with the current rebuilt selections', async () => {
    const f = fixture();
    f.adapter.mount();
    f.changes.length = 0;
    f.native.power_user.persona_description_lorebook = 'New persona';
    await f.emit('PERSONA_CHANGED');
    assert.deepEqual(f.changes.at(-1), ['New persona.json']);
    f.native.power_user.persona_description_lorebook = '';
    await f.emit('PERSONA_UPDATED');
    assert.deepEqual(f.changes.at(-1), []);
    f.state.isOwner = true;
    const target = f.document.createElement('select');
    await f.native.$.event.dispatch.call(target, {
        type: 'change', target,
        nativeHandler: () => { f.native.chat_metadata.world_info = 'New chat'; },
    });
    await Promise.resolve();
    assert.ok(f.changes.at(-1).includes('New chat.json'));
    f.native.world_info.charLore[1].extraBooks = ['Changed extra'];
    await f.emit('SETTINGS_UPDATED');
    assert.ok(f.changes.at(-1).includes('Changed extra.json'));
    f.native.selected_world_info = [];
    await f.emit('WORLDINFO_SETTINGS_UPDATED');
    assert.ok(f.changes.at(-1).includes('Duplicate.json'));
});

test('projected group cards use their native source filename for additional associations', () => {
    const f = fixture();
    const card = f.native.characters[1];
    card.multiplayer = { accountId: 'owner', filename: 'Disabled.png' };
    card.avatar = 'multiplayer-character:["owner","Disabled.png"]';
    f.native.groups[0].members[1] = card.avatar;
    assert.ok(f.adapter.getContribution(true).includes('Disabled extra.json'));
});

test('uncached same-name local editor reads and writes stay local even with ambiguous shared names', async () => {
    const f = fixture();
    share(f, 'first');
    share(f, 'second');
    f.cache.delete('Shared');
    f.adapter.mount();
    const editor = f.document.querySelector('#world_editor_select');
    const data = await f.native.$.event.dispatch.call(editor, {
        type: 'change', target: editor, nativeHandler: () => f.loadWorldInfo('Shared'),
    });
    assert.equal(data.entries[0].content, 'local collision');
    data.entries[0].content = 'local editor change';
    await f.saveWorldInfo('Shared', data, true);
    assert.deepEqual(f.calls.map(call => call.path), ['/api/worldinfo/get', '/api/worldinfo/edit']);
    assert.deepEqual(f.saved, []);
    await assert.rejects(f.loadWorldInfo('Shared'), /ambig/i);
});

test('direct native persona and auxiliary-book setters notify before debounced settings persistence', async () => {
    const f = fixture();
    f.state.isOwner = true;
    f.adapter.mount();
    f.native.world_info.charLore[1].extraBooks = ['Immediate extra'];
    Object.assign(f.native.world_info, { charLore: f.native.world_info.charLore });
    await Promise.resolve();
    assert.ok(f.changes.at(-1)?.includes('Immediate extra.json'));
    f.native.power_user.persona_description_lorebook = 'Immediate persona';
    await Promise.resolve();
    assert.ok(f.changes.at(-1)?.includes('Immediate persona.json'));
    f.adapter.dispose();
    assert.equal(f.native.power_user.persona_description_lorebook, 'Immediate persona');
    assert.equal(Object.getOwnPropertyDescriptor(f.native.power_user, 'persona_description_lorebook').get, undefined);
});

test('a confirmed response after withdrawal does not notify the current shared chat', async () => {
    const f = fixture();
    share(f, 'viewer', 'Local.json');
    f.adapter.mount();
    let resolve;
    f.state.response = () => new Promise(done => { resolve = done; });
    const pending = f.post('edit', 'Local', book('saved in previous availability'));
    await new Promise(done => setImmediate(done));
    f.state.books = [];
    resolve(Response.json({ ok: true }));
    await pending;
    assert.deepEqual(f.saved, []);
});

test('disposal restores fetch/cache/dispatch and removes native subscriptions without leaking shared reads', async () => {
    const f = fixture();
    share(f);
    f.adapter.mount();
    f.adapter.mount();
    assert.equal((await f.loadWorldInfo('Shared')).entries[0].content, 'shared source');
    f.adapter.dispose();
    f.adapter.dispose();
    assert.equal(f.window.fetch, f.originalFetch);
    assert.equal(f.cache.has, f.originalCacheMethods.has);
    assert.equal(f.cache.get, f.originalCacheMethods.get);
    assert.equal(f.cache.set, f.originalCacheMethods.set);
    assert.equal(f.native.$.event.dispatch, f.originalDispatch);
    assert.equal((await f.loadWorldInfo('Shared')).entries[0].content, 'local collision');
    const count = f.changes.length;
    await f.emit('PERSONA_CHANGED');
    assert.equal(f.changes.length, count);
});

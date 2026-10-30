import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createChatOwnership } from '../../addon/chat-ownership.js';

const moduleUrl = new URL('../../addon/ownership-native.js', import.meta.url);
const integration = await import(moduleUrl).catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes(moduleUrl.pathname)) {
        throw error;
    }
    return {};
});

async function settle() {
    for (let turn = 0; turn < 4; turn++) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

async function fixture(t, transcriptStatus = 200) {
    const dom = new JSDOM('<body><div id="extensions_settings"></div><div id="rm_group_chats_block"></div><div id="rm_print_characters_block"></div><div id="select_chat_div"></div><div id="chat"></div></body>', { url: 'http://localhost/' });
    t.after(() => dom.window.close());
    const { document } = dom.window;
    const calls = [];
    const errors = [];
    const events = new EventEmitter();
    let discoveryStatus = 200;
    const envelope = { owner: { id: 'host', name: 'Host <&>' }, group: { id: '42', name: 'Shared', members: ['NPC.png'], disabled_members: [], chats: ['first', 'second'], chat_id: 'first', multiplayer: { owner: 'host', accounts: ['guest'] } } };
    const fetch = async (url, options) => {
        calls.push([String(url), options]);
        const path = String(url);
        if (path === '/api/groups/all') {
            return Response.json([]);
        }
        if (path.endsWith('/accounts')) {
            return Response.json([]);
        }
        if (path === '/api/plugins/multiplayer/chats') {
            return Response.json([envelope], { status: discoveryStatus });
        }
        if (path.endsWith('/card')) {
            return Response.json({ name: 'NPC', data: { name: 'NPC' } });
        }
        if (path.endsWith('/groups/42')) {
            return Response.json(envelope);
        }
        if (path.endsWith('/groups/42/chats')) {
            return Response.json([{ file_id: 'second', file_name: 'second.jsonl', chat_items: 1, mes: 'Second', last_mes: 1 }]);
        }
        if (path.includes('/groups/42/chats/')) {
            return Response.json([{ chat_metadata: { world_info: 'Book' } }, { name: 'NPC', mes: path.endsWith('/second') ? 'Second' : 'First', original_avatar: 'NPC.png', is_user: false }], { status: transcriptStatus });
        }
        throw new Error(`Unexpected native request: ${path}`);
    };
    dom.window.fetch = fetch;
    const service = createChatOwnership({ account: { id: 'guest', name: 'Guest', avatar: null }, extensionSettings: {}, saveSettings() {}, getRequestHeaders: () => ({}), fetch, reportError: error => errors.push(error) });
    const native = {
        groups: [], characters: [], chat: [], selectedGroup: null, default_avatar: '/img/ai4.png',
        entitiesFilter: { filterFunctions: { native: entities => entities } },
        eventSource: events, event_types: { CHAT_CHANGED: 'chat', CHARACTER_PAGE_LOADED: 'page' },
        clearChat: async ({ clearData = false } = {}) => {
            document.getElementById('chat').replaceChildren();
            await Promise.resolve();
            if (clearData) {
                native.chat.splice(0);
            }
        },
        updateChatMetadata: metadata => { native.metadata = metadata; },
        select_group_chats(id) { events.emit('groupSelected', { detail: { id, group: native.groups.find(group => group.id === id) } }); },
        getRequestHeaders: () => ({}),
        reportError: error => errors.push(error),
        async printMessages() {
            const chat = document.getElementById('chat');
            chat.replaceChildren();
            for (const [index, message] of native.chat.entries()) {
                const element = document.createElement('div');
                element.className = 'mes';
                element.setAttribute('mesid', String(index));
                const avatar = document.createElement('div');
                avatar.className = 'avatar';
                const image = document.createElement('img');
                image.src = message.force_avatar ?? '/thumbnail?type=avatar&file=NPC.png';
                image.addEventListener('error', () => avatar.replaceChildren(document.createTextNode('native missing icon')));
                avatar.append(image);
                element.append(avatar);
                chat.append(element);
            }
        },
        async displayPastChats() {
            const response = await dom.window.fetch('/api/chats/search', { method: 'POST', body: JSON.stringify({ group_id: native.selectedGroup, query: '' }) });
            const container = document.getElementById('select_chat_div');
            container.replaceChildren();
            for (const summary of await response.json()) {
                const choice = document.createElement('div');
                choice.className = 'select_chat_block';
                choice.setAttribute('file_name', summary.file_name);
                const label = document.createElement('span');
                label.textContent = summary.preview_message;
                choice.append(label);
                container.append(choice);
            }
        },
        async openGroupById(id) {
            native.select_group_chats(id);
            native.selectedGroup = id;
            const group = native.groups.find(group => group.id === id);
            await native.clearChat();
            const response = await dom.window.fetch('/api/chats/group/get', { method: 'POST', body: JSON.stringify({ id: group.chat_id }) });
            const data = response.ok ? await response.json() : [];
            if (!data.length) {
                throw new Error('Native initializer must not run');
            }
            if (Object.hasOwn(data[0], 'chat_metadata')) {
                native.updateChatMetadata(data.shift().chat_metadata);
            }
            native.chat.push(...data);
            await native.printMessages();
            await events.emit('chat', group.chat_id);
            return true;
        },
    };
    const adapter = integration.createOwnershipNative?.({ service, native, document, window: dom.window }) ?? { async mount() {}, dispose() {}, decorateGroupCard() {} };
    t.after(() => adapter.dispose());
    await adapter.mount();
    native.groups = await (await dom.window.fetch('/api/groups/all', { method: 'POST' })).json();
    const projection = native.groups.find(group => group.name === 'Shared');
    const card = document.createElement('div');
    card.className = 'group_select';
    card.setAttribute('data-grid', projection?.id ?? '42');
    card.innerHTML = '<div class="avatar"><img></div><span class="ch_name">Shared</span>';
    document.getElementById('rm_print_characters_block').append(card);
    adapter.decorateGroupCard(card, envelope);
    await settle();
    return { dom, document, native, adapter, calls, errors, card, envelope, events, setDiscoveryStatus: value => { discoveryStatus = value; } };
}

test('grid and list cards show only the ownership badge tooltip, never an ownership text line', async t => {
    const f = await fixture(t);
    const manifest = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url), 'utf8'));
    if (manifest.css) {
        const style = f.document.createElement('style');
        style.textContent = await readFile(new URL(`../../${manifest.css}`, import.meta.url), 'utf8');
        f.document.head.append(style);
    }
    f.document.body.classList.add('charListGrid');
    const label = f.card.querySelector('.multiplayer-owner-label');
    const badge = f.card.querySelector('.avatar .multiplayer-owner-badge');
    assert.equal(label, null);
    assert.notEqual(f.dom.window.getComputedStyle(badge).display, 'none');
    assert.equal(badge.title, 'Owned by Host <&>');
    assert.equal(f.card.querySelector('.ch_name').textContent, 'Shared');
    f.document.body.classList.remove('charListGrid');
    assert.equal(f.card.querySelector('.multiplayer-owner-label'), null);
});

test('shared groups retain native portrait-first card structure when native cards are not yet loaded', async t => {
    const f = await fixture(t);
    const templates = f.document.createElement('div'); templates.id = 'group_avatars_template';
    templates.innerHTML = '<div class="avatar avatar_collage collage_1"><img alt="img1" class="img_1" src=""></div>';
    f.document.body.append(templates);
    f.card.innerHTML = '<div class="missing-avatar fa-solid fa-user-slash"></div><div class="flex-container wide100pLess70px gap5px group_select_container"><div class="wide100p group_name_block character_name_block"><div class="ch_name">Shared</div><small class="ch_additional_info group_select_counter">1</small></div></div>';
    const contents = f.card.querySelector('.group_select_container');
    f.adapter.decorateGroupCard(f.card, f.envelope);
    const avatar = f.card.firstElementChild;
    assert.equal(avatar.className, 'avatar avatar_collage collage_1');
    assert.equal(avatar.querySelector('img').alt, 'img1');
    assert.equal(f.card.children.length, 2);
    assert.equal(f.card.lastElementChild, contents);
    assert.equal(f.card.querySelector('.multiplayer-owner-label'), null);
    assert.equal(avatar.querySelector('.multiplayer-owner-badge').title, 'Owned by Host <&>');
});

test('shared group members are loaded before native listing builds portraits and member names', async t => {
    const f = await fixture(t);
    const group = f.native.groups.find(group => group.name === 'Shared');
    assert.ok(group.members.every(member => f.native.characters.some(character => character.avatar === member)));
});

test('remote group members remain available to the group but never become standalone character-list entries', async t => {
    const f = await fixture(t);
    await f.adapter.openGroup('host', '42');
    const remote = f.native.characters.find(character => character.avatar.startsWith('multiplayer-character:'));
    const local = { avatar: 'NPC.png', name: 'Local NPC' };
    f.native.characters.push(local);
    const group = { type: 'group', item: f.native.groups[0] };
    const localEntry = { type: 'character', item: local };
    const entities = [{ type: 'character', item: remote }, localEntry, group];
    const listed = Object.values(f.native.entitiesFilter.filterFunctions).reduce((items, filter) => filter(items), entities);
    assert.deepEqual(listed, [localEntry, group]);
    assert.ok(f.native.characters.includes(remote));
    f.adapter.dispose();
    assert.deepEqual(Object.keys(f.native.entitiesFilter.filterFunctions), ['native']);
});

test('guest card and stored-chat DOM clicks replace native handlers and load the requested owner transcript', async t => {
    const f = await fixture(t);
    let nativeClicks = 0;
    f.document.addEventListener('click', () => { nativeClicks++; });
    f.card.querySelector('.ch_name').dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(f.native.chat[0]?.mes, 'First', 'card click must reach shared loading');
    assert.equal(nativeClicks, 0, 'native delegated opener must not also run');
    assert.ok(f.native.selectedGroup);
    await f.adapter.showChats('host', '42');
    const child = f.document.querySelector('#select_chat_div .select_chat_block span');
    assert.ok(child, 'native chooser must render the Plugin summary');
    child.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(f.native.chat[0]?.mes, 'Second');
    assert.equal(nativeClicks, 0);
    assert.equal(f.calls.some(([path]) => path.includes('/save') || path.includes('/edit')), false);
});

test('shared collages use owner images before opening and failed images retain the native default avatar', async t => {
    const f = await fixture(t);
    const collageImages = [...f.card.querySelectorAll('.avatar img')];
    assert.ok(collageImages.length);
    assert.ok(collageImages.every(image => image.getAttribute('src') === '/api/plugins/multiplayer/accounts/host/characters/NPC.png'));
    const image = collageImages[0];
    image.dispatchEvent(new f.dom.window.Event('error'));
    assert.equal(image.getAttribute('src'), f.native.default_avatar);
    assert.ok(f.card.contains(image));
});

test('message image failures use the default avatar before native destructive handlers, including rerenders', async t => {
    const f = await fixture(t);
    f.card.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle();
    for (let render = 0; render < 2; render++) {
        const image = f.document.querySelector('#chat .avatar img');
        assert.ok(image, 'native message must be rendered');
        assert.equal(image.getAttribute('src'), '/api/plugins/multiplayer/accounts/host/characters/NPC.png');
        image.dispatchEvent(new f.dom.window.Event('error'));
        assert.ok(f.document.getElementById('chat').contains(image), 'native missing-icon handler must not remove the image');
        assert.equal(image.getAttribute('src'), f.native.default_avatar);
        await f.native.printMessages();
        await settle();
    }
});

test('relative portrait URLs resolve against the document base instead of a dummy root', async t => {
    const f = await fixture(t);
    await f.adapter.openGroup('host', '42');
    const base = f.document.createElement('base');
    base.href = 'https://tavern.example/nested/';
    f.document.head.append(base);
    const remote = f.native.characters.find(character => character.multiplayer?.accountId === 'host');
    const image = f.document.createElement('img');
    const relative = `thumbnail?type=avatar&file=${encodeURIComponent(remote.avatar)}`;
    image.setAttribute('src', relative);
    f.document.body.append(image);
    await settle();
    assert.equal(image.getAttribute('src'), relative, 'a nested thumbnail path is not the native root thumbnail route');
    assert.equal(image.src, `https://tavern.example/nested/${relative}`);
});

test('opening a shared group publishes its final transcript once through native CHAT_CHANGED', async t => {
    const f = await fixture(t);
    const changes = [];
    f.events.on('chat', id => changes.push({ id, metadata: structuredClone(f.native.metadata), messages: structuredClone(f.native.chat) }));
    await f.adapter.openGroup('host', '42');
    assert.equal(changes.length, 1, 'native opener already publishes CHAT_CHANGED');
    assert.equal(changes[0].id, 'first');
    assert.equal(changes[0].messages[0].mes, 'First');
    assert.deepEqual(changes[0].metadata, { world_info: 'Book' });
});

test('a read paused in native clearChat cannot overwrite a newer shared selection', async t => {
    const f = await fixture(t);
    await f.adapter.openGroup('host', '42');
    const clear = f.native.clearChat;
    let release;
    f.native.clearChat = async ({ clearData = false } = {}) => {
        f.document.getElementById('chat').replaceChildren();
        f.native.clearChat = clear;
        await new Promise(resolve => { release = resolve; });
        if (clearData) {
            f.native.chat.splice(0);
        }
    };
    const previous = f.adapter.openChat('host', '42', 'first');
    await settle();
    assert.ok(release);
    await f.adapter.openChat('host', '42', 'second');
    release();
    await previous;
    assert.equal(f.native.chat[0].mes, 'Second');
    assert.equal(f.native.groups.find(group => group.id === f.native.selectedGroup).chat_id, 'second');
});

test('a new native creation preview is not replaced by the still-open shared conversation portrait', async t => {
    const f = await fixture(t);
    await f.adapter.openGroup('host', '42');
    f.native.select_group_chats(null);
    const preview = f.document.createElement('div');
    preview.id = 'group_avatar_preview';
    const image = f.document.createElement('img');
    image.src = '/thumbnail?type=avatar&file=New-local.png';
    preview.append(image);
    f.document.getElementById('rm_group_chats_block').append(preview);
    await settle();
    assert.equal(image.getAttribute('src'), '/thumbnail?type=avatar&file=New-local.png');
});

test('a failed shared discovery keeps successful native listing usable and can recover', async t => {
    const f = await fixture(t);
    f.setDiscoveryStatus(404);
    const response = await f.dom.window.fetch('/api/groups/all', { method: 'POST' });
    assert.equal(response.ok, true);
    assert.deepEqual(await response.json(), []);
    assert.equal(f.errors.length, 1, 'shared discovery failure must remain visible');
    f.setDiscoveryStatus(200);
    const recovered = await (await f.dom.window.fetch('/api/groups/all', { method: 'POST' })).json();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].name, 'Shared');
});

test('a shared collage updates its image count when native markup or membership changes', async t => {
    const f = await fixture(t);
    const entry = structuredClone(f.envelope);
    entry.group.members = ['One.png', 'Two.png', 'Three.png'];
    f.adapter.decorateGroupCard(f.card, entry);
    assert.deepEqual([...f.card.querySelectorAll('.avatar img')].map(image => image.getAttribute('src')), entry.group.members.map(filename => `/api/plugins/multiplayer/accounts/host/characters/${filename}`));
    entry.group.members = ['Two.png'];
    f.adapter.decorateGroupCard(f.card, entry);
    assert.equal(f.card.querySelectorAll('.avatar img').length, 1);
    assert.equal(f.card.querySelector('.avatar img').getAttribute('src'), '/api/plugins/multiplayer/accounts/host/characters/Two.png');
});

test('failed shared click reports one load error and never opens a native empty chat', async t => {
    const f = await fixture(t, 500);
    f.card.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(f.errors.length, 1, 'display one error from the resource operation');
    assert.equal(f.native.selectedGroup, null);
    assert.equal(f.calls.some(([path]) => path.includes('/save') || path.includes('/edit') || path === '/api/chats/group/get'), false);
});

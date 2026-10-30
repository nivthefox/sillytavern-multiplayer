import assert from 'node:assert/strict';
import { test } from 'node:test';
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
            return Response.json([envelope]);
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
        clearChat: async () => { native.chat.splice(0); document.getElementById('chat').replaceChildren(); },
        updateChatMetadata: metadata => { native.metadata = metadata; },
        select_group_chats() {},
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
        async openGroupById(id) {
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
    return { dom, document, native, adapter, calls, errors, card, envelope };
}

test('guest card and stored-chat DOM clicks replace native handlers and load the requested owner transcript', async t => {
    const f = await fixture(t);
    let nativeClicks = 0;
    f.document.addEventListener('click', () => { nativeClicks++; });
    f.card.querySelector('.ch_name').dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(f.native.chat[0]?.mes, 'First', 'card click must reach shared loading');
    assert.equal(nativeClicks, 0, 'native delegated opener must not also run');
    assert.ok(f.native.selectedGroup);
    const chatChoice = f.document.createElement('div');
    chatChoice.className = 'select_chat_block';
    chatChoice.setAttribute('file_name', 'second.jsonl');
    const child = f.document.createElement('span');
    child.textContent = 'Second';
    chatChoice.append(child);
    f.document.getElementById('select_chat_div').append(chatChoice);
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

test('failed shared click reports one load error and never opens a native empty chat', async t => {
    const f = await fixture(t, 500);
    f.card.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(f.errors.length, 1, 'display one error from the resource operation');
    assert.equal(f.native.selectedGroup, null);
    assert.equal(f.calls.some(([path]) => path.includes('/save') || path.includes('/edit') || path === '/api/chats/group/get'), false);
});

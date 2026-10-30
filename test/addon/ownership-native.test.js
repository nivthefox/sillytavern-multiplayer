import assert from 'node:assert/strict';
import { test } from 'node:test';

const moduleUrl = new URL('../../addon/ownership-native.js', import.meta.url);
const ownershipModule = await import(moduleUrl).catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes(moduleUrl.pathname)) {
        throw error;
    }
    return {};
});

class Element extends EventTarget {
    constructor(tagName = 'div') {
        super();
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.dataset = {};
        this.style = {};
        this.attributes = new Map();
        this.textContent = '';
        this.className = '';
        this.id = '';
        this.checked = false;
        this.hidden = false;
        this.disabled = false;
        this.classList = {
            add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' ').trim(); },
            contains: name => this.className.split(' ').includes(name),
        };
    }

    append(...children) {
        for (const child of children) {
            child.parentElement = this;
            this.children.push(child);
        }
    }

    appendChild(child) {
        this.append(child);
        return child;
    }

    replaceChildren(...children) {
        this.children = [];
        this.append(...children);
    }

    remove() {
        this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === 'class') {
            this.className = String(value);
        }
        if (name === 'id') {
            this.id = String(value);
        }
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? this[name] ?? null;
    }

    matches(selector) {
        if (selector.startsWith('#')) {
            return this.id === selector.slice(1);
        }
        if (selector.startsWith('.')) {
            return this.classList.contains(selector.slice(1));
        }
        const attribute = selector.match(/^\[([^=]+)="([^"]+)"\]$/);
        if (attribute) {
            const [, name, value] = attribute;
            return this.getAttribute(name) === value;
        }
        return this.tagName.toLowerCase() === selector;
    }

    querySelectorAll(selector) {
        const result = [];
        for (const child of this.children) {
            if (child.matches(selector)) {
                result.push(child);
            }
            result.push(...child.querySelectorAll(selector));
        }
        return result;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
    }
}

function createDocument() {
    const document = new Element('document');
    document.createElement = tag => new Element(tag);
    document.getElementById = id => document.querySelector(`#${id}`);
    document.body = new Element('body');
    document.append(document.body);
    for (const id of ['rm_group_chats_block', 'rm_group_add_members', 'rm_group_members', 'extensions_settings', 'rm_print_characters_block', 'select_chat_div']) {
        const element = new Element();
        element.id = id;
        document.body.append(element);
    }
    return document;
}

function unmodifiedNativeAdapter({ native }) {
    return {
        mount() {},
        dispose() {},
        async refreshGroups() {},
        async openGroup(ownerId, groupId) { await native.getGroupChat(groupId); },
        async openChat(ownerId, groupId) { await native.getGroupChat(groupId); },
        async showChats() { await native.displayPastChats(); },
        decorateGroupCard() {},
    };
}

function fixture(overrides = {}) {
    const calls = [];
    const account = { id: 'guest', name: 'Guest', avatar: 'data:image/png;base64,guest' };
    const owner = { id: 'host', name: 'Host <&>' };
    const group = { id: '42', name: 'Scene', members: ['Guide.png'], chats: ['scene', 'older'], chat_id: 'scene', multiplayer: { owner: 'host', accounts: ['guest'] } };
    const summaries = [{ file_id: 'older', file_name: 'older.jsonl', chat_items: 1, mes: 'Earlier', last_mes: 123, file_size: '1kb', match: false }];
    const messages = [{ name: 'Guide', mes: 'Welcome', is_user: false, original_avatar: 'Guide.png', extra: { preserved: true } }];
    const metadata = { world_info: 'World', extension: { untouched: true } };
    const document = createDocument();
    const nativeFetch = async (url, options) => {
        calls.push(['fetch', url, options]);
        if (url === '/api/groups/create') {
            return Response.json({ ...JSON.parse(options.body), id: 'created' });
        }
        if (url === '/api/groups/all') {
            return Response.json([{ id: 'local', members: ['Guide.png'] }]);
        }
        return Response.json({ ok: true });
    };
    const window = { fetch: nativeFetch, location: { href: 'https://tavern.example/' } };
    const native = {
        chat: [{ mes: 'Previous' }],
        groups: [{ id: 'local', members: ['Guide.png'] }],
        characters: [{ name: 'Guest Guide', avatar: 'Guide.png' }],
        default_avatar: '/img/ai4.png',
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'token' }),
        clearChat: async () => { calls.push(['clearChat']); native.chat.splice(0); },
        printMessages: async () => { calls.push(['printMessages', structuredClone(native.chat)]); },
        updateChatMetadata: (value, reset) => { calls.push(['metadata', value, reset]); },
        select_group_chats: (...args) => { calls.push(['select_group_chats', ...args]); },
        displayPastChats: async (...args) => { calls.push(['displayPastChats', ...args]); },
        getGroupChat: async () => {
            calls.push(['initializeChat']);
            native.chat.splice(0, native.chat.length, { mes: 'Native greeting' });
            await window.fetch('/api/chats/group/save', { method: 'POST', body: JSON.stringify(native.chat) });
        },
        createNewGroupChat: async id => window.fetch('/api/groups/edit', { method: 'POST', body: JSON.stringify({ id, chats: ['new'] }) }),
        importGroupChat: async body => window.fetch('/api/chats/group/import', { method: 'POST', body }),
        reportError: error => { calls.push(['error', error]); },
    };
    const service = {
        account,
        listAccounts: async () => {
            calls.push(['listAccounts']);
            return [{ id: 'friend', name: 'Friend <&>', avatar: 'data:image/png;base64,friend' }];
        },
        isDiscoverable: () => true,
        setDiscoverable: value => { calls.push(['setDiscoverable', value]); },
        createGroup: async (model, accounts) => {
            calls.push(['createGroup', structuredClone(model), [...accounts]]);
            return { ...model, id: 'created', multiplayer: { owner: 'guest', accounts } };
        },
        mergeGroups: async groups => {
            calls.push(['mergeGroups', structuredClone(groups)]);
            return [...groups.map(group => ({ owner: account, group })), { owner, group }];
        },
        loadGroup: async (...args) => { calls.push(['loadGroup', ...args]); return { owner, group: structuredClone(group) }; },
        listChats: async (...args) => { calls.push(['listChats', ...args]); return structuredClone(summaries); },
        loadChat: async (...args) => { calls.push(['loadChat', ...args]); return { metadata: structuredClone(metadata), messages: structuredClone(messages) }; },
        loadCharacters: async (...args) => {
            calls.push(['loadCharacters', ...args]);
            return [{ name: 'Host Guide', avatar: 'Guide.png', multiplayer: { accountId: 'host', filename: 'Guide.png' }, imageUrl: '/api/plugins/multiplayer/accounts/host/characters/Guide.png' }];
        },
        characterImage: (id, filename) => `/api/plugins/multiplayer/accounts/${encodeURIComponent(id)}/characters/${encodeURIComponent(filename)}`,
        ...overrides,
    };
    const adapter = (ownershipModule.createOwnershipNative ?? unmodifiedNativeAdapter)({ service, native, document, window });
    return { adapter, service, native, document, window, calls, group, owner, summaries, messages, metadata, nativeFetch };
}

function findByText(root, text) {
    return root.querySelectorAll('label').find(element => element.textContent === text)
        ?? root.querySelectorAll('span').find(element => element.textContent === text)
        ?? root.querySelectorAll('h3').find(element => element.textContent === text);
}

async function settle() {
    await new Promise(resolve => setImmediate(resolve));
}

test('native adapter is provided by the browser module', () => {
    assert.equal(typeof ownershipModule.createOwnershipNative, 'function');
});

test('mount adds the creating account and other Account cards beside native character controls', async () => {
    const f = fixture();
    await f.adapter.mount();
    const form = f.document.getElementById('rm_group_chats_block');
    assert.ok(findByText(form, 'Owned by Guest'), 'creation form must show its automatic owner');
    assert.ok(findByText(form, 'Add Other Accounts'));
    assert.ok(findByText(form, 'Friend <&>'));
    assert.ok(form.querySelectorAll('img').some(image => image.src === 'data:image/png;base64,friend'));
    assert.equal(form.querySelectorAll('input').filter(input => input.value === 'guest').length, 0);
    assert.ok(f.document.getElementById('rm_group_add_members'));
});

test('discoverability mounts enabled by default and saves a change without refreshing account choices', async () => {
    const f = fixture();
    await f.adapter.mount();
    const settings = f.document.getElementById('extensions_settings');
    const label = findByText(settings, 'Allow others to add me to shared groups');
    assert.ok(label, 'discoverability control must be in native extension settings');
    const checkbox = label.querySelector('input');
    assert.equal(checkbox.checked, true);
    const accountReads = f.calls.filter(call => call[0] === 'listAccounts').length;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    await settle();
    assert.deepEqual(f.calls.filter(call => call[0] === 'setDiscoverable'), [['setDiscoverable', false]]);
    assert.equal(f.calls.filter(call => call[0] === 'listAccounts').length, accountReads);
});

test('stored opt-out is reflected without rewriting settings during mount', async () => {
    const f = fixture({ isDiscoverable: () => false });
    await f.adapter.mount();
    const label = findByText(f.document, 'Allow others to add me to shared groups');
    assert.ok(label);
    assert.equal(label.querySelector('input').checked, false);
    assert.equal(f.calls.some(call => call[0] === 'setDiscoverable'), false);
});

test('native creation request is completed with the service-owned full record', async () => {
    const f = fixture();
    await f.adapter.mount();
    const model = { members: ['Guide.png'], name: 'Scene', generation_mode: 2, chats: ['scene'] };
    const response = await f.window.fetch('/api/groups/create', { method: 'POST', headers: f.native.getRequestHeaders(), body: JSON.stringify(model) });
    assert.deepEqual(await response.json(), { ...model, id: 'created', multiplayer: { owner: 'guest', accounts: [] } });
    assert.deepEqual(f.calls.filter(call => call[0] === 'createGroup'), [['createGroup', model, []]]);
});

test('relative native requests resolve against the document base URL', async () => {
    const f = fixture();
    f.document.baseURI = 'https://tavern.example/api/groups/';
    await f.adapter.mount();
    const response = await f.window.fetch('create', { method: 'POST', body: JSON.stringify({ members: ['Guide.png'] }) });
    assert.equal((await response.json()).multiplayer?.owner, 'guest');
    assert.equal(f.calls.filter(call => call[0] === 'createGroup').length, 1);
});

test('relative native requests use the supplied browser location without a document base', async () => {
    const f = fixture();
    f.window.location.href = 'https://tavern.example/api/groups/';
    await f.adapter.mount();
    const response = await f.window.fetch('create', { method: 'POST', body: JSON.stringify({ members: ['Guide.png'] }) });
    assert.equal((await response.json()).multiplayer?.owner, 'guest');
});

test('selected Account cards are passed to creation without rechecking eligibility', async () => {
    const f = fixture();
    await f.adapter.mount();
    const checkbox = f.document.getElementById('rm_group_chats_block').querySelectorAll('input').find(input => input.value === 'friend');
    assert.ok(checkbox, 'eligible account must be selectable');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    f.service.listAccounts = () => { throw new Error('eligibility must not be refreshed'); };
    await f.window.fetch('/api/groups/create', { method: 'POST', body: JSON.stringify({ members: ['Guide.png'] }) });
    assert.deepEqual(f.calls.find(call => call[0] === 'createGroup')?.[2], ['friend']);
});

test('service creation failure cannot be reported to native creation as success', async () => {
    const failure = new Error('ownership save failed');
    const f = fixture({ createGroup: async () => { throw failure; } });
    await f.adapter.mount();
    await assert.rejects(f.window.fetch('/api/groups/create', { method: 'POST', body: JSON.stringify({ members: ['Guide.png'] }) }), /ownership save failed/);
});

test('normal native group listing fetch is merged through the ownership service', async () => {
    const f = fixture();
    await f.adapter.mount();
    const response = await f.window.fetch('/api/groups/all', { method: 'POST' });
    const groups = await response.json();
    assert.equal(groups.length, 2);
    assert.deepEqual(f.calls.find(call => call[0] === 'mergeGroups')?.[1], [{ id: 'local', members: ['Guide.png'] }]);
    assert.ok(groups.some(group => group.name === 'Scene'));
});

test('listing refresh retains separate native identities for equal IDs from different accounts', async () => {
    const f = fixture({ mergeGroups: async () => [
        { owner: { id: 'guest', name: 'Guest' }, group: { id: '42', name: 'Local', members: [] } },
        { owner: { id: 'host', name: 'Host' }, group: { id: '42', name: 'Remote', members: [] } },
    ] });
    await f.adapter.mount();
    const groups = await (await f.window.fetch('/api/groups/all', { method: 'POST' })).json();
    assert.equal(groups.length, 2);
    assert.equal(new Set(groups.map(group => group.id)).size, 2);
});

test('guest card owner label and badge are present before opening the group', () => {
    const f = fixture();
    const card = new Element();
    const avatar = new Element();
    avatar.className = 'avatar';
    card.append(avatar);
    f.adapter.decorateGroupCard(card, { owner: f.owner, group: f.group });
    assert.ok(findByText(card, 'Owned by Host <&>'));
    assert.ok(avatar.children.some(child => child.title === 'Owned by Host <&>'), 'grid badge must overlay the portrait and carry an ownership tooltip');
    assert.equal(f.calls.some(call => call[0] === 'loadGroup'), false);
});

test('own group cards keep their native avatar without a guest badge', () => {
    const f = fixture();
    const card = new Element();
    const avatar = new Element();
    avatar.className = 'avatar';
    card.append(avatar);
    f.adapter.decorateGroupCard(card, { owner: f.service.account, group: { id: 'own' } });
    assert.deepEqual(card.children, [avatar]);
    assert.equal(avatar.children.length, 0);
});

test('guest open reads owner-qualified resources and renders native messages with separate metadata', async () => {
    const f = fixture();
    await f.adapter.openGroup('host', '42');
    assert.deepEqual(f.calls.find(call => call[0] === 'loadGroup'), ['loadGroup', 'host', '42']);
    assert.deepEqual(f.calls.find(call => call[0] === 'loadChat'), ['loadChat', 'host', '42', 'scene']);
    assert.deepEqual(f.calls.find(call => call[0] === 'loadCharacters'), ['loadCharacters', 'host', ['Guide.png']]);
    assert.deepEqual(f.calls.find(call => call[0] === 'metadata'), ['metadata', f.metadata, true]);
    assert.equal(f.native.chat.length, 1);
    assert.equal(f.native.chat[0].mes, 'Welcome');
    assert.deepEqual(f.native.chat[0].extra, { preserved: true });
    assert.ok(f.calls.some(call => call[0] === 'printMessages'));
    assert.equal(f.calls.some(call => call[0] === 'initializeChat' || call[0] === 'fetch'), false);
});

test('chat selection loads the selected stored ID without initializing or saving a native chat', async () => {
    const f = fixture();
    await f.adapter.openChat('host', '42', 'older');
    assert.deepEqual(f.calls.find(call => call[0] === 'loadChat'), ['loadChat', 'host', '42', 'older']);
    assert.ok(f.calls.some(call => call[0] === 'printMessages'));
    assert.equal(f.calls.some(call => call[0] === 'initializeChat' || call[0] === 'fetch'), false);
});

test('native chat chooser receives owner chat summaries instead of looking in guest storage', async () => {
    const f = fixture();
    await f.adapter.showChats('host', '42');
    assert.deepEqual(f.calls.find(call => call[0] === 'listChats'), ['listChats', 'host', '42']);
    assert.ok(f.calls.some(call => call[0] === 'displayPastChats'), 'use the familiar native chat-selection interface');
    assert.equal(f.calls.some(call => call[0] === 'fetch'), false);
});

for (const metadata of [{}, { world_info: 'Metadata-only' }]) {
    test(`empty shared transcript with metadata ${JSON.stringify(metadata)} clears the display without greeting or save`, async () => {
        const f = fixture({ loadChat: async () => ({ metadata, messages: [] }) });
        await f.adapter.openChat('host', '42', 'scene');
        assert.deepEqual(f.native.chat, []);
        assert.deepEqual(f.calls.find(call => call[0] === 'metadata'), ['metadata', metadata, true]);
        assert.deepEqual(f.calls.find(call => call[0] === 'printMessages'), ['printMessages', []]);
        assert.equal(f.calls.some(call => call[0] === 'initializeChat' || call[0] === 'fetch'), false);
    });
}

test('failed shared read is reported and cannot fall through to native initialization', async () => {
    const failure = new Error('HTTP 500 loading shared transcript');
    const f = fixture({ loadChat: async () => { throw failure; } });
    await assert.rejects(f.adapter.openChat('host', '42', 'scene'), /HTTP 500/);
    assert.deepEqual(f.native.chat, [{ mes: 'Previous' }]);
    assert.equal(f.calls.some(call => call[0] === 'initializeChat' || call[0] === 'fetch'), false);
});

test('shared character lookup does not replace a same-filename local card', async () => {
    const f = fixture();
    const local = f.native.characters[0];
    await f.adapter.openGroup('host', '42');
    assert.equal(f.native.characters[0], local);
    const remote = f.native.characters.find(card => card.name === 'Host Guide');
    assert.ok(remote, 'owner card must be available to native group display');
    assert.notEqual(remote.avatar, local.avatar);
    assert.deepEqual(f.group.members, ['Guide.png']);
});

test('saved original_avatar resolves to the owner image rather than the guest thumbnail', async () => {
    const f = fixture();
    await f.adapter.openGroup('host', '42');
    assert.equal(f.native.chat[0].force_avatar, '/api/plugins/multiplayer/accounts/host/characters/Guide.png');
    assert.equal(f.native.chat[0].original_avatar, 'Guide.png');
});

test('native New Chat, import and unrelated write requests remain unmodified', async () => {
    const f = fixture();
    const newChat = f.native.createNewGroupChat;
    const importChat = f.native.importGroupChat;
    await f.adapter.mount();
    assert.equal(f.native.createNewGroupChat, newChat);
    assert.equal(f.native.importGroupChat, importChat);
    await f.native.createNewGroupChat('local');
    const body = new FormData();
    body.append('file', 'transcript');
    await f.native.importGroupChat(body);
    const options = { method: 'POST', body: '{"id":"scene","chat":[]}' };
    await f.window.fetch('/api/chats/group/save', options);
    const writes = f.calls.filter(call => call[0] === 'fetch');
    assert.deepEqual(writes.map(call => call[1]), ['/api/groups/edit', '/api/chats/group/import', '/api/chats/group/save']);
    assert.equal(writes[1][2].body, body);
    assert.equal(writes[2][2], options);
});

test('disposal restores native fetch after mounting', async () => {
    const f = fixture();
    await f.adapter.mount();
    assert.notEqual(f.window.fetch, f.nativeFetch);
    f.adapter.dispose();
    assert.equal(f.window.fetch, f.nativeFetch);
});

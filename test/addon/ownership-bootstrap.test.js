import assert from 'node:assert/strict';
import { test } from 'node:test';

async function optionalModule(name) {
    const url = new URL(`../../addon/${name}.js`, import.meta.url);
    try {
        return await import(url);
    } catch (error) {
        if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes(url.pathname)) {
            throw error;
        }
        return {};
    }
}

const bootstrap = await optionalModule('ownership-bootstrap');
const integration = await optionalModule('ownership-native');

class NativeEvents {
    listeners = new Map();
    ready = false;

    on(name, listener) {
        const listeners = this.listeners.get(name) ?? [];
        listeners.push(listener);
        this.listeners.set(name, listeners);
        if (name === 'ready' && this.ready) {
            listener();
        }
    }

    makeFirst(name, listener) {
        this.listeners.set(name, [listener, ...(this.listeners.get(name) ?? []).filter(item => item !== listener)]);
    }

    removeListener(name, listener) {
        this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== listener));
    }

    async emit(name, ...args) {
        for (const listener of this.listeners.get(name) ?? []) {
            await listener(...args);
        }
        if (name === 'ready') {
            this.ready = true;
        }
    }
}

function startupFixture(ready = false) {
    const events = new NativeEvents();
    events.ready = ready;
    const calls = [];
    const document = { getElementById: () => null };
    const window = { fetch: async () => Response.json([]), toastr: { error: message => calls.push(['error', message]) } };
    const script = {
        eventSource: events,
        event_types: { APP_READY: 'ready', CHARACTER_PAGE_LOADED: 'page', CHAT_CHANGED: 'chat' },
        chat: [], characters: [],
        getRequestHeaders: () => ({ token: 'csrf' }),
        saveSettingsDebounced: () => calls.push(['saveSettings']),
        clearChat() {}, printMessages() {}, updateChatMetadata() {},
        getCharacters: async () => calls.push(['refresh']),
        default_avatar: '/img/ai4.png',
    };
    const groups = { groups: [], selected_group: null, openGroupById() {}, select_group_chats() {} };
    const users = { currentUser: { handle: 'real-handle', name: 'Real name', avatar: 'data:portrait' } };
    const extensions = { extension_settings: {} };
    const welcome = { openWelcomeScreen: async options => calls.push(['welcome', options]) };
    const utils = { timestampToMoment: value => value, sortMoments: (left, right) => right - left };
    const modules = { '/script.js': script, '/scripts/group-chats.js': groups, '/scripts/user.js': users, '/scripts/extensions.js': extensions, '/scripts/welcome-screen.js': welcome, '/scripts/utils.js': utils };
    const loadModule = async path => {
        assert.ok(modules[path], `unexpected native module ${path}`);
        return modules[path];
    };
    let dependencies;
    let serviceOptions;
    const adapter = { mount: async () => calls.push(['mount']), refreshGroups: async () => calls.push(['refreshGroups']) };
    const options = {
        window, document, loadModule,
        createService: value => { serviceOptions = value; return { account: value.account }; },
        createAdapter: value => { dependencies = value; return adapter; },
    };
    return { options, script, groups, users, extensions, calls, events, adapter, getDependencies: () => dependencies, getServiceOptions: () => serviceOptions };
}

async function initialize(options) {
    return bootstrap.initializeOwnership?.(options);
}

async function tick() {
    await new Promise(resolve => setImmediate(resolve));
}

test('browser bootstrap waits for native APP_READY before reading the authenticated account', async () => {
    const f = startupFixture();
    const pending = initialize(f.options);
    await tick();
    assert.equal(f.getServiceOptions(), undefined);
    f.users.currentUser = { handle: 'ready-handle', name: 'Ready account', avatar: null };
    await f.events.emit('ready');
    await pending;
    assert.deepEqual(f.getServiceOptions()?.account, { id: 'ready-handle', name: 'Ready account', avatar: null });
    assert.deepEqual(f.calls, [['mount'], ['refreshGroups'], ['welcome', { force: true }]]);
});

test('late initialization uses the native replayed APP_READY event and mounts only once', async () => {
    const f = startupFixture(true);
    const first = await initialize(f.options);
    const second = await initialize(f.options);
    assert.equal(first, f.adapter);
    assert.equal(second, first);
    assert.deepEqual(f.calls, [['mount'], ['refreshGroups'], ['welcome', { force: true }]]);
});

test('bootstrap native array and selection access follows live module bindings', async () => {
    const f = startupFixture(true);
    await initialize(f.options);
    const native = f.getDependencies()?.native;
    assert.ok(native, 'real module bridge must be supplied');
    f.groups.groups = [{ id: 'replacement' }];
    f.script.characters = [{ avatar: 'replacement.png' }];
    f.groups.selected_group = 'replacement';
    assert.equal(native.groups, f.groups.groups);
    assert.equal(native.characters, f.script.characters);
    assert.equal(native.selectedGroup, 'replacement');
    assert.equal(native.openGroupById, f.groups.openGroupById);
    assert.equal(native.compareRecentChats({ last_mes: 1 }, { last_mes: 4 }), 3);
});

test('core requests use the original fetch, authenticated headers and native settings persistence', async () => {
    const f = startupFixture(true);
    const originalFetch = f.options.window.fetch;
    await initialize(f.options);
    const service = f.getServiceOptions();
    assert.ok(service);
    assert.equal(service.extensionSettings, f.extensions.extension_settings);
    assert.deepEqual(service.getRequestHeaders(), { token: 'csrf' });
    await service.saveSettings();
    f.options.window.fetch = () => { throw new Error('recursive intercepted service request'); };
    assert.deepEqual(await (await service.fetch('/api/groups/create')).json(), []);
    assert.ok(f.calls.some(call => call[0] === 'saveSettings'));
    assert.notEqual(f.options.window.fetch, originalFetch);
});

function readingFixture() {
    const calls = [];
    const events = new NativeEvents();
    const group = { id: '7', name: 'Remote', members: ['Same.png'], disabled_members: [], chats: ['a', 'b.jsonl'], chat_id: 'a' };
    const envelopes = [{ owner: { id: 'host', name: 'Host' }, group }];
    const window = {
        location: { href: 'https://tavern.example/' },
        fetch: async (url, options) => {
            calls.push(['nativeFetch', String(url), options]);
            if (String(url) === '/api/groups/all') {
                return Response.json([{ id: '7', name: 'Local', members: [] }]);
            }
            return Response.json([]);
        },
    };
    const document = new EventTarget();
    document.getElementById = () => null;
    document.querySelectorAll = () => [];
    const native = {
        groups: [], characters: [{ avatar: 'Same.png', name: 'Local' }], chat: [{ mes: 'Old' }], selectedGroup: null,
        eventSource: events, event_types: { CHARACTER_PAGE_LOADED: 'page', CHAT_CHANGED: 'chat' },
        default_avatar: '/img/ai4.png',
        getRequestHeaders: () => ({ token: 'csrf' }),
        clearChat: async () => { native.chat.splice(0); },
        printMessages: async () => { calls.push(['render', structuredClone(native.chat)]); },
        updateChatMetadata: metadata => { native.metadata = metadata; calls.push(['metadata', metadata]); },
        select_group_chats() {},
        reportError: error => { calls.push(['error', error.message]); },
        async openGroupById(id) {
            const selected = native.groups.find(group => group.id === id);
            assert.ok(selected, 'projection must exist before native opener');
            assert.ok(selected.members.every(member => native.characters.some(card => card.avatar === member)), 'cards must exist before native validation');
            native.selectedGroup = id;
            await native.clearChat();
            const response = await window.fetch('/api/chats/group/get', { method: 'POST', body: JSON.stringify({ id: selected.chat_id }) });
            const transcript = response.ok ? await response.json() : [];
            if (!transcript.length) {
                calls.push(['initializeAndSave']);
                await window.fetch('/api/chats/group/save', { method: 'POST', body: '[]' });
            }
            const metadata = transcript[0]?.chat_metadata ?? {};
            metadata.integrity ??= 'native-generated-integrity';
            if (Object.hasOwn(transcript[0] ?? {}, 'chat_metadata')) {
                transcript.shift();
            }
            native.chat.push(...transcript);
            await native.printMessages();
            native.updateChatMetadata(metadata, true);
            await events.emit('chat', selected.chat_id);
            calls.push(['nativeOpen', id]);
            return true;
        },
        async displayPastChats() {
            const response = await window.fetch('/api/chats/search', { method: 'POST', body: JSON.stringify({ group_id: native.selectedGroup, query: '' }) });
            calls.push(['chooser', await response.json()]);
        },
    };
    const service = {
        account: { id: 'guest', name: 'Guest' }, isDiscoverable: () => true, listAccounts: async () => [],
        mergeGroups: async local => [...local.map(group => ({ owner: { id: 'guest', name: 'Guest' }, group })), ...envelopes],
        loadGroup: async () => structuredClone(envelopes[0]),
        loadCharacters: async () => [{ avatar: 'Same.png', name: 'Remote character', data: { extensions: { world: 'World' } }, multiplayer: { accountId: 'host', filename: 'Same.png' } }],
        loadChat: async () => ({ metadata: { world_info: 'World' }, messages: [] }),
        listChats: async () => [{ file_id: 'b.jsonl', file_name: 'b.jsonl.jsonl', chat_items: 3, mes: 'Preview', last_mes: 123, file_size: '1kb', match: false }],
        characterImage: (owner, file) => `/api/plugins/multiplayer/accounts/${owner}/characters/${file}`,
    };
    const adapter = integration.createOwnershipNative?.({ window, document, native, service }) ?? { async mount() {}, async openGroup() {}, async openChat() {}, async showChats() {} };
    return { window, document, native, service, adapter, calls, group };
}

test('native opener establishes actual selected_group after source cards exist without initializing an empty saved chat', async () => {
    const f = readingFixture();
    await f.adapter.mount();
    await f.adapter.openGroup('host', '7');
    assert.ok(f.native.selectedGroup, 'must invoke native opener, not assign a context snapshot');
    assert.notEqual(f.native.selectedGroup, '7');
    assert.deepEqual(f.native.chat, []);
    assert.equal(f.calls.some(call => call[0] === 'initializeAndSave'), false);
    assert.deepEqual(f.group.members, ['Same.png']);
    assert.ok(f.calls.some(call => call[0] === 'nativeOpen'));
});

test('native open publishes one final saved metadata snapshot without leaking generated integrity', async () => {
    const f = readingFixture();
    await f.adapter.mount();
    const snapshots = [];
    f.native.eventSource.on('chat', () => { snapshots.push(structuredClone(f.native.metadata)); });
    await f.adapter.openGroup('host', '7');
    assert.deepEqual(snapshots, [{ world_info: 'World' }]);
    assert.equal(f.calls.filter(call => call[0] === 'render').length, 1);
});

test('a shared group without stored chat IDs can establish native context without creating a transcript', async () => {
    const f = readingFixture();
    f.group.chats = [];
    delete f.group.chat_id;
    await f.adapter.mount();
    await f.adapter.openGroup('host', '7');
    assert.ok(f.native.selectedGroup);
    assert.equal(f.calls.some(call => call[0] === 'initializeAndSave'), false);
    assert.deepEqual(f.native.chat, []);
});

test('switching to a local native chat discards a pending shared read', async () => {
    const f = readingFixture();
    await f.adapter.mount();
    await f.adapter.openGroup('host', '7');
    let resolveRead;
    f.service.loadChat = async () => new Promise(resolve => { resolveRead = resolve; });
    const pending = f.adapter.openChat('host', '7', 'a');
    await tick();
    f.native.selectedGroup = 'local';
    f.native.chat.splice(0, f.native.chat.length, { mes: 'Local chat' });
    await f.native.eventSource.emit('chat', 'local-chat');
    resolveRead({ metadata: {}, messages: [{ mes: 'Stale remote' }] });
    await pending;
    assert.deepEqual(f.native.chat, [{ mes: 'Local chat' }]);
});

test('native chooser search receives converted Plugin summaries and exact file IDs survive selection', async () => {
    const f = readingFixture();
    await f.adapter.mount();
    await f.adapter.openGroup('host', '7');
    await f.adapter.showChats('host', '7');
    const summaries = f.calls.find(call => call[0] === 'chooser')?.[1];
    assert.ok(summaries);
    assert.equal(summaries[0]?.message_count, 3);
    assert.equal(summaries[0]?.preview_message, 'Preview');
    assert.equal(summaries[0]?.file_id, 'b.jsonl');
    assert.equal(summaries[0]?.file_name, 'b.jsonl.jsonl');
    await f.adapter.openChat('host', '7', 'b.jsonl');
    assert.equal(f.native.groups.find(group => group.id === f.native.selectedGroup)?.chat_id, 'b.jsonl');
});

test('failed preloaded shared read does not invoke dangerous native opener or save', async () => {
    const f = readingFixture();
    const error = new Error('missing transcript');
    f.service.loadChat = async () => { throw error; };
    await f.adapter.mount();
    await assert.rejects(f.adapter.openGroup('host', '7'), /missing transcript/);
    assert.equal(f.native.selectedGroup, null);
    assert.deepEqual(f.native.chat, [{ mes: 'Old' }]);
    assert.equal(f.calls.some(call => call[0] === 'nativeOpen' || call[0] === 'initializeAndSave'), false);
});

test('late shared transcript cannot replace a newer selected chat', async () => {
    const f = readingFixture();
    await f.adapter.mount();
    await f.adapter.openGroup('host', '7');
    let resolveOld;
    f.service.loadChat = async (owner, group, id) => {
        if (id === 'a') {
            return new Promise(resolve => { resolveOld = resolve; });
        }
        return { metadata: {}, messages: [{ mes: 'New selection' }] };
    };
    const old = f.adapter.openChat('host', '7', 'a');
    await tick();
    await f.adapter.openChat('host', '7', 'b.jsonl');
    assert.ok(resolveOld, 'first shared read must have started');
    resolveOld({ metadata: {}, messages: [{ mes: 'Stale' }] });
    await old;
    assert.deepEqual(f.native.chat, [{ mes: 'New selection' }]);
});

test('native array reload restores already loaded owner cards before the next group display', async () => {
    const f = readingFixture();
    await f.adapter.mount();
    await f.adapter.openGroup('host', '7');
    f.native.characters = [{ avatar: 'Same.png', name: 'Local' }];
    f.native.groups = await (await f.window.fetch('/api/groups/all', { method: 'POST' })).json();
    const remote = f.native.groups.find(group => group.id === f.native.selectedGroup);
    assert.ok(remote);
    assert.ok(remote.members.every(member => f.native.characters.some(card => card.avatar === member)));
    assert.equal(f.native.characters.find(card => card.avatar === 'Same.png').name, 'Local');
});

test('native repeated listing refresh replaces arrays while preserving source projections', async () => {
    const f = readingFixture();
    await f.adapter.mount();
    for (let pass = 0; pass < 2; pass++) {
        f.native.characters = [{ avatar: 'Same.png', name: 'Local' }];
        f.native.groups = await (await f.window.fetch('/api/groups/all', { method: 'POST' })).json();
        assert.equal(f.native.groups.length, 2);
        await f.adapter.openGroup('host', '7');
        assert.ok(f.native.characters.some(card => card.name === 'Remote character'));
        assert.equal(f.native.characters.find(card => card.avatar === 'Same.png').name, 'Local');
    }
});

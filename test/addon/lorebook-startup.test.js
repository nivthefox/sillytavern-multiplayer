import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { initializeConversations } from '../../addon/conversation-bootstrap.js';

test('real conversation initializer loads and mounts the native lorebook module once and restores it on disposal', async t => {
    const dom = new JSDOM('<div id="chat"></div>', { url: 'http://192.168.1.10/' });
    t.after(() => dom.window.close());
    dom.window.fetch = async () => Response.json({});
    const cache = new Map([['Local', { entries: {} }]]);
    const originalHas = cache.has;
    const modules = {
        '/script.js': {
            chat: [], chat_metadata: {}, characters: [],
            event_types: { CHAT_CHANGED: 'chat_changed' },
            eventSource: { on() {}, removeListener() {} },
            getRequestHeaders: () => ({}), stopGeneration() {},
        },
        '/scripts/group-chats.js': { groups: [], selected_group: null },
        '/scripts/user.js': { currentUser: { handle: 'viewer' } },
        '/scripts/power-user.js': { power_user: {} },
        '/scripts/world-info.js': { worldInfoCache: cache, world_names: ['Local'], selected_world_info: [], world_info: {} },
        '/scripts/utils.js': { uuidv4: () => 'native-uuid' },
    };
    const loaded = [];
    const options = { window: dom.window, document: dom.window.document, loadModule: async path => { loaded.push(path); return modules[path] ?? {}; } };
    const controller = await initializeConversations(options);
    assert.ok(loaded.includes('/scripts/world-info.js'));
    assert.notEqual(cache.has, originalHas);
    assert.deepEqual(cache.get('Local'), { entries: {} });
    assert.equal(await initializeConversations(options), controller);
    assert.equal(loaded.filter(path => path === '/scripts/world-info.js').length, 1);
    await controller.dispose();
    assert.equal(cache.has, originalHas);
});

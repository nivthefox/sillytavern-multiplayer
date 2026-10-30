import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createOwnershipNative } from '../../addon/ownership-native.js';

async function settle() {
    await new Promise(resolve => setImmediate(resolve));
}

async function fixture(t, failInitially = false) {
    const dom = new JSDOM('<body><div id="extensions_settings"></div><div id="rm_group_chats_block"></div></body>');
    const events = new EventEmitter();
    let accounts = [{ id: 'old', name: 'Old choice', avatar: null }];
    let reads = 0;
    const service = {
        account: { id: 'creator', name: 'Creator' },
        isDiscoverable: () => true,
        setDiscoverable() {},
        async listAccounts() {
            reads++;
            if (failInitially && reads === 1) {
                throw new Error('Account listing unavailable');
            }
            return structuredClone(accounts);
        },
    };
    dom.window.fetch = async () => Response.json([]);
    const adapter = createOwnershipNative({
        service, document: dom.window.document, window: dom.window,
        native: { groups: [], characters: [], eventSource: events, event_types: {}, default_avatar: '/default.png', reportError() {} },
    });
    t.after(() => { adapter.dispose(); dom.window.close(); });
    await adapter.mount();
    const choices = () => [...dom.window.document.querySelectorAll('#multiplayer_group_accounts input')].map(input => input.value);
    return { dom, events, choices, setAccounts: value => { accounts = value; }, reads: () => reads };
}

test('each fresh native creation form gets a new eligible-account snapshot while an open form stays unchanged', async t => {
    const f = await fixture(t);
    assert.deepEqual(f.choices(), ['old']);
    f.setAccounts([{ id: 'new', name: 'New choice', avatar: null }]);
    const checkbox = f.dom.window.document.querySelector('#multiplayer_allow_group_invites input');
    checkbox.checked = false;
    checkbox.dispatchEvent(new f.dom.window.Event('change'));
    await settle();
    assert.deepEqual(f.choices(), ['old']);
    assert.equal(f.reads(), 1);
    f.events.emit('groupSelected', { detail: { id: 'local', group: { id: 'local' } } });
    f.events.emit('groupSelected', { detail: { id: null, group: undefined } });
    await settle();
    assert.deepEqual(f.choices(), ['new']);
    assert.equal(f.reads(), 2);
});

test('a fresh creation form retries account discovery after a startup listing failure', async t => {
    const f = await fixture(t, true);
    assert.deepEqual(f.choices(), []);
    f.events.emit('groupSelected', { detail: { id: null, group: undefined } });
    await settle();
    assert.deepEqual(f.choices(), ['old']);
    assert.equal(f.reads(), 2);
});

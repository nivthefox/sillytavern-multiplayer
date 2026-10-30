import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const moduleUrl = new URL('../../addon/conversation-native.js', import.meta.url);
const integration = await import(moduleUrl).catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes(moduleUrl.pathname)) {
        throw error;
    }
    return {};
});
const messageId = '11111111-1111-4111-8111-111111111111';
const identity = { accountId: 'host', groupId: '42', chatId: 'scene / one' };

function fixture(t, overrides = {}, options = {}) {
    assert.equal(typeof integration.createConversationNative, 'function');
    const dom = new JSDOM('<textarea id="send_textarea">new draft</textarea><div id="chat"></div>', { url: 'http://localhost/' });
    t.after(() => dom.window.close());
    const calls = [];
    const native = {
        chat: [], name1: 'Player', user_avatar: 'PC portrait.png',
        power_user: { message_token_count_enabled: true, trim_spaces: true, personas: { 'PC portrait.png': 'Player' } },
        regex_placement: { USER_INPUT: 1 },
        getRegexedString(text, placement, options) {
            calls.push(['regex', text, placement, options]);
            return text.replace('raw', 'filtered');
        },
        substituteParams: text => text.replace('{{user}}', 'Player'),
        getMessageTimeStamp: () => 'native timestamp',
        getBiasStrings: () => ({ messageBias: '' }),
        extractMessageBias: () => '',
        removeMacros: text => text.replace('{{bias}}', ''),
        getTokenCountAsync: async text => { calls.push(['tokens', text]); return 7; },
        populateFileAttachment: async message => {
            await Promise.resolve();
            message.extra.file = { url: '/user/files/note.txt' };
            message.extra.extension = { prepared: true };
        },
        processCommands: async text => text.startsWith('/'),
        saveChatConditional: async () => { calls.push(['save']); },
        getGroupChat: async (...args) => { calls.push(['ownerLoad', ...args]); },
        clearChat: async () => { native.chat.splice(0); },
        updateChatMetadata: metadata => { calls.push(['metadata', metadata]); },
        printMessages: async () => { calls.push(['render', structuredClone(native.chat)]); },
        ...overrides,
    };
    dom.window.fetch = async url => {
        calls.push(['fetch', String(url)]);
        return Response.json([]);
    };
    const adapter = integration.createConversationNative({ native, window: dom.window, document: dom.window.document, accountId: 'guest', randomUUID: () => messageId, ...options });
    t.after(() => adapter.dispose());
    return { adapter, native, calls, window: dom.window, document: dom.window.document };
}

test('guest preparation uses native helpers and snapshots persona, identity and awaited attachments without saving', async t => {
    const { adapter, native, calls } = fixture(t);
    const message = await adapter.prepareTurn('raw {{user}}');
    assert.equal(message.mes, 'filtered Player');
    assert.equal(message.name, 'Player');
    assert.equal(message.force_avatar, '/api/plugins/multiplayer/accounts/guest/personas/PC%20portrait.png');
    assert.equal(message.send_date, 'native timestamp');
    assert.equal(message.is_user, true);
    assert.equal(message.is_system, false);
    assert.deepEqual(message.extra.multiplayer, { accountId: 'guest', messageId });
    assert.equal(message.extra.token_count, 7);
    assert.deepEqual(message.extra.file, { url: '/user/files/note.txt' });
    assert.deepEqual(message.extra.extension, { prepared: true });
    assert.deepEqual(native.chat, []);
    assert.equal(calls.some(([name]) => name === 'save'), false);
    native.name1 = 'Later persona';
    native.user_avatar = 'later.png';
    assert.equal(message.name, 'Player');
    assert.match(message.force_avatar, /PC%20portrait\.png$/);
});

test('guest preparation retains native bias processing and skips disabled token counting', async t => {
    const { adapter, calls } = fixture(t, {
        power_user: { message_token_count_enabled: false, personas: {} },
        getBiasStrings: () => ({ messageBias: ' native bias' }),
    });
    const message = await adapter.prepareTurn('raw{{bias}}');
    assert.equal(message.mes, 'filtered');
    assert.equal(message.extra.bias, ' native bias');
    assert.equal(calls.some(([name]) => name === 'tokens'), false);
});

test('edit preparation uses native edit options without changing the message or initializing swipes', async t => {
    const { adapter, calls } = fixture(t);
    const message = { name: 'Original persona', mes: 'original', is_user: true, extra: { multiplayer: { messageId } } };
    const before = structuredClone(message);
    assert.equal(await adapter.prepareEdit(message, ' raw {{user}} '), 'filtered Player');
    assert.deepEqual(message, before);
    assert.deepEqual(calls.find(([name]) => name === 'regex'), ['regex', ' raw {{user}} ', 1, { characterOverride: 'Original persona', isEdit: true }]);
    assert.equal(calls.some(([name]) => name === 'save' || name === 'tokens'), false);
});

test('native command processing reports consumed input without preparing a player message', async t => {
    const { adapter, calls } = fixture(t);
    assert.equal(await adapter.processCommands('/echo hello'), true);
    assert.equal(await adapter.processCommands('hello'), false);
    assert.deepEqual(calls, []);
});

for (const transcript of [[], [{ chat_metadata: { world_info: 'Book' } }], [{ chat_metadata: { world_info: 'Book' } }, { mes: 'saved', is_user: false, extra: { extension: 1 } }]]) {
    test(`guest reload preserves composer and renders ${transcript.length} transcript records without initialization`, async t => {
        const { adapter, native, window, document, calls } = fixture(t);
        window.fetch = async url => {
            calls.push(['fetch', String(url)]);
            return Response.json(transcript);
        };
        const messages = await adapter.reload(identity, { isOwner: false });
        assert.deepEqual(messages, native.chat);
        assert.equal(document.querySelector('#send_textarea').value, 'new draft');
        assert.deepEqual(native.chat, transcript.filter(record => !('chat_metadata' in record)));
        assert.ok(calls.some(([name, url]) => name === 'fetch' && url === '/api/plugins/multiplayer/chats/host/groups/42/chats/scene%20%2F%20one'));
        assert.equal(calls.some(([name]) => name === 'save' || name === 'ownerLoad'), false);
        assert.ok(calls.some(([name]) => name === 'render'));
    });
}

test('failed guest read retains the displayed transcript and draft', async t => {
    const { adapter, native, window, document } = fixture(t);
    native.chat.push({ mes: 'previously saved' });
    window.fetch = async () => Response.json({ error: 'unavailable' }, { status: 500 });
    await assert.rejects(adapter.reload(identity, { isOwner: false }));
    assert.deepEqual(native.chat, [{ mes: 'previously saved' }]);
    assert.equal(document.querySelector('#send_textarea').value, 'new draft');
});

test('selected owner reload delegates to native group loading while preserving draft', async t => {
    const { adapter, calls, document } = fixture(t);
    await adapter.reload(identity, { isOwner: true });
    assert.deepEqual(calls, [['ownerLoad', '42', true]]);
    assert.equal(document.querySelector('#send_textarea').value, 'new draft');
});

for (const [responseStatus, expected] of [[200, 'saved'], [500, 'failed'], [null, 'uncertain']]) {
    test(`native save outcome is ${expected} from actual HTTP evidence, not helper resolution`, async t => {
        const { adapter, native, window } = fixture(t);
        window.fetch = async () => {
            if (responseStatus === null) {
                throw new TypeError('Lost response');
            }
            return Response.json(responseStatus === 200 ? { result: 'ok' } : { error: 'write failed' }, { status: responseStatus });
        };
        native.saveChatConditional = async () => {
            try {
                await window.fetch('/api/chats/group/save', { method: 'POST', body: JSON.stringify({ id: identity.chatId, chat: [] }) });
            } catch {
                return;
            }
        };
        adapter.mount();
        assert.equal((await adapter.save()).status, expected);
    });
}

test('external generation saves notify only after a successful native response', async t => {
    const saved = [];
    const { adapter, window } = fixture(t, {}, { onSave: outcome => saved.push(outcome) });
    window.fetch = async () => Response.json({ result: 'ok' });
    adapter.mount();
    await window.fetch('/api/chats/group/save', { method: 'POST' });
    assert.deepEqual(saved, [{ status: 'saved' }]);
});

test('authority guard blocks native shared saves before persistence', async t => {
    const { adapter, window } = fixture(t, {}, { canSave: () => false });
    let writes = 0;
    window.fetch = async () => { writes++; return Response.json({ result: 'ok' }); };
    adapter.mount();
    const response = await window.fetch('/api/chats/group/save', { method: 'POST' });
    assert.equal(response.ok, false);
    assert.equal(writes, 0);
});

test('queue mutations preserve prepared content without triggering independent saves', async t => {
    const { adapter, native, calls } = fixture(t);
    const message = { mes: 'prepared {{user}}', name: 'Other PC', is_user: true, extra: { multiplayer: { messageId }, extension: { value: 1 } } };
    await adapter.insertMessage(message);
    assert.deepEqual(adapter.getMessages(), [message]);
    assert.notEqual(native.chat[0].extra, message.extra);
    await adapter.insertMessage({ mes: 'AI', is_user: false });
    await adapter.editMessage(1, 'revised AI');
    assert.equal(native.chat[1].mes, 'revised AI');
    assert.equal(native.chat[1].swipes, undefined);
    await adapter.deleteMessage(0, { bulk: false });
    assert.deepEqual(native.chat, [{ mes: 'revised AI', is_user: false }]);
    assert.equal(calls.some(([name]) => name === 'save' || name === 'regex'), false);
});

test('a normally returning native helper without a persistence response does not confirm saving', async t => {
    const { adapter } = fixture(t);
    adapter.mount();
    assert.equal((await adapter.save()).status, 'uncertain');
});

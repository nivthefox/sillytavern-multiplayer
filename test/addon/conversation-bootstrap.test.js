import test from 'node:test';
import assert from 'node:assert/strict';

const { getConversationIdentity } = await import('../../addon/conversation-bootstrap.js').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') { throw error; }
    return {};
});

test('ordinary groups do not activate conversation interception', () => {
    assert.equal(typeof getConversationIdentity, 'function');
    assert.equal(getConversationIdentity({ id: 'g', chat_id: 'c' }), null);
});

test('owner group identity uses native group and account IDs', () => {
    assert.equal(typeof getConversationIdentity, 'function');
    assert.deepEqual(getConversationIdentity({ id: 12, chat_id: 'scene', multiplayer: { owner: 'alice', accounts: ['bob'] } }), { accountId: 'alice', groupId: '12', chatId: 'scene' });
});

test('guest group identity resolves ownership projection without losing source account', () => {
    assert.equal(typeof getConversationIdentity, 'function');
    assert.deepEqual(getConversationIdentity({ id: 'multiplayer-group:["alice","12"]', chat_id: 'scene', multiplayer: { owner: 'alice', accounts: ['bob'] } }), { accountId: 'alice', groupId: '12', chatId: 'scene' });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

const module = await import('../../addon/chat-ownership.js').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') {
        throw error;
    }
    return {};
});

function fixture(responses = []) {
    assert.equal(typeof module.createChatOwnership, 'function', 'chat ownership service must be implemented');
    const requests = [];
    const errors = [];
    const settings = { other: { retained: true } };
    let saves = 0;
    const service = module.createChatOwnership({
        account: { id: 'owner', name: 'Owner', avatar: null },
        extensionSettings: settings,
        saveSettings: () => { saves++; },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'token' }),
        reportError: error => errors.push(error),
        fetch: async (url, options) => {
            requests.push({ url, options });
            assert.ok(responses.length, `unexpected request: ${url}`);
            const next = responses.shift();
            if (next instanceof Error) {
                throw next;
            }
            return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
        },
    });
    return { service, requests, errors, settings, get saves() { return saves; } };
}

const group = { id: '42', name: 'Scene', members: ['A.png', 'B.png'], chats: ['chat'], chat_id: 'chat', extension: { retained: 1 } };
const ok = body => ({ body });

test('creation rejects missing characters before making any request', async () => {
    const f = fixture();
    await assert.rejects(f.service.createGroup({ members: [] }, ['guest']), /character/i);
    assert.deepEqual(f.requests, []);
});

test('creation saves the complete native record and both memberships before completing', async () => {
    const f = fixture([ok(group), ok({})]);
    const saved = await f.service.createGroup({ members: group.members }, ['guest', 'second']);
    assert.deepEqual(saved, { ...group, multiplayer: { owner: 'owner', accounts: ['guest', 'second'] } });
    assert.deepEqual(f.requests.map(r => r.url), ['/api/groups/create', '/api/groups/edit']);
    assert.deepEqual(JSON.parse(f.requests[1].options.body), saved);
    assert.equal(f.requests[1].options.headers['X-CSRF-Token'], 'token');
    assert.equal(f.requests[1].options.method, 'POST');
});

test('owner-only creation stores an empty accounts array', async () => {
    const f = fixture([ok(group), ok({})]);
    assert.deepEqual((await f.service.createGroup({ members: ['A.png'] })).multiplayer, { owner: 'owner', accounts: [] });
});

test('a failed ownership save is reported and retry saves the same group without recreating it', async () => {
    const f = fixture([ok(group), { status: 500, body: {} }, ok({})]);
    await assert.rejects(f.service.createGroup({ members: ['A.png'] }, ['guest']), /500/);
    assert.equal(f.errors.length, 1);
    const retried = await f.service.createGroup({ members: ['A.png'] }, ['guest']);
    assert.equal(retried.id, '42');
    assert.deepEqual(f.requests.map(r => r.url), ['/api/groups/create', '/api/groups/edit', '/api/groups/edit']);
    assert.deepEqual(JSON.parse(f.requests[2].options.body), JSON.parse(f.requests[1].options.body));
});

test('account choices use plugin names and avatars, exclude self, and are not rechecked at submission', async () => {
    const guest = { id: 'guest', name: 'Guest', avatar: 'data:image/png;base64,abc' };
    const f = fixture([ok([{ id: 'owner', name: 'Owner', avatar: null }, guest]), ok(group), ok({})]);
    assert.deepEqual(await f.service.listAccounts(), [guest]);
    await f.service.createGroup({ members: ['A.png'] }, ['guest']);
    assert.equal(f.requests.filter(r => r.url.endsWith('/accounts')).length, 1);
    assert.equal(f.requests[0].options.method, 'GET');
    assert.equal(f.requests[0].options.body, undefined);
});

test('discoverability defaults on and saves only native extension settings without fetching', async () => {
    const f = fixture();
    assert.equal(f.service.isDiscoverable(), true);
    await f.service.setDiscoverable(false);
    assert.equal(f.service.isDiscoverable(), false);
    assert.deepEqual(f.settings, { other: { retained: true }, multiplayer: { allowGroupInvites: false } });
    assert.equal(f.saves, 1);
    assert.deepEqual(f.requests, []);
});

test('discovery merges owned duplicates but keeps equal IDs from distinct owners', async () => {
    const local = { ...group, name: 'Local current' };
    const guest = { owner: { id: 'other', name: 'Other Name' }, group };
    const f = fixture([ok([{ owner: { id: 'owner', name: 'Owner' }, group }, guest])]);
    assert.deepEqual(await f.service.mergeGroups([local]), [{ owner: { id: 'owner', name: 'Owner', avatar: null }, group: local }, guest]);
    assert.equal(f.requests[0].url, '/api/plugins/multiplayer/chats');
});

test('guest group details, chat summaries and transcript use encoded owner-qualified GET routes', async () => {
    const envelope = { owner: { id: 'other account', name: 'Other' }, group };
    const summaries = [{ file_id: 'chat #1', file_name: 'chat #1.jsonl', chat_items: 2, mes: 'last', match: false }];
    const messages = [{ name: 'PC', is_user: true, mes: 'first', extra: { arbitrary: 1 } }, { name: 'NPC', original_avatar: 'A.png', mes: 'last', swipes: ['last'] }];
    const f = fixture([ok(envelope), ok(summaries), ok([{ chat_metadata: { world_info: 'Book', retained: 1 } }, ...messages])]);
    assert.deepEqual(await f.service.loadGroup('other account', 'group #1'), envelope);
    assert.deepEqual(await f.service.listChats('other account', 'group #1'), summaries);
    assert.deepEqual(await f.service.loadChat('other account', 'group #1', 'chat #1'), { metadata: { world_info: 'Book', retained: 1 }, messages });
    const base = '/api/plugins/multiplayer/chats/other%20account/groups/group%20%231';
    assert.deepEqual(f.requests.map(r => r.url), [base, `${base}/chats`, `${base}/chats/chat%20%231`]);
    assert.ok(f.requests.every(r => r.options.method === 'GET' && r.options.body === undefined));
});

for (const transcript of [[], [{ chat_metadata: { world_info: 'Book' } }]]) {
    test(`empty and metadata-only transcripts stay empty: ${JSON.stringify(transcript)}`, async () => {
        const f = fixture([ok(transcript)]);
        const loaded = await f.service.loadChat('other', '42', 'chat');
        assert.deepEqual(loaded.messages, []);
        assert.deepEqual(loaded.metadata, transcript[0]?.chat_metadata ?? {});
        assert.equal(f.requests.length, 1);
    });
}

for (const status of [403, 404, 500]) {
    test(`failed ${status} reads report an error and never initialize or overwrite chats`, async () => {
        const f = fixture([{ status, body: {} }]);
        await assert.rejects(f.service.loadChat('other', '42', 'chat'), new RegExp(String(status)));
        assert.equal(f.errors.length, 1);
        assert.equal(f.requests.length, 1);
        assert.equal(f.requests[0].options.method, 'GET');
    });
}

test('network and account listing errors are not converted into empty success', async () => {
    const f = fixture([new Error('offline'), { status: 500, body: {} }]);
    await assert.rejects(f.service.loadChat('other', '42', 'chat'), /offline/);
    await assert.rejects(f.service.listAccounts(), /500/);
    assert.equal(f.errors.length, 2);
});

test('character cards and portrait URLs retain the owner source and native filename', async () => {
    const card = { name: 'Owner NPC', data: { extensions: { world: 'Book' } } };
    const f = fixture([ok(card)]);
    assert.deepEqual(await f.service.loadCharacters('other account', ['A #1.png']), [{ ...card, avatar: 'A #1.png', multiplayer: { accountId: 'other account', filename: 'A #1.png' }, imageUrl: '/api/plugins/multiplayer/accounts/other%20account/characters/A%20%231.png' }]);
    assert.equal(f.requests[0].url, '/api/plugins/multiplayer/accounts/other%20account/characters/A%20%231.png/card');
    assert.equal(f.service.characterImage('other account', 'A #1.png'), '/api/plugins/multiplayer/accounts/other%20account/characters/A%20%231.png');
});

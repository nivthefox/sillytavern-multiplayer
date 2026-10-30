import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = new URL('../../addon/conversation-personas.js', import.meta.url);
const { createPersonaContext } = await import(moduleUrl).catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes(moduleUrl.pathname)) { throw error; }
    return {};
});

function message(accountId, filename, name = 'Player') {
    return { is_user: true, is_system: false, name, force_avatar: `/api/plugins/multiplayer/accounts/${encodeURIComponent(accountId)}/personas/${encodeURIComponent(filename)}`, extra: { multiplayer: { accountId } } };
}

function fixture(fetch = async () => Response.json({ description: 'A brave explorer.' }), formatDescription) {
    assert.equal(typeof createPersonaContext, 'function');
    const requests = [];
    const prompts = [];
    const context = createPersonaContext({
        accountId: 'owner', formatDescription, baseURL: 'https://tavern.example/', getRequestHeaders: () => ({ 'X-CSRF-Token': 'token' }),
        fetch: async (...args) => { requests.push(args); return fetch(...args); },
        setPrompt: text => prompts.push(text),
    });
    return { context, requests, prompts };
}

test('latest human message per other account selects the description and persona name', async () => {
    const h = fixture();
    await h.context.prepare([
        message('guest', 'old.png', 'Old PC'), message('owner', 'mine.png'),
        message('guest', 'new portrait.png', 'New PC'), message('second player', 'other.png', 'Other PC'),
        { ...message('guest', 'fake.png'), is_user: false },
    ]);
    assert.deepEqual(h.requests.map(([url]) => url), [
        '/api/plugins/multiplayer/accounts/guest/personas/new%20portrait.png/description',
        '/api/plugins/multiplayer/accounts/second%20player/personas/other.png/description',
    ]);
    assert.match(h.prompts.at(-1), /New PC/);
    assert.match(h.prompts.at(-1), /Other PC/);
    assert.match(h.prompts.at(-1), /A brave explorer\./);
    assert.doesNotMatch(h.prompts.at(-1), /Old PC/);
    assert.equal(h.requests[0][1].cache, 'no-store');
    assert.equal(h.requests[0][1].headers['X-CSRF-Token'], 'token');
});

test('native description formatting receives the guest persona rather than the owners name', async () => {
    const h = fixture(async () => Response.json({ description: '{{user}} is an explorer.' }), (description, persona) => description.replace('{{user}}', persona.name));
    await h.context.prepare([message('guest', 'pc.png', 'Guest PC')]);
    assert.match(h.prompts.at(-1), /Guest PC is an explorer\./);
    assert.doesNotMatch(h.prompts.at(-1), /\{\{user\}\}/);
});

test('each generation fetches current descriptions instead of reusing previous contents', async () => {
    let description = 'First';
    const h = fixture(async () => Response.json({ description }));
    await h.context.prepare([message('guest', 'pc.png')]);
    description = 'Revised';
    await h.context.prepare([message('guest', 'pc.png')]);
    assert.equal(h.requests.length, 2);
    assert.match(h.prompts.at(-1), /Revised/);
    assert.doesNotMatch(h.prompts.at(-1), /First/);
});

test('unknown attribution and mismatched portraits cannot select another account or fall back to an older persona', async () => {
    const h = fixture();
    await h.context.prepare([
        message('guest', 'old.png'),
        { ...message('guest', 'new.png'), force_avatar: '/api/plugins/multiplayer/accounts/someone-else/personas/new.png' },
        { ...message('unknown', 'pc.png'), extra: {} },
        { ...message('system', 'pc.png'), is_system: true },
    ]);
    assert.deepEqual(h.requests, []);
    assert.equal(h.prompts.at(-1), '');
});

test('an empty description contributes no context and owner-only history makes no requests', async () => {
    const h = fixture(async () => Response.json({ description: '' }));
    await h.context.prepare([message('guest', 'pc.png')]);
    assert.equal(h.prompts.at(-1), '');
    await h.context.prepare([message('owner', 'pc.png')]);
    assert.equal(h.requests.length, 1);
    assert.equal(h.prompts.at(-1), '');
});

for (const response of [() => Response.json({}, { status: 500 }), () => Response.json({ description: 5 })]) {
    test(`failed or malformed description reads do not leave stale context: ${response}`, async () => {
        const h = fixture(response);
        await assert.rejects(h.context.prepare([message('guest', 'pc.png')]));
        assert.equal(h.prompts.at(-1), '');
    });
}

test('clearing while HTTP reads are pending prevents old chat context from returning', async () => {
    let finish;
    const h = fixture(() => new Promise(resolve => { finish = resolve; }));
    const pending = h.context.prepare([message('guest', 'pc.png')]);
    h.context.clear();
    finish(Response.json({ description: 'Old scene' }));
    await pending;
    assert.equal(h.prompts.at(-1), '');
});

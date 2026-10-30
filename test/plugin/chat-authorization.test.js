import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Resources } from '../../plugin/resources.js';
import { createFixture } from './fixtures.js';

const chat = { accountId: 'owner', groupId: 'scene', chatId: 'later' };

test('chat join authorization checks access and existence without parsing saved conversation content', async t => {
    const fixture = await createFixture(t);
    const resources = new Resources(fixture.host);
    assert.equal(typeof resources.authorizeChat, 'function');
    await fixture.put('owner', 'groupChats', 'later.jsonl', 'not a saved JSON transcript');
    assert.equal(await resources.authorizeChat('guest', chat), undefined);
    await assert.rejects(resources.authorizeChat('stranger', chat), { status: 403 });
    await assert.rejects(resources.authorizeChat('guest', { ...chat, chatId: 'outside' }), { status: 403 });
    await assert.rejects(resources.authorizeChat('stranger', { ...chat, groupId: 'missing' }), { status: 403 });
    await assert.rejects(resources.authorizeChat('owner', { ...chat, groupId: 'missing' }), { status: 404 });
});

test('authorized joins reject missing referenced chat files and unsafe resource identifiers', async t => {
    const fixture = await createFixture(t);
    const resources = new Resources(fixture.host);
    assert.equal(typeof resources.authorizeChat, 'function');
    await fixture.put('owner', 'groups', 'scene.json', {
        ...fixture.group, chats: ['missing', '../settings'],
    });
    await assert.rejects(resources.authorizeChat('guest', { ...chat, chatId: 'missing' }), { status: 404 });
    await assert.rejects(resources.authorizeChat('guest', { ...chat, chatId: '../settings' }), { status: 403 });
});

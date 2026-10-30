import assert from 'node:assert/strict';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFixture, createHarness } from './fixtures.js';

async function setup(t) {
    const fixture = await createFixture(t);
    for (const account of ['owner', 'peer']) {
        await fixture.put(account, 'root', 'settings.json', {
            user_avatar: 'active.png',
            power_user: {
                persona_description: 'Active persona, not the requested one',
                persona_descriptions: {
                    'history.png': { description: `${account}'s saved description\n{{user}}`, title: 'Private title', lorebook: 'Book' },
                    'active.png': { description: 'Active persona' },
                },
            },
            unrelated: 'Do not expose settings',
        });
    }
    return { ...fixture, ...await createHarness(fixture.host) };
}

for (const [handle, accountID] of [['owner', 'owner'], ['guest', 'owner'], ['guest', 'peer']]) {
    test(`persona description: ${handle} reads ${accountID}'s saved inactive persona without leaking settings`, async t => {
        const f = await setup(t);
        const { res } = await f.request('personaDescription', { handle, values: { accountID } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'application/json');
        assert.deepEqual(res.body, { description: `${accountID}'s saved description\n{{user}}` });
    });
}

for (const settings of [
    {},
    { power_user: {} },
    { power_user: { persona_description: 'Do not fall back to the active persona' } },
    { power_user: { persona_descriptions: {} } },
    { power_user: { persona_descriptions: { 'history.png': {} } } },
    { power_user: { persona_descriptions: { 'history.png': { description: '' } } } },
]) {
    test('persona description: existing persona without a saved description returns an empty string', async t => {
        const f = await setup(t);
        await f.put('owner', 'root', 'settings.json', settings);
        const { res } = await f.request('personaDescription');
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { description: '' });
    });
}

for (const handle of [null, 'stranger']) {
    test(`persona description: ${handle ?? 'unauthenticated'} cannot read existing or missing personas`, async t => {
        const f = await setup(t);
        await f.put('owner', 'root', 'settings.json', '{broken');
        for (const filename of ['history.png', 'missing.png']) {
            const { res } = await f.request('personaDescription', { handle, values: { filename }, query: { accountId: 'owner' } });
            assert.equal(res.statusCode, 403);
        }
        assert.equal((await f.request('personaDescription', { handle, values: { accountID: 'absent' } })).res.statusCode, 403);
    });
}

test('persona description: missing avatar returns 404 even when a saved description remains', async t => {
    const f = await setup(t);
    await rm(join(f.directories.owner.avatars, 'history.png'));
    assert.equal((await f.request('personaDescription')).res.statusCode, 404);
});

test('persona description: missing source account returns 404 after shared membership establishes access', async t => {
    const f = await setup(t);
    f.profiles.splice(f.profiles.findIndex(account => account.handle === 'peer'), 1);
    assert.equal((await f.request('personaDescription', { values: { accountID: 'peer' } })).res.statusCode, 404);
});

for (const corruption of ['invalid JSON', 'unreadable settings', 'missing settings', 'non-string description']) {
    test(`persona description: ${corruption} returns 500 instead of an empty description`, async t => {
        const f = await setup(t);
        const settingsPath = join(f.directories.owner.root, 'settings.json');
        if (corruption === 'invalid JSON') {
            await f.put('owner', 'root', 'settings.json', '{broken');
        } else if (corruption === 'non-string description') {
            await f.put('owner', 'root', 'settings.json', { power_user: { persona_descriptions: { 'history.png': { description: 42 } } } });
        } else {
            await rm(settingsPath);
            if (corruption === 'unreadable settings') {
                await mkdir(settingsPath);
            }
        }
        assert.equal((await f.request('personaDescription')).res.statusCode, 500);
    });
}

for (const filename of ['../history.png', 'nested/../../history.png', '..\\history.png', 'bad\0.png']) {
    test(`persona description: rejects unsafe filename ${JSON.stringify(filename)}`, async t => {
        const f = await setup(t);
        assert.equal((await f.request('personaDescription', { values: { filename } })).res.statusCode, 403);
    });
}

test('persona description: refuses an avatar symlink outside the source directory', async t => {
    const f = await setup(t);
    const path = join(f.directories.owner.avatars, 'history.png');
    await rm(path);
    await symlink(join(f.directories.peer.avatars, 'history.png'), path);
    assert.equal((await f.request('personaDescription')).res.statusCode, 403);
});

test('persona description: reloads saved descriptions and membership on each request', async t => {
    const f = await setup(t);
    assert.equal((await f.request('personaDescription')).res.statusCode, 200);
    await f.put('owner', 'root', 'settings.json', { power_user: { persona_descriptions: { 'history.png': { description: 'Updated' } } } });
    assert.deepEqual((await f.request('personaDescription')).res.body, { description: 'Updated' });
    await f.put('owner', 'groups', 'scene.json', { ...f.group, multiplayer: { owner: 'owner', accounts: [] } });
    assert.equal((await f.request('personaDescription')).res.statusCode, 403);
});

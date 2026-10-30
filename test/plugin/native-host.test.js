import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import extract from 'png-chunks-extract';
import { decode } from 'png-chunk-text';

import { loadNativeHost } from '../../plugin/native-host.js';
import { createFixture } from './fixtures.js';

async function nativeFixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'multiplayer native host '));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(new URL('../../fixtures/native-host/server/', import.meta.url), root, { recursive: true });
    await cp(new URL('../../fixtures/native-host/node-persist/', import.meta.url), join(root, 'node_modules/node-persist'), { recursive: true });
    const storage = createRequire(join(root, 'package.json'))('node-persist');
    await storage.setItem('handles', ['owner', 'disabled']);
    const accounts = [{ handle: 'owner', name: 'Owner', enabled: true }, { handle: 'disabled', name: 'Disabled', enabled: false }];
    for (const account of accounts) {
        await storage.setItem(`user:${account.handle}`, account);
    }
    return { root, storage, accounts };
}

test('card fixture is a CRC-valid PNG with the expected embedded native card JSON', async t => {
    const fixture = await createFixture(t);
    const chunks = extract(fixture.png);
    const text = chunks.filter(chunk => chunk.name === 'tEXt').map(chunk => decode(chunk.data));
    const card = text.find(chunk => chunk.keyword === 'chara');
    assert.ok(card);
    assert.deepEqual(JSON.parse(Buffer.from(card.text, 'base64').toString('utf8')), fixture.card);
    assert.ok(chunks.some(chunk => chunk.name === 'IDAT'));
    assert.equal(chunks.at(-1).name, 'IEND');
});

test('native adapter resolves host-local modules and shares their existing account storage', async t => {
    const { root, storage, accounts } = await nativeFixture(t);
    const host = await loadNativeHost(root);
    assert.deepEqual(await host.listAccounts(), accounts);
    await storage.setItem('user:owner', { ...accounts[0], name: 'Changed' });
    assert.equal((await host.listAccounts())[0].name, 'Changed');
    assert.deepEqual(host.getDirectories('owner'), { root: '/native/owner' });
    assert.equal(host.readCard(Buffer.from('{"native":true}')), '{"native":true}');
    assert.equal(host.formatBytes(1024), '1024 native bytes');
    assert.equal(await host.getAvatar('owner'), null);
    const avatar = 'data:image/png;base64,aW1hZ2U=';
    await storage.setItem('avatar:owner', avatar);
    assert.equal(await host.getAvatar('owner'), avatar);
    await assert.rejects(host.getAvatar('broken'), /Storage unavailable/);
});

test('native adapter defaults to the server working directory rather than the symlinked plugin location', async t => {
    const { root, accounts } = await nativeFixture(t);
    const previous = process.cwd();
    process.chdir(root);
    try {
        const host = await loadNativeHost();
        assert.deepEqual(await host.listAccounts(), accounts);
    } finally {
        process.chdir(previous);
    }
});

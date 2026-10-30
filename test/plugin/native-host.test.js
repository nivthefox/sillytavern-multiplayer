import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import extract from 'png-chunks-extract';
import { decode } from 'png-chunk-text';

import { loadNativeHost } from '../../plugin/native-host.js';
import { createFixture } from './fixtures.js';

async function nativeFixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'multiplayer native host '));
    t.after(() => rm(root, { recursive: true, force: true }));
    const files = {
        'package.json': JSON.stringify({ type: 'module' }),
        'node_modules/node-persist/package.json': JSON.stringify({ name: 'node-persist', main: 'index.cjs' }),
        'node_modules/node-persist/index.cjs': `
            const values = new Map();
            module.exports = {
                getItem: async key => {
                    if (key === 'avatar:broken') { throw new Error('Storage unavailable'); }
                    return values.get(key);
                },
                setItem: async (key, value) => values.set(key, value),
            };
        `,
        'src/users.js': `
            import storage from 'node-persist';
            export const getAllUserHandles = async () => storage.getItem('handles');
            export const toKey = handle => 'user:' + handle;
            export const toAvatarKey = handle => 'avatar:' + handle;
            export const getUserDirectories = handle => ({ root: '/native/' + handle });
        `,
        'src/character-card-parser.js': 'export const read = buffer => buffer.toString("utf8");',
        'src/util.js': 'export const formatBytes = size => `${size} native bytes`;',
    };
    for (const [name, contents] of Object.entries(files)) {
        const path = join(root, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents);
    }
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

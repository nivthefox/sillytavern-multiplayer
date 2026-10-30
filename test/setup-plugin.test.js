import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

async function createSetupFixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'multiplayer-setup-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = join(root, 'checkout');
    const server = join(root, 'SillyTavern');
    const destination = join(server, 'plugins/multiplayer');
    const source = join(repository, 'plugin');
    await mkdir(join(repository, 'scripts'), { recursive: true });
    await mkdir(source);
    await mkdir(join(server, 'plugins'), { recursive: true });
    await copyFile(new URL('../scripts/setup-plugin.js', import.meta.url), join(repository, 'scripts/setup-plugin.js'));
    await writeFixturePackages(repository, server);
    await writeFile(join(server, 'config.yaml'), 'enableServerPlugins: false\n');
    const run = (...args) => spawnSync(process.execPath, [join(repository, 'scripts/setup-plugin.js'), ...args], { encoding: 'utf8' });
    return { repository, server, source, destination, run };
}

async function writeFixturePackages(repository, server) {
    const metadata = { name: 'setup-fixture', version: '1.0.0' };
    await writeFile(join(repository, 'package.json'), JSON.stringify({ ...metadata, type: 'module' }));
    await writeFile(join(repository, 'package-lock.json'), JSON.stringify({
        ...metadata,
        lockfileVersion: 3,
        packages: { '': metadata },
    }));
    await writeFile(join(server, 'package.json'), JSON.stringify({ name: 'sillytavern' }));
}

test('setup requires exactly one server path', async t => {
    const { server, run } = await createSetupFixture(t);
    for (const args of [[], [server, 'extra']]) {
        const result = run(...args);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Usage:/);
    }
});

test('setup rejects a directory that is not SillyTavern', async t => {
    const { server, destination, run } = await createSetupFixture(t);
    await writeFile(join(server, 'package.json'), JSON.stringify({ name: 'other' }));
    const result = run(server);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a SillyTavern/);
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
});

test('setup links the plugin into the server installation', async t => {
    const { server, source, destination, run } = await createSetupFixture(t);
    const result = run(server);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await realpath(destination), await realpath(source));
});

test('setup can be repeated for the same installation', async t => {
    const { server, source, destination, run } = await createSetupFixture(t);
    const first = run(server);
    assert.equal(first.status, 0, first.stderr);
    const second = run(server);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await realpath(destination), await realpath(source));
});

test('setup leaves the server configuration unchanged', async t => {
    const { server, run } = await createSetupFixture(t);
    const result = run(server);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(server, 'config.yaml'), 'utf8'), 'enableServerPlugins: false\n');
});

test('setup refuses to overwrite an existing directory', async t => {
    const { server, destination, run } = await createSetupFixture(t);
    await mkdir(destination);
    await writeFile(join(destination, 'keep.txt'), 'existing plugin');
    const result = run(server);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to overwrite/);
    assert.equal(await readFile(join(destination, 'keep.txt'), 'utf8'), 'existing plugin');
});

test('setup refuses a link to a different installation', async t => {
    const { repository, server, destination, run } = await createSetupFixture(t);
    await symlink(repository, destination, process.platform === 'win32' ? 'junction' : 'dir');
    const result = run(server);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to overwrite/);
    assert.equal(await realpath(destination), await realpath(repository));
});

test('setup refuses to overwrite a broken link', async t => {
    const { repository, server, destination, run } = await createSetupFixture(t);
    await symlink(join(repository, 'missing'), destination, process.platform === 'win32' ? 'junction' : 'dir');
    const result = run(server);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to overwrite/);
    assert.ok((await lstat(destination)).isSymbolicLink());
});

test('setup does not create the plugin link when dependency installation fails', async t => {
    const { repository, server, destination, run } = await createSetupFixture(t);
    await rm(join(repository, 'package-lock.json'));
    const result = run(server);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Dependency installation failed/);
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
});

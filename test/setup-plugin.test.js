import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('setup validates targets, links the plugin, is repeatable, and protects existing installations', async t => {
    const root = await mkdtemp(join(tmpdir(), 'multiplayer-setup-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = join(root, 'checkout');
    const server = join(root, 'SillyTavern');
    await mkdir(join(repository, 'scripts'), { recursive: true });
    await mkdir(join(repository, 'plugin'));
    await mkdir(server);
    await copyFile(new URL('../scripts/setup-plugin.js', import.meta.url), join(repository, 'scripts/setup-plugin.js'));
    await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'setup-fixture', version: '1.0.0', type: 'module' }));
    await writeFile(join(repository, 'package-lock.json'), JSON.stringify({ name: 'setup-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'setup-fixture', version: '1.0.0' } } }));
    const run = (...args) => spawnSync(process.execPath, [join(repository, 'scripts/setup-plugin.js'), ...args], { encoding: 'utf8' });
    assert.equal(run().status, 1);
    await writeFile(join(server, 'package.json'), JSON.stringify({ name: 'other' }));
    assert.match(run(server).stderr, /not a SillyTavern/);
    await writeFile(join(server, 'package.json'), JSON.stringify({ name: 'sillytavern' }));
    await writeFile(join(server, 'config.yaml'), 'enableServerPlugins: false\n');
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = run(server);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(await realpath(join(server, 'plugins/multiplayer')), await realpath(join(repository, 'plugin')));
    }
    assert.equal(await readFile(join(server, 'config.yaml'), 'utf8'), 'enableServerPlugins: false\n');
    await rm(join(server, 'plugins/multiplayer'));
    await mkdir(join(server, 'plugins/multiplayer'));
    assert.match(run(server).stderr, /Refusing to overwrite/);
});

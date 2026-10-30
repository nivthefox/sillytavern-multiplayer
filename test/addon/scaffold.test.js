import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../../addon/manifest.json', import.meta.url), 'utf8'));

test('manifest declares a native JavaScript browser entry', () => {
    assert.ok(manifest.display_name.length > 0);
    assert.equal(manifest.js, 'index.js');
    assert.ok(Number.isFinite(manifest.loading_order));
    assert.deepEqual(manifest.requires, []);
    assert.deepEqual(manifest.optional, []);
});

test('manifest and project versions agree', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

    assert.equal(manifest.version, packageJson.version);
    assert.equal(packageJson.type, 'module');
});

test('browser entry loads without SillyTavern or browser globals', async () => {
    const entry = await import(new URL(`../../addon/${manifest.js}`, import.meta.url));

    assert.deepEqual(Object.keys(entry), []);
});

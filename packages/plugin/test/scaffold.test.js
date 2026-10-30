import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { exit, info, init } from '../index.js';

test('package entry exposes the SillyTavern plugin contract', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const entry = await import(new URL(`../${packageJson.main}`, import.meta.url));

    assert.equal(entry.init, init);
    assert.equal(entry.exit, exit);
    assert.match(info.id, /^[a-z0-9_-]+$/);
    assert.ok(info.name.length > 0);
    assert.ok(info.description.length > 0);
});

test('initialization leaves the supplied router untouched', async () => {
    const router = new Proxy({}, {
        get() {
            assert.fail('The scaffold must not access router functionality');
        },
        set() {
            assert.fail('The scaffold must not modify the router');
        },
    });

    const result = init(router);
    assert.ok(result instanceof Promise);
    assert.equal(await result, undefined);
});

test('shutdown is safe before initialization and on repeated calls', async () => {
    assert.equal(await exit(), undefined);
    assert.equal(await exit(), undefined);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exit, info, init } from '../../plugin/index.js';

test('entry exposes the SillyTavern plugin contract', () => {
    assert.equal(typeof init, 'function');
    assert.equal(typeof exit, 'function');
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

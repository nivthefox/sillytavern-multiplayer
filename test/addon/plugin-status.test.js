import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getPluginStatus } from '../../addon/plugin-status.js';

test('detects the plugin using its dedicated same-origin endpoint', async () => {
    assert.equal(await getPluginStatus(async (url, options) => {
        assert.equal(url, '/api/plugins/multiplayer/status');
        assert.equal(options.cache, 'no-store');
        return Response.json({ plugin: 'multiplayer' });
    }), 'available');
});

test('distinguishes a missing plugin from authentication and server failures', async () => {
    for (const status of [401, 403, 500]) {
        assert.equal(await getPluginStatus(async () => new Response(null, { status })), 'unavailable');
    }
    assert.equal(await getPluginStatus(async () => new Response(null, { status: 404 })), 'missing');
});

test('handles network failures and unexpected responses without claiming the plugin is missing', async () => {
    for (const request of [
        async () => { throw new Error('Offline'); },
        async () => new Response('<html>Login</html>'),
        async () => Response.json({}),
    ]) {
        assert.equal(await getPluginStatus(request), 'unavailable');
    }
});

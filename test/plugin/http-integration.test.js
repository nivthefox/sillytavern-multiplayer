import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import express from 'express';

import { init } from '../../plugin/index.js';
import { createFixture } from './fixtures.js';

async function serve(t, options) {
    const app = express();
    app.use((req, res, next) => {
        if (req.headers['x-test-account']) {
            req.user = { profile: { handle: req.headers['x-test-account'] } };
        }
        if (req.method === 'POST' && req.headers['x-csrf-token'] !== 'valid') {
            return res.sendStatus(403);
        }
        next();
    });
    const router = express.Router();
    await init(router, options);
    app.use('/api/plugins/multiplayer', router);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close(error => error ? reject(error) : resolve());
    }));
    return `http://127.0.0.1:${server.address().port}/api/plugins/multiplayer`;
}

test('mounted accounts route uses native session identity and JSON content type', async t => {
    const base = await serve(t, { host: { listAccounts: async () => [] } });
    const denied = await fetch(`${base}/accounts?accountId=owner`);
    assert.equal(denied.status, 403);
    const response = await fetch(`${base}/accounts`, { headers: { 'x-test-account': 'owner' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(await response.json(), []);
});

test('ticket wrapper delegates the authenticated native request only after upstream CSRF validation', async t => {
    const calls = [];
    const ticket = { ticket: 'opaque-ticket', expiresAt: '2026-10-30T17:04:05.000Z' };
    const base = await serve(t, {
        host: {},
        issueTicket: async request => {
            calls.push(request);
            return ticket;
        },
    });
    for (const headers of [{}, { 'x-test-account': 'owner' }, { 'x-csrf-token': 'valid' }]) {
        const response = await fetch(`${base}/events/connect`, { method: 'POST', headers });
        assert.equal(response.status, 403);
    }
    assert.equal(calls.length, 0);
    const response = await fetch(`${base}/events/connect`, {
        method: 'POST',
        headers: { 'x-test-account': 'owner', 'x-csrf-token': 'valid' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), ticket);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].user.profile.handle, 'owner');
    assert.ok(calls[0].socket.server);
    assert.equal(calls[0].originalUrl, '/api/plugins/multiplayer/events/connect');
});

test('Express decodes each identifier once and preserves source-qualified resource contents', async t => {
    const fixture = await createFixture(t);
    const base = await serve(t, { host: fixture.host });
    const headers = { 'x-test-account': 'guest' };
    const response = await fetch(`${base}/accounts/owner/lore/${encodeURIComponent('World ü.json')}`, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), fixture.lore);
    await fixture.put('owner', 'worlds', '%2e%2e.json', { literal: true });
    const literal = await fetch(`${base}/accounts/owner/lore/${encodeURIComponent('%2e%2e.json')}`, { headers });
    assert.equal(literal.status, 200);
    assert.deepEqual(await literal.json(), { literal: true });
    const escape = await fetch(`${base}/accounts/owner/lore/..%2Fsettings.json`, { headers });
    assert.equal(escape.status, 403);
    const image = await fetch(`${base}/accounts/owner/characters/${encodeURIComponent('GM ü.png')}`, { headers });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), fixture.png);
});

test('persona description route decodes the filename and leaves the persona image route unchanged', async t => {
    const fixture = await createFixture(t);
    const filename = 'Past persona ü %.png';
    await fixture.put('owner', 'avatars', filename, fixture.persona);
    await fixture.put('owner', 'root', 'settings.json', {
        power_user: { persona_descriptions: { [filename]: { description: 'Saved persona' } } },
    });
    const base = await serve(t, { host: fixture.host });
    const url = `${base}/accounts/owner/personas/${encodeURIComponent(filename)}`;
    const headers = { 'x-test-account': 'guest' };
    const description = await fetch(`${url}/description`, { headers });
    assert.equal(description.status, 200);
    assert.match(description.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(await description.json(), { description: 'Saved persona' });
    const image = await fetch(url, { headers });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), fixture.persona);
});

test('rejected asynchronous ticket issuance completes with 500 without exposing error details', async t => {
    const base = await serve(t, {
        host: {},
        issueTicket: async () => { throw new Error('secret ticket data'); },
    });
    const response = await fetch(`${base}/events/connect`, {
        method: 'POST',
        headers: { 'x-test-account': 'owner', 'x-csrf-token': 'valid' },
    });
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /secret ticket data/);
});

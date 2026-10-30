import assert from 'node:assert/strict';
import { mkdir, rm, stat, symlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createFixture, createHarness, routes } from './fixtures.js';

const resourceRoutes = ['card', 'character', 'persona', 'lore', 'group', 'summaries', 'transcript'];
const valuesFor = route => route === 'lore' ? { filename: 'World ü.json' } : {};

async function setup(t, issuer) {
    const fixture = await createFixture(t);
    const harness = await createHarness(fixture.host, issuer);
    return { ...fixture, ...harness };
}

function jsonResponse(res, expected) {
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] ?? '', /^application\/json(?:;|$)/);
    const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
    if (expected !== undefined) { assert.deepEqual(body, expected); }
    return body;
}

for (const route of Object.keys(routes)) {
    test(`${route}: registers the public route and rejects unauthenticated requests before host reads or ticket issuance`, async t => {
        let tickets = 0;
        const f = await setup(t, () => { tickets++; throw new Error('Must authenticate first'); });
        f.calls.length = 0;
        for (const name of Object.keys(f.host)) {
            f.host[name] = () => { f.calls.push([name]); throw new Error('Must authenticate before reading'); };
        }
        const { res } = await f.request(route, { handle: null, values: valuesFor(route), body: { accountId: 'owner' }, query: { accountId: 'owner' } });
        assert.equal(res.statusCode, 403);
        assert.deepEqual(f.calls, []);
        assert.equal(tickets, 0);
    });
}

test('accounts: native handles, exact public shape, avatars, opt-out and enabled filtering including requester', async t => {
    const f = await setup(t);
    await f.put('guest', 'root', 'settings.json', { extension_settings: { multiplayer: { allowGroupInvites: true } } });
    const records = jsonResponse((await f.request('accounts', { handle: 'owner' })).res);
    assert.deepEqual(records.sort((a, b) => a.id.localeCompare(b.id)), [
        { id: 'guest', name: 'guest display', avatar: null },
        { id: 'owner', name: 'owner display', avatar: 'data:image/png;base64,b3duZXI=' },
        { id: 'peer', name: 'peer display', avatar: null },
        { id: 'stranger', name: 'stranger display', avatar: null },
    ]);
});

test('accounts: no eligible accounts returns an empty array', async t => {
    const f = await setup(t);
    for (const profile of f.profiles) { profile.enabled = false; }
    jsonResponse((await f.request('accounts')).res, []);
});

for (const failure of ['listAccounts', 'getAvatar', 'malformed settings', 'unreadable settings']) {
    test(`accounts: ${failure} returns 500 instead of an empty or partial list`, async t => {
        const f = await setup(t);
        if (failure === 'malformed settings') {
            await f.put('peer', 'root', 'settings.json', '{broken');
        } else if (failure === 'unreadable settings') {
            const path = join(f.directories.peer.root, 'settings.json');
            await rm(path);
            await mkdir(path);
        } else {
            f.host[failure] = async () => { throw new Error('Native account operation failed'); };
        }
        assert.equal((await f.request('accounts')).res.statusCode, 500);
    });
}

for (const handle of ['owner', 'guest']) {
    test(`character card and image: ${handle} reads raw native JSON and unchanged metadata-bearing bytes without an open chat`, async t => {
        const f = await setup(t);
        jsonResponse((await f.request('card', { handle })).res, f.card);
        const { res } = await f.request('character', { handle });
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'] ?? '', /^image\/png(?:;|$)/);
        assert.deepEqual(res.body, f.png);
        assert.ok(f.calls.some(([name, buffer]) => name === 'readCard' && buffer.equals(f.png)));
    });
}

for (const route of ['card', 'character']) {
    test(`${route}: sharing an account group does not authorize a character absent from its members`, async t => {
        const f = await setup(t);
        await f.put('owner', 'characters', 'private.png', f.png);
        for (const characterID of ['private.png', 'missing.png']) {
            assert.equal((await f.request(route, { values: { characterID } })).res.statusCode, 403);
        }
    });
    test(`${route}: a guest-owned card is not granted merely by sharing a third-party group`, async t => {
        const f = await setup(t);
        await f.put('peer', 'characters', 'GM ü.png', f.png);
        assert.equal((await f.request(route, { values: { accountID: 'peer' } })).res.statusCode, 403);
    });
}

for (const source of ['owner', 'peer']) {
    test(`persona and lore: guest reads ${source}'s historical portrait and complete unadvertised book through shared membership`, async t => {
        const f = await setup(t);
        const { res } = await f.request('persona', { values: { accountID: source } });
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'] ?? '', /^image\/png(?:;|$)/);
        assert.deepEqual(res.body, f.persona);
        jsonResponse((await f.request('lore', { values: { accountID: source, filename: 'World ü.json' } })).res, f.lore);
    });
}

test('persona: preserves JPEG bytes and image content type', async t => {
    const f = await setup(t);
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9]);
    await f.put('peer', 'avatars', 'old portrait.jpg', bytes);
    const { res } = await f.request('persona', { values: { accountID: 'peer', filename: 'old portrait.jpg' } });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] ?? '', /^image\/jpeg(?:;|$)/);
    assert.deepEqual(res.body, bytes);
});

for (const route of resourceRoutes) {
    test(`${route}: unrelated requester gets 403 for existing and missing resources, ignoring claimed caller identity`, async t => {
        const f = await setup(t);
        const existing = valuesFor(route);
        const missing = { ...existing, characterID: 'missing.png', filename: 'missing.json', groupID: 'missing', chatID: 'missing' };
        for (const values of [existing, missing, { ...missing, accountID: 'nonexistent' }]) {
            const { res } = await f.request(route, { handle: 'stranger', values, body: { accountId: 'owner' }, query: { handle: 'owner' } });
            assert.equal(res.statusCode, 403);
        }
    });
}

test('groups: owned native groups, implicit owner membership, and guest memberships are returned with native records', async t => {
    const f = await setup(t);
    const guestGroup = { ...f.group, multiplayer: { owner: 'guest', accounts: ['owner'] }, name: 'Guest storage' };
    await f.put('guest', 'groups', 'scene.json', guestGroup);
    const records = jsonResponse((await f.request('groups', { handle: 'owner' })).res);
    assert.deepEqual(records.sort((a, b) => `${a.owner.id}/${a.group.id}`.localeCompare(`${b.owner.id}/${b.group.id}`)), [
        { owner: { id: 'guest', name: 'guest display' }, group: guestGroup },
        { owner: { id: 'owner', name: 'owner display' }, group: f.nativeGroup },
        { owner: { id: 'owner', name: 'owner display' }, group: f.group },
    ]);
    jsonResponse((await f.request('accountGroups', { handle: 'owner' })).res,
        records.filter(record => record.owner.id === 'owner'));
});

test('groups: guest collection, account filtering, and detail agree without exposing unrelated or native private groups', async t => {
    const f = await setup(t);
    const expected = { owner: { id: 'owner', name: 'owner display' }, group: f.group };
    jsonResponse((await f.request('groups')).res, [expected]);
    jsonResponse((await f.request('accountGroups')).res, [expected]);
    jsonResponse((await f.request('group')).res, expected);
    jsonResponse((await f.request('accountGroups', { values: { accountID: 'stranger' } })).res, []);
    jsonResponse((await f.request('groups', { handle: 'hidden' })).res, []);
    assert.equal((await f.request('group', { values: { groupID: 'native' } })).res.statusCode, 403);
});

test('group: storage account determines ownership rather than multiplayer.owner', async t => {
    const f = await setup(t);
    const group = { ...f.group, multiplayer: { owner: 'stranger', accounts: ['guest'] } };
    await f.put('owner', 'groups', 'scene.json', group);
    jsonResponse((await f.request('group', { handle: 'owner' })).res, { owner: { id: 'owner', name: 'owner display' }, group });
    assert.equal((await f.request('group', { handle: 'stranger' })).res.statusCode, 403);
});

test('discoverability opt-out does not revoke existing group access', async t => {
    const f = await setup(t);
    await f.put('owner', 'root', 'settings.json', { extension_settings: { multiplayer: { allowGroupInvites: false } } });
    jsonResponse((await f.request('group')).res, { owner: { id: 'owner', name: 'owner display' }, group: f.group });
});

for (const handle of ['owner', 'guest']) {
    test(`transcript: ${handle} receives metadata header and every native and extension field in file order`, async t => {
        const f = await setup(t);
        jsonResponse((await f.request('transcript', { handle })).res, f.transcript);
    });
}

test('transcript: existing empty file returns an empty JSON array', async t => {
    const f = await setup(t);
    await f.put('owner', 'groupChats', 'later.jsonl', '');
    jsonResponse((await f.request('transcript')).res, []);
});

for (const handle of ['owner', 'guest']) {
    test(`transcript: ${handle} cannot read a chat outside the selected group whether present or missing`, async t => {
        const f = await setup(t);
        for (const chatID of ['unlisted', 'absent']) {
            assert.equal((await f.request('transcript', { handle, values: { chatID } })).res.statusCode, 403);
        }
    });
}

test('summaries: stored order, native fields, formatted byte size, message counts, placeholders, date fallbacks and no unrelated chats', async t => {
    const f = await setup(t);
    const group = { ...f.group, chats: ['later', 'empty', 'blank', 'earlier'] };
    await f.put('owner', 'groups', 'scene.json', group);
    await f.put('owner', 'groupChats', 'empty.jsonl', '');
    await f.put('owner', 'groupChats', 'blank.jsonl', [f.transcript[0], { name: 'Player', mes: '', is_user: true }].map(line => JSON.stringify(line)).join('\n'));
    const expected = [];
    for (const id of group.chats) {
        const path = join(f.directories.owner.groupChats, `${id}.jsonl`);
        await utimes(path, new Date('2025-01-01T00:00:00.000Z'), new Date('2025-01-01T00:00:00.000Z'));
        const stats = await stat(path);
        expected.push({ file_id: id, file_name: `${id}.jsonl`, file_size: `${stats.size} native bytes`,
            chat_items: id === 'later' ? 2 : id === 'blank' ? 1 : 0,
            mes: id === 'later' ? 'Last turn' : id === 'empty' ? '[The chat is empty]' : '[The message is empty]',
            last_mes: id === 'later' ? f.transcript[2].send_date : id === 'empty' ? stats.mtimeMs : new Date(Math.round(stats.mtimeMs)).toISOString(),
            match: id !== 'empty' });
    }
    jsonResponse((await f.request('summaries')).res, expected);
    assert.deepEqual(f.calls.filter(([name]) => name === 'formatBytes').map(([, size]) => size).sort((a, b) => a - b),
        (await Promise.all(group.chats.map(id => stat(join(f.directories.owner.groupChats, `${id}.jsonl`))))).map(entry => entry.size).sort((a, b) => a - b));
});

test('summaries: no referenced chats returns an empty array', async t => {
    const f = await setup(t);
    await f.put('owner', 'groups', 'scene.json', { ...f.group, chats: [] });
    jsonResponse((await f.request('summaries')).res, []);
});

const fileCases = [
    ['card', 'characters', 'GM ü.png'], ['character', 'characters', 'GM ü.png'],
    ['persona', 'avatars', 'history.png'], ['lore', 'worlds', 'World ü.json'],
    ['group', 'groups', 'scene.json'], ['summaries', 'groupChats', 'earlier.jsonl'],
    ['transcript', 'groupChats', 'later.jsonl'],
];

for (const [route, directory, filename] of fileCases) {
    test(`${route}: authorized missing file returns 404`, async t => {
        const f = await setup(t);
        await rm(join(f.directories.owner[directory], filename));
        const { res } = await f.request(route, { handle: route === 'group' ? 'owner' : 'guest', values: valuesFor(route) });
        assert.equal(res.statusCode, 404);
    });
    test(`${route}: existing unreadable file returns 500, not empty or partial success`, async t => {
        const f = await setup(t);
        const path = join(f.directories.owner[directory], filename);
        await rm(path);
        await mkdir(path);
        assert.equal((await f.request(route, { handle: 'owner', values: valuesFor(route) })).res.statusCode, 500);
    });
}

for (const route of ['group', 'summaries', 'transcript']) {
    test(`${route}: owner receives 404 for a missing group`, async t => {
        const f = await setup(t);
        assert.equal((await f.request(route, { handle: 'owner', values: { groupID: 'missing' } })).res.statusCode, 404);
    });
}

for (const route of ['groups', 'accountGroups', 'group', 'summaries', 'transcript']) {
    test(`${route}: malformed required group record returns 500`, async t => {
        const f = await setup(t);
        await f.put('owner', 'groups', 'scene.json', '{broken');
        assert.equal((await f.request(route, { handle: 'owner' })).res.statusCode, 500);
    });
}

for (const route of ['groups', 'accountGroups']) {
    test(`${route}: group directory read failure returns 500 instead of an empty listing`, async t => {
        const f = await setup(t);
        await rm(f.directories.owner.groups, { recursive: true });
        await f.put('owner', 'root', 'groups', 'not a directory');
        assert.equal((await f.request(route, { handle: 'owner' })).res.statusCode, 500);
    });
}

test('lore: malformed JSON returns 500', async t => {
    const f = await setup(t);
    await f.put('owner', 'worlds', 'World ü.json', '{bad');
    assert.equal((await f.request('lore', { values: valuesFor('lore') })).res.statusCode, 500);
});

for (const failure of ['throw', 'invalid JSON']) {
    test(`card: embedded metadata parser ${failure} returns 500`, async t => {
        const f = await setup(t);
        f.host.readCard = () => {
            if (failure === 'throw') { throw new Error('Corrupt PNG'); }
            return '{not JSON';
        };
        assert.equal((await f.request('card')).res.statusCode, 500);
    });
}

for (const route of ['transcript', 'summaries']) {
    test(`${route}: malformed middle JSONL line fails the whole response even with a valid last message`, async t => {
        const f = await setup(t);
        await f.put('owner', 'groupChats', 'later.jsonl', `${JSON.stringify(f.transcript[0])}\n{broken\n${JSON.stringify(f.transcript[2])}\n`);
        assert.equal((await f.request(route)).res.statusCode, 500);
    });
}

for (const [route, directory, filename] of fileCases) {
    test(`${route}: symlink outside the source resource directory never returns external content`, async t => {
        const f = await setup(t);
        const path = join(f.directories.owner[directory], filename);
        const external = await f.put('stranger', 'root', 'external', route === 'character' || route === 'persona' || route === 'card' ? f.png : JSON.stringify({ ...f.group, secret: 'outside' }));
        await rm(path);
        await symlink(external, path);
        const { res } = await f.request(route, { handle: 'owner', values: valuesFor(route) });
        assert.ok(res.statusCode >= 400, `External symlink must not succeed: ${route}`);
        assert.equal(f.calls.some(([name]) => name === 'readCard'), false);
    });
}

for (const [route, key, directory, suffix] of [
    ['card', 'characterID', 'characters', '.png'], ['character', 'characterID', 'characters', '.png'],
    ['persona', 'filename', 'avatars', '.png'], ['lore', 'filename', 'worlds', '.json'],
    ['group', 'groupID', 'groups', ''], ['transcript', 'chatID', 'groupChats', ''],
]) {
    for (const attack of ['../outside', 'nested/../../outside']) {
        test(`${route}: decoded path segment ${attack} cannot escape storage even when listed in membership`, async t => {
            const f = await setup(t);
            const identifier = `${attack}${suffix}`;
            const group = { ...f.group, members: [identifier], chats: [identifier] };
            await f.put('owner', 'groups', 'scene.json', group);
            await f.put('owner', 'root', `outside${suffix || (route === 'transcript' ? '.jsonl' : '.json')}`, route === 'lore' ? f.lore : route === 'group' ? group : route === 'transcript' ? JSON.stringify(f.transcript[0]) : f.png);
            await mkdir(join(f.directories.owner[directory], 'nested'));
            const { res } = await f.request(route, { handle: 'owner', values: { [key]: identifier } });
            assert.ok(res.statusCode >= 400, 'Traversal identifier must not return a successful resource');
            assert.equal(f.calls.some(([name]) => name === 'readCard'), false);
        });
    }
}

test('account identifier cannot escape to a sibling account directory', async t => {
    const f = await setup(t);
    const { res } = await f.request('lore', { values: { accountID: '../owner', filename: 'World ü.json' } });
    assert.ok(res.statusCode >= 400);
});

test('source isolation: matching group, chat, card, image, persona and lore names resolve to the selected account only', async t => {
    const f = await setup(t);
    const otherGroup = { ...f.group, name: 'Peer group', multiplayer: { owner: 'peer', accounts: ['guest'] } };
    const otherCard = { ...f.card, unknown: 'peer only' };
    const otherPng = Buffer.concat([f.png, Buffer.from('peer metadata')]);
    const otherPersona = Buffer.concat([f.persona, Buffer.from('peer')]);
    const otherLore = { entries: { 0: { content: 'Peer only', disable: true } } };
    const otherTranscript = [f.transcript[0], { name: 'Peer GM', mes: 'Peer only', send_date: '2026-01-01' }];
    f.cards.set(otherPng.toString('base64'), JSON.stringify(otherCard));
    await f.put('peer', 'groups', 'scene.json', otherGroup);
    await f.put('peer', 'characters', 'GM ü.png', otherPng);
    await f.put('peer', 'avatars', 'history.png', otherPersona);
    await f.put('peer', 'worlds', 'World ü.json', otherLore);
    for (const id of otherGroup.chats) { await f.put('peer', 'groupChats', `${id}.jsonl`, otherTranscript.map(line => JSON.stringify(line)).join('\n')); }
    for (const accountID of ['owner', 'peer']) {
        const peer = accountID === 'peer';
        const options = { values: { accountID } };
        jsonResponse((await f.request('group', options)).res, { owner: { id: accountID, name: `${accountID} display` }, group: peer ? otherGroup : f.group });
        jsonResponse((await f.request('card', options)).res, peer ? otherCard : f.card);
        assert.deepEqual((await f.request('character', options)).res.body, peer ? otherPng : f.png);
        assert.deepEqual((await f.request('persona', options)).res.body, peer ? otherPersona : f.persona);
        jsonResponse((await f.request('lore', { values: { accountID, filename: 'World ü.json' } })).res, peer ? otherLore : f.lore);
        jsonResponse((await f.request('transcript', options)).res, peer ? otherTranscript : f.transcript);
        const summaries = jsonResponse((await f.request('summaries', options)).res);
        assert.equal(summaries[0].mes, peer ? 'Peer only' : 'Last turn');
    }
});

test('connect: upstream-validated authenticated request reaches issuer unchanged, preserving session, socket and mount', async t => {
    let received;
    const ticket = { ticket: 'opaque-ticket', expiresAt: '2026-10-30T17:00:30.000Z' };
    const f = await setup(t, async req => { received = req; return ticket; });
    const socket = { server: { marker: 'native-server' } };
    const user = { profile: { handle: 'guest', name: 'Guest' }, sessionMarker: 'native-session' };
    const { req, res } = await f.request('connect', { user, socket });
    jsonResponse(res, ticket);
    assert.equal(received, req);
    assert.equal(received.user, user);
    assert.equal(received.socket, socket);
    assert.equal(received.originalUrl, '/api/plugins/multiplayer/events/connect');
    assert.equal(received.body, undefined);
});

for (const issuer of [undefined, () => { throw new Error('Ticket unavailable'); }, async () => { throw new Error('Async issuance failed'); }]) {
    test(`connect: ${issuer === undefined ? 'undefined issuer' : issuer.constructor.name} failure returns 500 when invoked`, async t => {
        const f = await setup(t, issuer);
        assert.equal((await f.request('connect')).res.statusCode, 500);
    });
}

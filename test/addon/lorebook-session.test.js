import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLorebookSession } from '../../addon/lorebook-session.js';

const chat = { accountId: 'owner', groupId: 'group', chatId: 'scene' };
const owner = { accountId: 'owner', connectionId: 'owner-tab' };
const guest = { accountId: 'guest', connectionId: 'guest-tab' };
const ref = (accountId = 'owner', filename = 'World.json') => ({ accountId, filename });
const book = (content = 'Saved world') => ({
    entries: {
        0: { uid: 0, content, disable: false, key: ['world'] },
        1: { uid: 1, content: 'GM secret', disable: true, key: [] },
    },
    extensionData: { retained: true },
});
const selections = (overrides = {}) => ({
    globalBooks: [], chatBook: '', personaBook: '', characters: [], ...overrides,
});
const contribution = filenames => ['server', 'multiplayer.lorebooks.set', { lorebooks: filenames }];
const response = data => ({ ok: true, status: 200, async json() { return structuredClone(data); } });

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fixture({ accountId = 'guest' } = {}) {
    const sends = [];
    const requests = [];
    const errors = [];
    let fetchResponse = async () => response(book());
    let sendError;
    const session = createLorebookSession({
        accountId,
        apiBase: '/api/plugins/multiplayer',
        async send(...args) {
            sends.push(structuredClone(args));
            if (sendError) {
                throw sendError;
            }
        },
        async fetch(url, options) {
            requests.push({ url, options });
            return fetchResponse(url, options);
        },
        isSelf: sender => sender?.connectionId === 'this-tab',
        onError: error => errors.push(error),
    });
    session.open(chat);
    return {
        session, sends, requests, errors,
        setFetch(value) { fetchResponse = value; },
        failSend(error) { sendError = error; },
        async join({ lorebooks = [], isOwner = false } = {}) {
            await session.joined({ isOwner, ownerPresent: true, lorebooks });
        },
    };
}

function advertised(h) {
    return h.session.getState().lorebooks;
}

test('selected owner publishes all associations including disabled characters, deduplicating filenames', async () => {
    const h = fixture({ accountId: 'owner' });
    await h.session.setSelections(selections({
        globalBooks: ['Global', 'Common'], chatBook: 'Chat', personaBook: 'Persona',
        characters: [
            { primaryBook: 'Primary', additionalBooks: ['Extra', 'Common'] },
            { primaryBook: 'Disabled', additionalBooks: ['Secret'], disabled: true },
        ],
    }));
    assert.deepEqual(h.sends, []);
    await h.join({ isOwner: true });
    assert.deepEqual(h.sends, [contribution(['Global.json', 'Common.json', 'Chat.json', 'Persona.json', 'Primary.json', 'Extra.json', 'Disabled.json', 'Secret.json'])]);
});

test('removing one owner association retains books referenced elsewhere and rebuilds rather than appending', async () => {
    const h = fixture({ accountId: 'owner' });
    await h.session.setSelections(selections({ globalBooks: ['Common', 'Gone'], chatBook: 'Common' }));
    await h.join({ isOwner: true });
    await h.session.setSelections(selections({ chatBook: 'Common' }));
    assert.deepEqual(h.sends.at(-1), contribution(['Common.json']));
    await h.session.setSelections(selections());
    assert.deepEqual(h.sends.at(-1), contribution([]));
});

for (const accountId of ['guest', 'owner']) {
    test(`${accountId} nonselected browser contributes only its persona and republishes switches and clearing`, async () => {
        const h = fixture({ accountId });
        await h.session.setSelections(selections({ globalBooks: ['Private'], chatBook: 'Private', personaBook: 'PC' }));
        await h.join();
        assert.deepEqual(h.sends, [contribution(['PC.json'])]);
        await h.session.setSelections(selections({ personaBook: 'New PC' }));
        await h.session.setSelections(selections());
        assert.deepEqual(h.sends.slice(1), [contribution(['New PC.json']), contribution([])]);
    });
}

test('join waits for local selections, including an explicitly loaded empty contribution', async () => {
    const h = fixture();
    await h.join();
    assert.deepEqual(h.sends, []);
    await h.session.setSelections(selections());
    assert.deepEqual(h.sends, [contribution([])]);
});

test('status gaining authority publishes owner selections without requiring another join', async () => {
    const h = fixture({ accountId: 'owner' });
    await h.session.setSelections(selections({ globalBooks: ['Global'], personaBook: 'PC' }));
    await h.join();
    await h.session.status({ isOwner: true, ownerPresent: true });
    assert.deepEqual(h.sends, [contribution(['PC.json']), contribution(['Global.json', 'PC.json'])]);
    assert.equal(h.session.getState().isOwner, true);
});

test('authority before selections are loaded waits, then publishes the owner union', async () => {
    const h = fixture({ accountId: 'owner' });
    await h.join();
    await h.session.status({ isOwner: true, ownerPresent: true });
    assert.deepEqual(h.sends, []);
    await h.session.setSelections(selections({ globalBooks: ['Global'] }));
    assert.deepEqual(h.sends, [contribution(['Global.json'])]);
});

test('disconnect retains books and defers selection publication until rejoin', async () => {
    const h = fixture();
    await h.session.setSelections(selections({ personaBook: 'Old' }));
    await h.join({ lorebooks: [ref()] });
    h.session.disconnected();
    assert.equal(h.session.getState().connected, false);
    assert.deepEqual(await h.session.read(ref()), book());
    await h.session.setSelections(selections({ personaBook: 'Current' }));
    assert.deepEqual(h.sends, [contribution(['Old.json'])]);
    await h.join({ lorebooks: [ref()] });
    assert.deepEqual(h.sends.at(-1), contribution(['Current.json']));
});

test('every successful rejoin republishes loaded selections and refreshes cached books', async () => {
    const h = fixture();
    await h.session.setSelections(selections());
    await h.join({ lorebooks: [ref()] });
    h.session.disconnected();
    h.setFetch(async () => response(book('Changed while offline')));
    await h.join({ lorebooks: [ref()] });
    assert.deepEqual(h.sends, [contribution([]), contribution([])]);
    assert.equal(h.requests.length, 2);
    assert.deepEqual(await h.session.read(ref()), book('Changed while offline'));
});

test('join loads complete contents through source-qualified encoded HTTP GET without a body', async () => {
    const h = fixture();
    const identity = ref('other account', 'A #?%.json');
    await h.join({ lorebooks: [identity] });
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, '/api/plugins/multiplayer/accounts/other%20account/lore/A%20%23%3F%25.json');
    assert.equal(h.requests[0].options?.method ?? 'GET', 'GET');
    assert.equal(h.requests[0].options?.body, undefined);
    assert.deepEqual(await h.session.read(identity), book());
    assert.equal(h.requests.length, 1);
});

test('list replacement fetches newly needed books, retains cached books, and stops exposing omissions', async () => {
    const h = fixture();
    await h.join({ lorebooks: [ref(), ref('owner', 'Gone.json')] });
    await h.session.receiveList({ lorebooks: [ref(), ref('another', 'New.json')] });
    assert.equal(h.requests.length, 3);
    assert.deepEqual(advertised(h), [ref(), ref('another', 'New.json')]);
    assert.deepEqual(await h.session.read(ref()), book());
    assert.equal(h.session.resolve('Gone'), undefined);
    assert.equal(await h.session.read(ref('owner', 'Gone.json')), undefined);
});

test('discovery combines every loaded primary card and chat metadata, appending the native extension', async () => {
    const h = fixture();
    await h.session.setDiscovery({
        characters: [
            { data: { extensions: { world: 'Primary' } } },
            { data: { extensions: { world: 'Disabled' } }, disabled: true },
            { data: { extensions: {} } },
        ],
        chatMetadata: { world_info: 'Chat' },
    });
    await h.join({ lorebooks: [ref('owner', 'Primary.json'), ref('guest', 'Persona.json')] });
    assert.deepEqual(new Set(advertised(h).map(value => JSON.stringify(value))), new Set([
        ref('owner', 'Primary.json'), ref('owner', 'Disabled.json'), ref('owner', 'Chat.json'), ref('guest', 'Persona.json'),
    ].map(value => JSON.stringify(value))));
    assert.equal(h.requests.filter(request => request.url.endsWith('/Primary.json')).length, 1);
    assert.ok(h.requests.some(request => request.url.endsWith('/accounts/owner/lore/Disabled.json')));
});

test('list omission retains discovered books until both sources withdraw them', async () => {
    const h = fixture();
    await h.session.setDiscovery({ characters: [], chatMetadata: { world_info: 'World' } });
    await h.join({ lorebooks: [ref()] });
    await h.session.receiveList({ lorebooks: [] });
    assert.deepEqual(await h.session.read('World'), book());
    assert.deepEqual(advertised(h), [ref()]);
    await h.session.setDiscovery({ characters: [], chatMetadata: {} });
    assert.deepEqual(advertised(h), []);
    assert.equal(await h.session.read('World'), undefined);
});

test('discovery updates retain books still listed by Plugin and remove unlisted old links', async () => {
    const h = fixture();
    await h.session.setDiscovery({ characters: [], chatMetadata: { world_info: 'World' } });
    await h.join({ lorebooks: [ref()] });
    await h.session.setDiscovery({ characters: [], chatMetadata: { world_info: 'New' } });
    assert.deepEqual(new Set(advertised(h).map(value => value.filename)), new Set(['World.json', 'New.json']));
    await h.session.setDiscovery({ characters: [], chatMetadata: {} });
    assert.deepEqual(advertised(h), [ref()]);
});

for (const malformed of [null, {}, { lorebooks: null }, { lorebooks: 'World.json' },
    { lorebooks: [null] }, { lorebooks: [{ accountId: '', filename: 'World.json' }] },
    { lorebooks: [{ accountId: 'owner', filename: 'World' }] },
    { lorebooks: [ref('new', 'New.json'), { accountId: 1, filename: 'World.json' }] }]) {
    test(`malformed list leaves the entire previous list and cache unchanged: ${JSON.stringify(malformed)}`, async () => {
        const h = fixture();
        await h.join({ lorebooks: [ref()] });
        await h.session.receiveList(malformed);
        assert.deepEqual(advertised(h), [ref()]);
        assert.deepEqual(await h.session.read(ref()), book());
        assert.equal(h.requests.length, 1);
    });
}

test('duplicate references are one availability identity and one HTTP load', async () => {
    const h = fixture();
    await h.join({ lorebooks: [ref(), ref()] });
    assert.deepEqual(advertised(h), [ref()]);
    assert.equal(h.requests.length, 1);
});

test('same-name cross-account books remain qualified and reject ambiguous bare-name access', async () => {
    const h = fixture();
    h.setFetch(async url => response(book(url.includes('/owner/') ? 'Owner' : 'Other')));
    await h.join({ lorebooks: [ref(), ref('other')] });
    assert.deepEqual(await h.session.read(ref()), book('Owner'));
    assert.deepEqual(await h.session.read(ref('other')), book('Other'));
    assert.throws(() => h.session.resolve('World'), /ambig/i);
    await assert.rejects(h.session.read('World'), /ambig/i);
});

test('shared name resolution overrides local fallback only while the shared chat is open', async () => {
    const h = fixture();
    const local = book('Local unchanged');
    const nativeRead = async name => h.session.resolve(name) ? h.session.read(name) : structuredClone(local);
    await h.join({ lorebooks: [ref()] });
    assert.deepEqual(h.session.resolve('World'), ref());
    assert.deepEqual(await nativeRead('World'), book());
    h.session.leave();
    assert.equal(h.session.resolve('World'), undefined);
    assert.deepEqual(await nativeRead('World'), local);
    assert.deepEqual(local, book('Local unchanged'));
});

for (const failure of ['403', '404', '500', 'network', 'json']) {
    test(`initial ${failure} failure reports load error and never substitutes an empty book or local fallback`, async () => {
        const h = fixture();
        h.setFetch(async () => {
            if (failure === 'network') {
                throw new Error('Offline');
            }
            if (failure === 'json') {
                return { ok: true, async json() { throw new SyntaxError('Invalid JSON'); } };
            }
            return { ok: false, status: Number(failure), async json() { return {}; } };
        });
        await h.join({ lorebooks: [ref()] });
        assert.equal(h.errors.length, 1);
        assert.ok(h.errors[0] instanceof Error);
        assert.deepEqual(h.session.resolve('World'), ref());
        await assert.rejects(h.session.read('World'));
    });
}

test('failed refresh retains the previously cached contents and reports the error', async () => {
    const h = fixture();
    await h.join({ lorebooks: [ref()] });
    h.setFetch(async () => ({ ok: false, status: 500 }));
    await h.session.saved(owner, { filename: 'World.json' });
    assert.equal(h.errors.length, 1);
    assert.deepEqual(await h.session.read(ref()), book());
});

test('failed reconnect refresh retains cached contents', async () => {
    const h = fixture();
    await h.join({ lorebooks: [ref()] });
    h.session.disconnected();
    h.setFetch(async () => { throw new Error('Offline again'); });
    await h.join({ lorebooks: [ref()] });
    assert.equal(h.errors.length, 1);
    assert.deepEqual(await h.session.read(ref()), book());
});

test('saved notifications refresh the bus sender account, not an account claimed by the body', async () => {
    const h = fixture();
    await h.join({ lorebooks: [ref(), ref('guest')] });
    h.setFetch(async () => response(book('New owner contents')));
    await h.session.saved(owner, { filename: 'World.json', accountId: 'guest' });
    assert.equal(h.requests.length, 3);
    assert.ok(h.requests.at(-1).url.endsWith('/accounts/owner/lore/World.json'));
    assert.deepEqual(await h.session.read(ref()), book('New owner contents'));
    assert.deepEqual(await h.session.read(ref('guest')), book());
});

for (const method of ['saved', 'deleted']) {
    test(`${method} ignores self, malformed and currently unshared notifications`, async () => {
        const h = fixture();
        await h.join({ lorebooks: [ref()] });
        for (const [sender, body] of [
            [{ ...owner, connectionId: 'this-tab' }, { filename: 'World.json' }],
            [owner, null], [null, { filename: 'World.json' }], [owner, {}],
            [owner, { filename: 'World' }], [owner, { filename: 1 }],
            [owner, { filename: 'Unshared.json' }], [guest, { filename: 'World.json' }],
        ]) {
            await h.session[method](sender, body);
        }
        assert.equal(h.requests.length, 1);
        assert.deepEqual(advertised(h), [ref()]);
        assert.deepEqual(await h.session.read(ref()), book());
        assert.deepEqual(h.sends, []);
    });
}

test('another tab in the source account is not mistaken for this saving browser', async () => {
    const h = fixture({ accountId: 'owner' });
    await h.join({ lorebooks: [ref()] });
    await h.session.saved(owner, { filename: 'World.json' });
    assert.equal(h.requests.length, 2);
});

test('confirmed local save publishes only for currently shared own-account books', async () => {
    const h = fixture({ accountId: 'owner' });
    await h.join({ lorebooks: [ref(), ref('guest', 'Guest.json')] });
    await h.session.confirmSaved('World.json');
    await h.session.confirmSaved('Unknown.json');
    await h.session.confirmSaved('Guest.json');
    assert.deepEqual(h.sends, [['all', 'multiplayer.lorebook.saved', { filename: 'World.json' }]]);
});

test('remote deletion removes Plugin list, discovery and cached contents, preserving other sources', async () => {
    const h = fixture();
    await h.session.setDiscovery({ characters: [], chatMetadata: { world_info: 'World' } });
    await h.join({ lorebooks: [ref(), ref('other')] });
    await h.session.deleted(owner, { filename: 'World.json' });
    assert.deepEqual(advertised(h), [ref('other')]);
    assert.equal(await h.session.read(ref()), undefined);
    assert.deepEqual(await h.session.read('World'), book());
    await h.session.receiveList({ lorebooks: [] });
    assert.deepEqual(advertised(h), []);
    assert.deepEqual(h.sends, []);
});

test('source-account deletion notification withdraws every association and republishes remaining contribution', async () => {
    const h = fixture({ accountId: 'owner' });
    await h.session.setSelections(selections({ globalBooks: ['World', 'Keep'], chatBook: 'World', personaBook: 'World' }));
    await h.join({ isOwner: true, lorebooks: [ref(), ref('owner', 'Keep.json')] });
    await h.session.deleted(owner, { filename: 'World.json' });
    assert.deepEqual(h.sends.at(-1), contribution(['Keep.json']));
    assert.deepEqual(advertised(h), [ref('owner', 'Keep.json')]);
    h.session.disconnected();
    await h.join({ isOwner: true, lorebooks: [ref('owner', 'Keep.json')] });
    assert.deepEqual(h.sends.at(-1), contribution(['Keep.json']));
});

test('confirmed local deletion cleans locally, broadcasts and republishes remaining contribution', async () => {
    const h = fixture({ accountId: 'guest' });
    await h.session.setSelections(selections({ personaBook: 'World' }));
    await h.join({ lorebooks: [ref('guest'), ref()] });
    await h.session.confirmDeleted('World.json');
    assert.equal(await h.session.read(ref('guest')), undefined);
    assert.deepEqual(advertised(h), [ref()]);
    assert.ok(h.sends.some(value => JSON.stringify(value) === JSON.stringify(['all', 'multiplayer.lorebook.deleted', { filename: 'World.json' }])));
    assert.ok(h.sends.some(value => JSON.stringify(value) === JSON.stringify(contribution([]))));
    const count = h.sends.length;
    await h.session.deleted({ ...guest, connectionId: 'this-tab' }, { filename: 'World.json' });
    assert.equal(h.sends.length, count);
});

test('stale loaded associations cannot re-advertise a deleted book during another selection change', async () => {
    const h = fixture({ accountId: 'owner' });
    await h.session.setSelections(selections({ globalBooks: ['World'], personaBook: 'PC' }));
    await h.session.setDiscovery({ chatMetadata: { world_info: 'World' } });
    await h.join({ isOwner: true, lorebooks: [ref()] });
    await h.session.deleted(owner, { filename: 'World.json' });
    await h.session.setSelections(selections({ globalBooks: ['World'], personaBook: 'New PC' }));
    await h.session.setDiscovery({ chatMetadata: { world_info: 'World' }, characters: [{ data: { extensions: { world: 'New' } } }] });
    assert.deepEqual(h.sends.at(-1), contribution(['New PC.json']));
    assert.equal(h.session.resolve('World'), undefined);
    await h.session.setSelections(selections({ personaBook: 'New PC' }));
    await h.session.setSelections(selections({ globalBooks: ['World'], personaBook: 'New PC' }));
    assert.deepEqual(h.sends.at(-1), contribution(['World.json', 'New PC.json']));
});

test('unshared local deletion does not broadcast or alter contribution', async () => {
    const h = fixture();
    await h.session.setSelections(selections({ personaBook: 'PC' }));
    await h.join({ lorebooks: [ref()] });
    await h.session.confirmDeleted('World.json');
    await h.session.confirmDeleted('Unknown.json');
    assert.deepEqual(h.sends, [contribution(['PC.json'])]);
    assert.deepEqual(advertised(h), [ref()]);
});

for (const transition of ['leave', 'switch', 'list removal', 'deletion']) {
    test(`late fetch cannot restore availability after ${transition}`, async () => {
        const h = fixture();
        const pending = deferred();
        h.setFetch(() => pending.promise);
        const joining = h.join({ lorebooks: [ref()] });
        assert.equal(h.requests.length, 1, 'the read must start before testing its late completion');
        if (transition === 'leave') {
            h.session.leave();
        } else if (transition === 'switch') {
            h.session.open({ ...chat, chatId: 'other-scene' });
        } else if (transition === 'list removal') {
            await h.session.receiveList({ lorebooks: [] });
        } else {
            await h.session.deleted(owner, { filename: 'World.json' });
        }
        pending.resolve(response(book('Stale')));
        await joining;
        assert.deepEqual(advertised(h), []);
        assert.equal(await h.session.read(ref()), undefined);
        assert.deepEqual(h.errors, []);
    });
}

test('remove and re-add of the same identity cannot adopt the original in-flight contents', async () => {
    const h = fixture();
    const pending = deferred();
    h.setFetch(() => pending.promise);
    const joining = h.join({ lorebooks: [ref()] });
    await h.session.receiveList({ lorebooks: [] });
    h.setFetch(async () => response(book('Current')));
    await h.session.receiveList({ lorebooks: [ref()] });
    pending.resolve(response(book('Stale')));
    await joining;
    assert.deepEqual(await h.session.read(ref()), book('Current'));
});

test('later refresh wins when saved-event HTTP responses complete out of order', async () => {
    const h = fixture();
    await h.join({ lorebooks: [ref()] });
    const pending = deferred();
    h.setFetch(() => pending.promise);
    const first = h.session.saved(owner, { filename: 'World.json' });
    h.setFetch(async () => response(book('Latest')));
    await h.session.saved(owner, { filename: 'World.json' });
    pending.resolve(response(book('Old')));
    await first;
    assert.deepEqual(await h.session.read(ref()), book('Latest'));
});

test('stale load failures from a left chat are discarded rather than displayed in the new chat', async () => {
    const h = fixture();
    const pending = deferred();
    h.setFetch(() => pending.promise);
    const joining = h.join({ lorebooks: [ref()] });
    assert.equal(h.requests.length, 1, 'the read must start before testing its stale rejection');
    h.session.open({ ...chat, chatId: 'different' });
    pending.reject(new Error('Old chat load failed'));
    await joining;
    assert.deepEqual(h.errors, []);
    assert.deepEqual(advertised(h), []);
});

test('snapshots and read results do not let consumers mutate shared identities or cached books', async () => {
    const h = fixture();
    const identity = ref();
    await h.join({ lorebooks: [identity] });
    identity.filename = 'Changed.json';
    const state = h.session.getState();
    state.lorebooks.length = 0;
    const loaded = await h.session.read(ref());
    assert.deepEqual(loaded, book());
    loaded.entries[0].content = 'Mutated';
    assert.deepEqual(advertised(h), [ref()]);
    assert.deepEqual(await h.session.read(ref()), book());
});

test('publication errors are reported without discarding shared cache', async () => {
    const h = fixture();
    await h.join({ lorebooks: [ref()] });
    h.failSend(new Error('Not connected'));
    await h.session.setSelections(selections({ personaBook: 'PC' }));
    assert.equal(h.errors.length, 1);
    assert.deepEqual(await h.session.read(ref()), book());
});

test('leaving clears selections so a new chat cannot publish old chat associations before loading', async () => {
    const h = fixture({ accountId: 'owner' });
    await h.session.setSelections(selections({ chatBook: 'Old' }));
    await h.join({ isOwner: true });
    h.session.leave();
    h.session.open({ ...chat, chatId: 'new' });
    await h.join({ isOwner: true });
    assert.deepEqual(h.sends, [contribution(['Old.json'])]);
    await h.session.setSelections(selections({ chatBook: 'New' }));
    assert.deepEqual(h.sends.at(-1), contribution(['New.json']));
});

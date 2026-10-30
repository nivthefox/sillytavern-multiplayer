import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import extract from 'png-chunks-extract';
import encodeChunks from 'png-chunks-encode';
import { decode, encode } from 'png-chunk-text';

import { init } from '../../plugin/index.js';

export const routes = {
    accounts: '/accounts',
    card: '/accounts/:accountID/characters/:characterID/card',
    character: '/accounts/:accountID/characters/:characterID',
    persona: '/accounts/:accountID/personas/:filename',
    lore: '/accounts/:accountID/lore/:filename',
    groups: '/chats',
    accountGroups: '/chats/:accountID/groups',
    group: '/chats/:accountID/groups/:groupID',
    summaries: '/chats/:accountID/groups/:groupID/chats',
    transcript: '/chats/:accountID/groups/:groupID/chats/:chatID',
    connect: '/events/connect',
};

/** Build a concrete URL from a contract route and decoded resource identifiers. */
export function urlFor(route, values = {}) {
    const params = { accountID: 'owner', characterID: 'GM ü.png', filename: 'history.png', groupID: 'scene', chatID: 'later', ...values };
    return routes[route].replace(/:([^/]+)/g, (_, key) => encodeURIComponent(params[key]));
}

/** Create a valid one-pixel RGBA PNG with native character metadata. */
export function createCardPng(card) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    return Buffer.from(encodeChunks([
        { name: 'IHDR', data: header },
        encode('chara', Buffer.from(JSON.stringify(card)).toString('base64')),
        { name: 'IDAT', data: deflateSync(Buffer.from([0, 0, 0, 0, 0])) },
        { name: 'IEND', data: Buffer.alloc(0) },
    ]));
}

/** Create isolated native-account storage and injectable host operations for one test. */
export async function createFixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'multiplayer-http-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const profiles = ['owner', 'guest', 'peer', 'stranger', 'disabled', 'hidden'].map(handle => ({
        handle, name: `${handle} display`, enabled: handle !== 'disabled',
        password: 'must-not-leak', salt: 'private', admin: handle === 'owner', discreet: true,
    }));
    const directories = {};
    for (const { handle } of profiles) {
        const accountRoot = join(root, handle);
        directories[handle] = { root: accountRoot, ...Object.fromEntries(
            ['groups', 'groupChats', 'characters', 'avatars', 'worlds'].map(key => [key, join(accountRoot, key)]),
        ) };
        await Promise.all(Object.values(directories[handle]).map(path => mkdir(path, { recursive: true })));
        await writeFile(join(accountRoot, 'settings.json'), JSON.stringify({ extension_settings: {
            multiplayer: handle === 'hidden' ? { allowGroupInvites: false } : {},
        } }));
    }
    const calls = [];
    const host = {
        async listAccounts() { calls.push(['listAccounts']); return profiles; },
        getDirectories(handle) { calls.push(['getDirectories', handle]); return directories[handle]; },
        async getAvatar(handle) { calls.push(['getAvatar', handle]); return handle === 'owner' ? 'data:image/png;base64,b3duZXI=' : null; },
        readCard(buffer) {
            calls.push(['readCard', buffer]);
            assert.ok(Buffer.isBuffer(buffer), 'readCard must receive the original file buffer');
            const text = extract(buffer).filter(chunk => chunk.name === 'tEXt').map(chunk => decode(chunk.data));
            const card = text.find(chunk => chunk.keyword.toLowerCase() === 'ccv3') ??
                text.find(chunk => chunk.keyword.toLowerCase() === 'chara');
            if (!card) { throw new Error('Invalid embedded card'); }
            return Buffer.from(card.text, 'base64').toString('utf8');
        },
        formatBytes(size) { calls.push(['formatBytes', size]); return `${size} native bytes`; },
    };
    const put = async (account, directory, filename, contents) => {
        const path = join(directories[account][directory], filename);
        await writeFile(path, typeof contents === 'string' || Buffer.isBuffer(contents) ? contents : JSON.stringify(contents));
        return path;
    };
    const group = { id: 'scene', name: 'Shared scene', members: ['GM ü.png'], chats: ['later', 'earlier'],
        disabled_members: ['GM ü.png'], multiplayer: { owner: 'owner', accounts: ['guest', 'peer'] }, extension: { preserved: true } };
    const nativeGroup = { id: 'native', name: 'Native owner group', members: ['GM ü.png'], chats: [] };
    const transcript = [
        { user_name: 'Player', character_name: 'GM', chat_metadata: { world_info: 'World', extension: { secret: 42 } } },
        { name: 'Player', is_user: true, is_system: false, mes: 'First turn', send_date: '2026-10-29T10:00:00.000Z',
            force_avatar: '/historical', extra: { multiplayer: { accountId: 'guest', messageId: 'stable' }, other: [1, 2] } },
        { name: 'GM', is_user: false, mes: 'Last turn', send_date: '2026-10-30T10:00:00.000Z',
            original_avatar: 'GM ü.png', swipes: ['Old', 'Last turn'], swipe_id: 1, extra: { arbitrary: true } },
    ];
    const lore = { entries: { 0: { uid: 0, content: 'GM secret', disable: true }, 1: { uid: 1, content: 'Public', disable: false } }, extension: { preserved: true } };
    const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'GM', extensions: { world: 'World', custom: [1, 2] } }, unknown: 'preserve' };
    const png = createCardPng(card);
    const persona = createCardPng({ name: 'Historical persona' });
    await put('owner', 'groups', 'scene.json', group);
    await put('owner', 'groups', 'native.json', nativeGroup);
    await put('stranger', 'groups', 'scene.json', { ...group, name: 'Unrelated', multiplayer: { owner: 'stranger', accounts: [] } });
    await put('owner', 'groupChats', 'later.jsonl', transcript.map(line => JSON.stringify(line)).join('\n') + '\n');
    await put('owner', 'groupChats', 'earlier.jsonl', JSON.stringify(transcript[0]) + '\n');
    await put('owner', 'groupChats', 'unlisted.jsonl', JSON.stringify({ name: 'Secret', mes: 'Not in group' }));
    await put('owner', 'characters', 'GM ü.png', png);
    for (const account of ['owner', 'guest', 'peer']) {
        await put(account, 'avatars', 'history.png', persona);
        await put(account, 'worlds', 'World ü.json', lore);
    }
    return { root, profiles, directories, host, calls, put, group, nativeGroup, transcript, lore, card, png, persona };
}

function response() {
    return {
        statusCode: 200, headers: {}, body: undefined, finished: false,
        status(code) { this.statusCode = code; return this; },
        set(name, value) {
            if (typeof name === 'object') {
                for (const [key, entry] of Object.entries(name)) { this.set(key, entry); }
                return this;
            }
            this.headers[name.toLowerCase()] = value;
            return this;
        },
        type(value) {
            const types = { json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
            return this.set('Content-Type', types[value] ?? value);
        },
        json(value) { this.type('json'); return this.send(value); },
        send(value) { this.body = value; this.finished = true; return this; },
        end(value) { if (value !== undefined) { this.body = value; } this.finished = true; return this; },
    };
}

/** Initialize the public plugin with a collecting router and invoke its registered handlers. */
export async function createHarness(host, issueTicket) {
    const registrations = [];
    const router = Object.fromEntries(['get', 'post'].map(method => [method, (path, ...handlers) => {
        registrations.push({ method: method.toUpperCase(), path, handlers: handlers.flat() });
        return router;
    }]));
    await init(router, { host, issueTicket });
    const request = async (route, { handle = 'guest', values, user, socket = { server: {} }, ...overrides } = {}) => {
        const method = route === 'connect' ? 'POST' : 'GET';
        const url = urlFor(route, values);
        const segments = url.split('/');
        const registration = registrations.find(entry => entry.method === method &&
            entry.path.split('/').length === segments.length && entry.path.split('/').every((part, i) => part.startsWith(':') || part === segments[i]));
        assert.ok(registration, `Missing route registration: ${method} ${routes[route]} (requested ${url})`);
        const params = Object.fromEntries(registration.path.split('/').flatMap((part, i) => part.startsWith(':') ? [[part.slice(1), decodeURIComponent(segments[i])]] : []));
        const req = { method, params, socket, originalUrl: `/api/plugins/multiplayer${url}`,
            user: user ?? (handle === null ? undefined : { profile: { handle } }), ...overrides };
        const res = response();
        const invoke = async index => {
            const handler = registration.handlers[index];
            if (!handler || res.finished) { return; }
            let nextResult;
            await handler(req, res, error => {
                if (error) { throw error; }
                nextResult = invoke(index + 1);
                return nextResult;
            });
            await nextResult;
        };
        await invoke(0);
        assert.ok(res.finished, `${method} ${url} must complete the response`);
        return { req, res };
    };
    return { registrations, request };
}

import { lookup } from 'mime-types';

import { loadNativeHost } from './native-host.js';
import { Resources } from './resources.js';

function handler(operation) {
    return async (request, response) => {
        response.set('Cache-Control', 'no-store');
        const requester = request.user?.profile?.handle;
        if (typeof requester !== 'string' || !requester) {
            return response.status(403).json({ error: 'Forbidden' });
        }
        try {
            return await operation(request, response, requester);
        } catch (error) {
            const status = [403, 404].includes(error?.status) ? error.status : 500;
            const message = { 403: 'Forbidden', 404: 'Not found', 500: 'Internal server error' }[status];
            return response.status(status).json({ error: message });
        }
    };
}

/**
 * Register read-only resources and the ticket HTTP wrapper on SillyTavern's router.
 * Native session and CSRF middleware must run before this router. No bus state is owned here.
 * @param {object} router SillyTavern's Express router, mounted at /api/plugins/multiplayer.
 * @param {object} [options] Native operations and event-bus integration.
 * @param {object} [options.host] Native account/storage helpers; defaults to the running host.
 * @param {function(object): Promise<object>} [options.issueTicket] Receives the original authenticated
 * request, attaches the bus if needed, and returns its ticket/expiresAt response. Missing or failing
 * issuers return 500; CSRF is enforced by SillyTavern upstream, not reimplemented here.
 * @returns {void}
 */
export function registerHttpRoutes(router, { host, issueTicket } = {}) {
    let resources;
    const getResources = async () => {
        resources ??= new Resources(host ?? await loadNativeHost());
        return resources;
    };

    router.get('/accounts', handler(async (request, response) => {
        const store = await getResources();
        return response.json(await store.accounts());
    }));
    router.get('/accounts/:accountID/characters/:characterID/card', handler(async (request, response, requester) => {
        const { accountID, characterID } = request.params;
        const store = await getResources();
        return response.json(await store.card(requester, accountID, characterID));
    }));
    router.get('/accounts/:accountID/characters/:characterID', handler(async (request, response, requester) => {
        const { accountID, characterID } = request.params;
        const store = await getResources();
        const image = await store.character(requester, accountID, characterID);
        return response.type('image/png').send(image);
    }));
    router.get('/accounts/:accountID/personas/:filename', handler(async (request, response, requester) => {
        const { accountID, filename } = request.params;
        const store = await getResources();
        const image = await store.persona(requester, accountID, filename);
        return response.type(lookup(filename) || 'application/octet-stream').send(image);
    }));
    router.get('/accounts/:accountID/lore/:filename', handler(async (request, response, requester) => {
        const { accountID, filename } = request.params;
        const store = await getResources();
        return response.json(await store.lore(requester, accountID, filename));
    }));
    router.get('/chats', handler(async (request, response, requester) => {
        const store = await getResources();
        return response.json(await store.groups(requester));
    }));
    router.get('/chats/:accountID/groups', handler(async (request, response, requester) => {
        const store = await getResources();
        return response.json(await store.groups(requester, request.params.accountID));
    }));
    router.get('/chats/:accountID/groups/:groupID', handler(async (request, response, requester) => {
        const { accountID, groupID } = request.params;
        const store = await getResources();
        return response.json(await store.group(requester, accountID, groupID));
    }));
    router.get('/chats/:accountID/groups/:groupID/chats', handler(async (request, response, requester) => {
        const { accountID, groupID } = request.params;
        const store = await getResources();
        return response.json(await store.summaries(requester, accountID, groupID));
    }));
    router.get('/chats/:accountID/groups/:groupID/chats/:chatID', handler(async (request, response, requester) => {
        const { accountID, groupID, chatID } = request.params;
        const store = await getResources();
        return response.json(await store.transcript(requester, accountID, groupID, chatID));
    }));
    router.post('/events/connect', handler(async (request, response) => {
        let ticket;
        try {
            ticket = await issueTicket(request);
        } catch {
            throw new Error('Ticket issuance failed');
        }
        return response.json(ticket);
    }));
}

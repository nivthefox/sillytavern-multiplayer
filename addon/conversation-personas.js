const apiBase = '/api/plugins/multiplayer';

function personaFromMessage(message, baseURL) {
    try {
        const path = new URL(message.force_avatar, baseURL).pathname.split('/');
        if (path.length !== 8 || path.slice(0, 5).join('/') !== `${apiBase}/accounts` || path[6] !== 'personas') { return null; }
        const accountId = decodeURIComponent(path[5]);
        const filename = decodeURIComponent(path[7]);
        if (accountId !== message.extra.multiplayer.accountId || !filename || filename.includes('/') || filename.includes('\\') || ['.', '..'].includes(filename)) { return null; }
        return { accountId, filename, name: message.name || accountId };
    } catch {
        return null;
    }
}

function latestPersonas(messages, accountId, baseURL) {
    const latest = new Map();
    for (const message of messages) {
        const author = message.extra?.multiplayer?.accountId;
        if (message.is_user !== true || message.is_system || typeof author !== 'string' || !author || author === accountId) { continue; }
        latest.set(author, message);
    }
    return [...latest.values()].map(message => personaFromMessage(message, baseURL)).filter(Boolean);
}

/**
 * Fetches other participants' latest spoken persona descriptions for a shared generation.
 * The caller owns native prompt placement; clearing invalidates pending HTTP reads.
 * @param {object} options Authenticated account, HTTP transport, prompt setter and native macro formatter.
 * @returns {object} Preparation and cleanup operations for this browser's shared persona context.
 */
export function createPersonaContext({ accountId, fetch, setPrompt, getRequestHeaders = () => ({}), baseURL = globalThis.location?.href, formatDescription = description => description }) {
    let sequence = 0;

    function clear() {
        sequence++;
        setPrompt('');
    }

    async function descriptionFor(persona) {
        const url = `${apiBase}/accounts/${encodeURIComponent(persona.accountId)}/personas/${encodeURIComponent(persona.filename)}/description`;
        const response = await fetch(url, { cache: 'no-store', headers: getRequestHeaders() });
        if (!response.ok) { throw new Error(`Could not load ${persona.name}'s persona description (${response.status}).`); }
        const body = await response.json();
        if (typeof body?.description !== 'string') { throw new Error(`Invalid persona description for ${persona.name}.`); }
        if (!body.description.trim()) { return ''; }
        return `Persona for ${persona.name} (${persona.accountId}):\n${formatDescription(body.description, persona)}`;
    }

    return {
        /** @returns {void} Removes this feature's prompt context and invalidates earlier requests. */
        clear,
        /**
         * Reloads descriptions selected by the latest saved human message from each other account.
         * @param {object[]} messages Saved native transcript messages.
         * @returns {Promise<boolean>} True once installed; false if superseded. Current read failures reject.
         */
        async prepare(messages) {
            clear();
            const request = sequence;
            try {
                const personas = latestPersonas(messages, accountId, baseURL);
                const descriptions = await Promise.all(personas.map(descriptionFor));
                if (request !== sequence) { return false; }
                setPrompt(descriptions.filter(Boolean).join('\n\n'));
                return true;
            } catch (error) {
                if (request !== sequence) { return false; }
                throw error;
            }
        },
    };
}

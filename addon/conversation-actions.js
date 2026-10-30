const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads the stable identity shared by a native message and its revisions.
 * @param {object} message Native message.
 * @returns {string|undefined} Stored message UUID.
 */
export function messageId(message) {
    return message?.extra?.multiplayer?.messageId;
}

/**
 * Assigns an AI message identity before preview/persistence and preserves it in its selected swipe.
 * @param {object} message Native message to update.
 * @param {Function} [randomUUID] UUID factory.
 * @returns {string} Stable message UUID.
 */
export function ensureMessageIdentity(message, randomUUID = () => crypto.randomUUID()) {
    message.extra ??= {};
    message.extra.multiplayer ??= {};
    message.extra.multiplayer.messageId ??= randomUUID();
    const id = messageId(message);
    const revision = message.swipe_info?.[message.swipe_id];
    if (revision) {
        revision.extra ??= {};
        revision.extra.multiplayer = { ...revision.extra.multiplayer, messageId: id };
    }
    return id;
}

/**
 * Checks a requested action against a saved transcript, not bus acceptance or edit history.
 * @param {'send'|'edit'|'delete'} type Action name.
 * @param {object} body Prepared request.
 * @param {object[]} messages Saved messages.
 * @returns {boolean} Whether the current saved state confirms the action.
 */
export function confirmAction(type, body, messages) {
    const id = type === 'send' ? messageId(body.message) : body.messageId;
    const target = messages.find(message => messageId(message) === id);
    if (type === 'send') { return Boolean(target); }
    if (type === 'delete') { return !target; }
    return Boolean(target && target.mes === body.text);
}

/**
 * Appends a human revision with independent native swipe metadata.
 * @param {object} message Native player message to update.
 * @param {string} text Prepared replacement text.
 * @returns {void}
 */
export function appendPlayerRevision(message, text) {
    if (!Array.isArray(message.swipes) || message.swipes.length === 0) {
        message.swipes = [message.mes];
        message.swipe_id = 0;
        message.swipe_info = [{ send_date: message.send_date, extra: structuredClone(message.extra ?? {}) }];
    }
    message.swipe_info ??= message.swipes.map(() => ({ send_date: message.send_date, extra: structuredClone(message.extra ?? {}) }));
    message.swipes.push(text);
    message.swipe_info.push({ send_date: message.send_date, extra: structuredClone(message.extra ?? {}) });
    message.swipe_id = message.swipes.length - 1;
    message.mes = text;
}

function actionIdentity(type, body) {
    return type === 'send' ? messageId(body?.message) : body?.messageId;
}

function validAction(type, body) {
    if (!isRecord(body) || !Number.isInteger(body.iteration) || body.iteration < 0) { return false; }
    if (!uuidPattern.test(actionIdentity(type, body) ?? '')) { return false; }
    if (type === 'delete') { return body.bulk === undefined || typeof body.bulk === 'boolean'; }
    if (type === 'edit') { return typeof body.text === 'string'; }
    if (type !== 'send') { return false; }
    const message = body.message;
    return isRecord(message) && message.is_user === true && message.is_system === false
        && typeof message.mes === 'string' && typeof message.name === 'string'
        && typeof message.force_avatar === 'string' && typeof message.send_date === 'string'
        && isRecord(message.extra) && isRecord(message.extra.multiplayer);
}

function attributedMessage(message, accountId) {
    const prepared = structuredClone(message);
    const pathname = new URL(prepared.force_avatar, 'https://multiplayer.invalid').pathname;
    const match = pathname.match(/\/accounts\/[^/]+\/personas\/([^/]+)$/u);
    if (!match) { throw new Error('Invalid persona portrait.'); }
    const filename = decodeURIComponent(match[1]);
    if (!filename || filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') {
        throw new Error('Invalid persona portrait.');
    }
    prepared.force_avatar = `/api/plugins/multiplayer/accounts/${encodeURIComponent(accountId)}/personas/${encodeURIComponent(filename)}`;
    prepared.extra.multiplayer = { ...prepared.extra.multiplayer, accountId };
    return prepared;
}

/**
 * Serializes authoritative native changes and generation behind confirmed save outcomes.
 * @param {object} options Native adapter, bus, authenticated account and local outcome callbacks.
 * @returns {object} Authority controls, action queue and generation barrier.
 */
export function createConversationActions({ native, accountId, bus, isCurrent = () => true, onLocalFailure = () => {}, onLocalSaved = () => {} }) {
    let authority = false;
    let generating = false;
    let epoch = 0;
    let tail = Promise.resolve();
    let needsRestore = false;
    let recoveryBlocked = false;
    let runningNative = false;

    function current(token) { return authority && token === epoch && isCurrent(); }

    async function failure(type, body, sender, reason) {
        const id = actionIdentity(type, body);
        if (!id || !Number.isInteger(body?.iteration)) { return; }
        if (!sender) {
            await onLocalFailure(type, body, reason);
            return;
        }
        const payload = { messageId: id, iteration: body.iteration, reason };
        if (type === 'edit') { payload.text = body.text; }
        await bus.send(sender.connectionId, `multiplayer.message.${type}_failure`, payload);
    }

    async function acknowledge(sender, messages) {
        if (sender) {
            await bus.send(sender.connectionId, 'multiplayer.chat.saved', {});
            return;
        }
        await onLocalSaved(messages);
    }

    function permission(type, target, sender, body) {
        if (sender && body.bulk) { return false; }
        if (!target) { return true; }
        const ownPlayer = target.is_user === true && target.extra?.multiplayer?.accountId === (sender?.accountId ?? accountId);
        if (sender) { return ownPlayer; }
        if (type === 'delete') { return true; }
        return ownPlayer || target.is_user === false;
    }

    async function apply(type, body, sender) {
        if (type === 'send') {
            await native.insertMessage(attributedMessage(body.message, sender?.accountId ?? accountId));
            return;
        }
        const messages = native.getMessages();
        const index = messages.findIndex(message => messageId(message) === body.messageId);
        if (type === 'delete') {
            await native.deleteMessage(index, { bulk: !sender && body.bulk === true });
            return;
        }
        if (messages[index].is_user) {
            appendPlayerRevision(messages[index], body.text);
            return;
        }
        await native.editMessage(index, body.text);
    }

    async function process(type, body, sender, token) {
        if (!current(token)) { return; }
        if (needsRestore) {
            await native.loadSaved();
            if (!current(token)) { return; }
            needsRestore = false;
            recoveryBlocked = false;
        }
        if (!validAction(type, body)) {
            await failure(type, body, sender, 'Invalid message request.');
            return;
        }
        if (sender && body.bulk) {
            await failure(type, body, sender, 'Bulk deletion is only available to the selected owner.');
            return;
        }
        if (body.iteration > 0) {
            const saved = await native.loadSaved();
            if (!current(token)) { return; }
            if (confirmAction(type, body, saved)) {
                await acknowledge(sender, saved);
                return;
            }
        }
        const target = native.getMessages().find(message => messageId(message) === actionIdentity(type, body));
        if (type === 'edit' && !target) {
            await failure(type, body, sender, 'This message has been deleted.');
            return;
        }
        if (type === 'delete' && !target) {
            await acknowledge(sender, native.getMessages());
            return;
        }
        if (type !== 'send' && !permission(type, target, sender, body)) {
            await failure(type, body, sender, 'You cannot change this message.');
            return;
        }
        if (type === 'send' && target) {
            await acknowledge(sender, native.getMessages());
            return;
        }
        try {
            needsRestore = true;
            await apply(type, body, sender);
        } catch (error) {
            recoveryBlocked = true;
            if (current(token)) { await failure(type, body, sender, error.message); }
            return;
        }
        if (!current(token)) { return; }
        let outcome;
        try {
            outcome = await native.save();
        } catch {
            outcome = { status: 'uncertain' };
        }
        if (!current(token)) { return; }
        if (outcome?.status === 'saved') {
            needsRestore = false;
            recoveryBlocked = false;
            await native.render();
            if (!current(token)) { return; }
            await onLocalSaved(native.getMessages());
            await bus.send('all', 'multiplayer.chat.saved', {});
            return;
        }
        recoveryBlocked = true;
        if (outcome?.status === 'failed') {
            await failure(type, body, sender, outcome.reason ?? 'The chat could not be saved.');
        }
        const restored = await native.loadSaved();
        if (!current(token)) { return; }
        needsRestore = false;
        recoveryBlocked = false;
        await onLocalSaved(restored);
    }

    function append(operation) {
        const result = tail.then(operation);
        tail = result.catch(() => {});
        return result;
    }

    function runNative(callback) {
        const token = epoch;
        return append(async () => {
            if (!current(token) || generating) { return; }
            if (needsRestore) {
                await native.loadSaved();
                if (!current(token)) { return; }
                needsRestore = false;
                recoveryBlocked = false;
            }
            runningNative = true;
            try { await callback(() => current(token)); } finally { runningNative = false; }
        });
    }

    return {
        /** @param {boolean} value Whether this connection may process and save changes. @returns {void} */
        setAuthority(value) {
            if (authority !== value) { epoch++; }
            authority = value;
            if (!value) { generating = false; }
        },
        /**
         * Restores disk state after an external native save fails or cannot be confirmed.
         * Failed restoration keeps subsequent queue work blocked until a read succeeds.
         * @returns {Promise<void>} Authoritative saved-state restoration.
         */
        async restoreSaved() {
            needsRestore = true;
            recoveryBlocked = true;
            const token = epoch;
            const messages = await native.loadSaved();
            if (!current(token)) { return; }
            needsRestore = false;
            recoveryBlocked = false;
            await onLocalSaved(messages);
        },
        /** @param {boolean} value Whether a whole shared group generation is active. @returns {void} */
        setGenerating(value) { generating = value; },
        /**
         * Accepts a prepared remote request or owner-local action in arrival order.
         * @param {string} type Send, edit or delete.
         * @param {object} body Prepared body including attempt iteration.
         * @param {object|null} [sender] Bus-authenticated identity; null means selected-owner local.
         * @returns {Promise<void>} Resolves after processing or rejection.
         */
        enqueue(type, body, sender = null) {
            if (!authority) { return Promise.resolve(); }
            if (generating) { return failure(type, body, sender, 'An AI turn is in progress.'); }
            const token = epoch;
            const snapshot = structuredClone(body);
            return append(() => process(type, snapshot, sender, token));
        },
        /**
         * Holds an externally initiated native generation behind already accepted changes.
         * @returns {Promise<void>} Completion of preceding actions; nested generation does not wait on itself.
         */
        async prepareGeneration() {
            if (!authority || generating) { return; }
            generating = true;
            try {
                if (!runningNative) { await tail; }
                if (needsRestore) {
                    const token = epoch;
                    const saved = await native.loadSaved();
                    if (!current(token)) { return; }
                    needsRestore = false;
                    recoveryBlocked = false;
                    await onLocalSaved(saved);
                }
            } catch (error) {
                generating = false;
                throw error;
            }
        },
        /** @returns {boolean} Whether a failed restoration prevents shared writes and external workflows. */
        get recoveryBlocked() { return recoveryBlocked; },
        /**
         * Starts native generation only after all preceding changes finish saving.
         * @param {Function} callback Native generation workflow.
         * @returns {Promise<void>} Workflow completion, or no operation after authority loss.
         */
        runGeneration(callback) {
            return runNative(async isCurrent => {
                generating = true;
                try { await callback(isCurrent); } finally { generating = false; }
            });
        },
        /** @param {Function} callback Native swipe or other coordinated workflow. @returns {Promise<void>} Native workflow completion after preceding saves. */
        runNative,
    };
}

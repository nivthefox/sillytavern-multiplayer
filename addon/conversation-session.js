const actionTypes = new Set(['send', 'edit', 'delete']);
const identityFields = ['accountId', 'groupId', 'chatId'];

function sameChat(left, right) {
    return left && right && identityFields.every(key => left[key] === right[key]);
}

function actionMessageId(type, body) {
    return type === 'send' ? body.message?.extra?.multiplayer?.messageId : body.messageId;
}

function confirmed(type, body, messages) {
    const target = messages.find(message => message.extra?.multiplayer?.messageId === actionMessageId(type, body));
    if (type === 'delete') {
        return !target;
    }
    return Boolean(target) && (type === 'send' || target.mes === body.text);
}

/**
 * Creates the shared-chat lifecycle, pending-action and generation-event controller.
 * Native preparation, rendering, persistence and the authoritative queue are supplied by integration.
 * @param {object} options Controller dependencies.
 * @param {object} options.bus BrowserEventBus instance.
 * @param {Function} options.loadChat Loads saved messages for (chat, {isOwner}) without replacing the draft.
 * @param {Function} options.render Renders a detached snapshot without replacing the composer draft.
 * @param {Function} options.onAction Delegates {type, body, sender} to the authoritative queue; local sender is null.
 * @param {Function} options.stopAuthority Synchronously revokes queue work and stops native generation.
 * @param {Function} [options.onError] Reports load and transport errors.
 * @returns {object} Session lifecycle, submission, retry and owner-notification methods.
 */
export function createConversationSession({ bus, loadChat, render, onAction, stopAuthority, onError = () => {} }) {
    let state = {
        chat: null, connected: false, isOwner: false, ownerPresent: false,
        generating: false, canChange: false, messages: [], pending: [], previews: [], interruption: null,
    };
    let epoch = 0;
    let loadSequence = 0;
    let nextPendingId = 0;
    let joining = false;
    let subscriptions = [];

    function publish() {
        state.canChange = Boolean(state.chat && state.connected && state.ownerPresent && !state.generating);
        render(structuredClone(state));
    }

    function applyMessages(messages) {
        state.messages = structuredClone(messages);
        state.pending = state.pending.filter(entry => !confirmed(entry.type, entry.body, messages));
        const ids = new Set(messages.map(message => message.extra?.multiplayer?.messageId));
        state.previews = state.previews.filter(preview => !ids.has(preview.messageId));
        publish();
    }

    async function reload() {
        const currentEpoch = epoch;
        const sequence = ++loadSequence;
        try {
            const messages = await loadChat(structuredClone(state.chat), { isOwner: state.isOwner });
            if (currentEpoch === epoch && sequence === loadSequence && state.chat) {
                applyMessages(messages);
            }
        } catch (error) {
            if (currentEpoch === epoch) {
                onError(error);
            }
        }
    }

    async function send(destination, name, body) {
        try {
            await bus.send(destination, name, structuredClone(body));
        } catch (error) {
            onError(error);
        }
    }

    async function requestGenerationStatus() {
        if (state.connected && state.ownerPresent && !state.isOwner) {
            await send('owner', 'multiplayer.generation.status_request', {});
        }
    }

    function interrupt() {
        if (state.generating || state.previews.length > 0) {
            state.interruption = 'AI generation interrupted.';
        }
        state.generating = false;
        state.previews = [];
    }

    function revoke() {
        if (state.isOwner) {
            stopAuthority();
        }
        state.isOwner = false;
    }

    async function status(body) {
        if (typeof body?.isOwner !== 'boolean' || typeof body?.ownerPresent !== 'boolean') {
            return;
        }
        const reconnecting = !state.connected;
        const gainingAuthority = body.isOwner && !state.isOwner;
        const ownerArriving = body.ownerPresent && !state.ownerPresent;
        if (state.isOwner && !body.isOwner) {
            revoke();
            interrupt();
            loadSequence++;
        }
        state.connected = true;
        state.isOwner = body.isOwner;
        state.ownerPresent = body.ownerPresent;
        publish();
        if (joining) {
            return;
        }
        if (reconnecting || gainingAuthority) {
            await reload();
        }
        if (reconnecting || ownerArriving) {
            await requestGenerationStatus();
        }
    }

    function failure(type, body) {
        if (!body || typeof body.messageId !== 'string' || !Number.isInteger(body.iteration)
            || body.iteration < 0 || typeof body.reason !== 'string') {
            return;
        }
        const entry = state.pending.find(candidate => candidate.type === type
            && actionMessageId(type, candidate.body) === body?.messageId
            && candidate.body.iteration === body.iteration
            && (type !== 'edit' || candidate.body.text === body.text));
        if (!entry) {
            return;
        }
        entry.status = 'failed';
        entry.reason = body.reason;
        publish();
    }

    function listen(name, handler) {
        subscriptions.push(bus.on(name, (chat, sender, body) => {
            if (!state.chat || (chat && !sameChat(state.chat, chat))) {
                return;
            }
            return handler(body, sender);
        }));
    }

    function subscribe() {
        if (subscriptions.length > 0) {
            return;
        }
        listen('bus.status', status);
        listen('bus.disconnected', () => {
            loadSequence++;
            revoke();
            interrupt();
            state.connected = false;
            state.ownerPresent = false;
            publish();
        });
        listen('multiplayer.chat.saved', () => {
            if (!state.isOwner && state.connected) {
                return reload();
            }
        });
        listen('multiplayer.owner.changed', async (_body, sender) => {
            if (sender !== null) {
                return;
            }
            interrupt();
            publish();
            await requestGenerationStatus();
        });
        listen('multiplayer.generation.status', body => {
            if (state.isOwner || typeof body?.generating !== 'boolean') {
                return;
            }
            state.generating = body.generating;
            if (body.generating) {
                state.interruption = null;
            }
            publish();
        });
        listen('multiplayer.generation.preview', body => {
            if (state.isOwner || !body || !['messageId', 'name', 'force_avatar', 'text'].every(key => typeof body[key] === 'string')) {
                return;
            }
            const preview = { messageId: body.messageId, name: body.name, force_avatar: body.force_avatar, text: body.text };
            const index = state.previews.findIndex(candidate => candidate.messageId === body.messageId);
            if (index < 0) {
                state.previews.push(preview);
            } else {
                state.previews[index] = preview;
            }
            publish();
        });
        listen('multiplayer.generation.status_request', () => {
            if (state.isOwner && state.connected) {
                return send('all', 'multiplayer.generation.status', { generating: state.generating });
            }
        });
        for (const type of actionTypes) {
            listen(`multiplayer.message.${type}_failure`, body => failure(type, body));
            listen(`multiplayer.message.${type}`, (body, sender) => {
                if (state.isOwner && state.connected) {
                    return onAction({ type, body, sender });
                }
            });
        }
    }

    async function dispatch(entry) {
        if (state.isOwner) {
            await onAction({ type: entry.type, body: structuredClone(entry.body), sender: null });
            return;
        }
        try {
            await bus.send('owner', `multiplayer.message.${entry.type}`, structuredClone(entry.body));
        } catch (error) {
            if (error.code && error.code !== 'unknown_outcome' && state.pending.includes(entry)) {
                failure(entry.type, { ...entry.body, messageId: actionMessageId(entry.type, entry.body), reason: error.message });
            }
            onError(error);
        }
    }

    function requireChanges() {
        if (!state.canChange) {
            throw new Error('Shared-chat changes are unavailable.');
        }
    }

    function requireOwner() {
        if (!state.isOwner || !state.connected) {
            throw new Error('Only the selected owner may publish shared-chat updates.');
        }
    }

    return {
        /** @returns {object} Detached state for rendering and control availability. */
        getState() {
            return structuredClone(state);
        },
        /** @param {object} chat Source-qualified chat identity. @returns {Promise<void>} Join and saved-chat load completion. */
        async open(chat) {
            if (state.isOwner) {
                revoke();
            }
            const currentEpoch = ++epoch;
            loadSequence++;
            state = { ...state, chat: structuredClone(chat), connected: false, isOwner: false, ownerPresent: false,
                generating: false, messages: [], pending: [], previews: [], interruption: null };
            joining = true;
            subscribe();
            publish();
            try {
                await bus.connect();
                if (currentEpoch !== epoch) {
                    return;
                }
                const result = await bus.join(chat);
                if (currentEpoch !== epoch) {
                    return;
                }
                await status(result);
                joining = false;
                await reload();
                if (currentEpoch === epoch) {
                    await requestGenerationStatus();
                }
            } catch (error) {
                if (currentEpoch === epoch) {
                    joining = false;
                    onError(error);
                }
                throw error;
            }
        },
        /** @returns {Promise<void>} Leaves the bus chat after revoking authority and removing subscriptions. */
        async close() {
            epoch++;
            loadSequence++;
            revoke();
            interrupt();
            state.chat = null;
            state.connected = false;
            state.ownerPresent = false;
            joining = false;
            for (const unsubscribe of subscriptions) {
                unsubscribe();
            }
            subscriptions = [];
            publish();
            try {
                await bus.leave();
            } catch (error) {
                if (error.code !== 'connection_unavailable' && error.code !== 'unknown_outcome') {
                    throw error;
                }
                onError(error);
            }
        },
        /** @param {string} type send, edit or delete. @param {object} body Prepared action. @returns {Promise<string>} Pending display identifier. */
        async submit(type, body) {
            requireChanges();
            if (!actionTypes.has(type)) {
                throw new Error('Unknown shared-chat action.');
            }
            const entry = { id: String(++nextPendingId), type, body: { ...structuredClone(body), iteration: 0 }, status: 'pending' };
            state.pending.push(entry);
            publish();
            await dispatch(entry);
            return entry.id;
        },
        /** @param {string} id Failed pending entry identifier. @returns {Promise<void>} Retry submission completion, not save confirmation. */
        async retry(id) {
            requireChanges();
            const entry = state.pending.find(candidate => candidate.id === id && candidate.status === 'failed');
            if (!entry) {
                return;
            }
            entry.body.iteration++;
            entry.status = 'pending';
            delete entry.reason;
            publish();
            await dispatch(entry);
        },
        /** @param {string} id Failed overlay to discard, without altering saved messages or the composer. */
        discard(id) {
            state.pending = state.pending.filter(entry => entry.id !== id || entry.status !== 'failed');
            publish();
        },
        /** @param {string} type Local action type. @param {object} body Attempted body including iteration. @param {string} reason Confirmed failure explanation. */
        localFailure(type, body, reason) {
            failure(type, { ...body, messageId: actionMessageId(type, body), reason });
        },
        /** @param {object[]} messages Confirmed persisted messages supplied by the owner queue, not an unsaved live transcript. */
        localSaved(messages) {
            if (state.chat && state.isOwner && state.connected) {
                applyMessages(messages);
            }
        },
        /** @param {boolean} generating Whole shared group-turn status; never private draft assistance. @returns {Promise<void>} Publication completion. */
        async generationStatus(generating) {
            requireOwner();
            state.generating = generating;
            if (generating) {
                state.interruption = null;
            }
            publish();
            await send('all', 'multiplayer.generation.status', { generating });
        },
        /** @param {object} body Stable identity, speaker portrait/name and accumulated response text. @returns {Promise<void>} Preview publication completion. */
        async generationPreview({ messageId, name, force_avatar, text }) {
            requireOwner();
            await send('all', 'multiplayer.generation.preview', { messageId, name, force_avatar, text });
        },
        /** @returns {Promise<void>} Publishes a save already proven successful by the native persistence observer. */
        async saved() {
            requireOwner();
            await send('all', 'multiplayer.chat.saved', {});
        },
    };
}

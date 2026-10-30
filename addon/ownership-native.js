function sourceKey(owner, id) {
    return JSON.stringify([owner, String(id)]);
}

function characterId(owner, filename) {
    return `multiplayer-character:${sourceKey(owner, filename)}`;
}

async function requestBody(input, options) {
    if (typeof options?.body === 'string') {
        return JSON.parse(options.body);
    }
    if (typeof Request !== 'undefined' && input instanceof Request) {
        return input.clone().json();
    }
    return {};
}

function requestPath(input, baseURL) {
    const value = typeof input === 'string' ? input : input.url ?? String(input);
    return new URL(value, baseURL).pathname;
}

/**
 * Adapts native creation, listing and guest reading without restricting other native actions.
 * @param {object} options Ownership service, live native bindings, document and browser fetch owner.
 * @returns {object} Mount, disposal, listing, source-qualified opening and decoration operations.
 */
export function createOwnershipNative({ service, native, document, window }) {
    const originalFetch = window.fetch;
    const entries = new Map();
    const projectedIds = new Map();
    const loadedCards = new Map();
    const selectedAccounts = new Set();
    const subscriptions = [];
    const summaryIds = new Map();
    const reportedResourceErrors = new WeakSet();
    let mounted = false;
    let observer;
    let accountPanel;
    let preferencePanel;
    let active;
    let generation = 0;
    let openingTranscript;
    let creation;
    let panelGroupId;
    let accountSnapshot = 0;

    function report(error) {
        if (!reportedResourceErrors.has(error)) {
            native.reportError?.(error);
        }
    }

    async function serviceOperation(operation) {
        try {
            return await operation();
        } catch (error) {
            reportedResourceErrors.add(error);
            throw error;
        }
    }

    function subscribe(name, listener) {
        if (!name || !native.eventSource) {
            return;
        }
        native.eventSource.on(name, listener);
        subscriptions.push([name, listener]);
    }

    function getProjectionId(owner, id, nativeIds = new Set()) {
        if (owner === service.account.id) {
            return id;
        }
        const key = sourceKey(owner, id);
        let projected = projectedIds.get(key) ?? `multiplayer-group:${key}`;
        while (nativeIds.has(projected)) {
            projected += ':';
        }
        projectedIds.set(key, projected);
        return projected;
    }

    function projectGroup(entry, nativeIds) {
        const { owner, group } = entry;
        const id = getProjectionId(owner.id, group.id, nativeIds);
        entries.set(String(id), entry);
        if (owner.id === service.account.id) {
            return group;
        }
        return {
            ...structuredClone(group),
            id,
            avatar_url: '',
            members: group.members.map(filename => characterId(owner.id, filename)),
            disabled_members: (group.disabled_members ?? []).map(filename => characterId(owner.id, filename)),
        };
    }

    function installCards(ownerId, cards) {
        for (const card of cards) {
            const filename = card.multiplayer?.filename ?? card.avatar;
            loadedCards.set(sourceKey(ownerId, filename), card);
            const avatar = characterId(ownerId, filename);
            const projection = { ...card, avatar, shallow: false, imageUrl: service.characterImage(ownerId, filename) };
            const index = native.characters.findIndex(character => character.avatar === avatar);
            if (index === -1) {
                native.characters.push(projection);
            } else {
                native.characters[index] = projection;
            }
        }
    }

    async function mergeListing(groups) {
        const local = groups.filter(group => !entries.has(String(group.id)) || entries.get(String(group.id)).owner.id === service.account.id);
        const merged = await serviceOperation(() => service.mergeGroups(local));
        const nativeIds = new Set(local.map(group => String(group.id)));
        const projections = [];
        for (const entry of merged) {
            projections.push(projectGroup(entry, nativeIds));
            if (entry.owner.id !== service.account.id) {
                const cached = entry.group.members.map(filename => loadedCards.get(sourceKey(entry.owner.id, filename))).filter(Boolean);
                installCards(entry.owner.id, cached);
            }
        }
        return projections;
    }

    async function readSummaries(entry) {
        const summaries = await serviceOperation(() => service.listChats(entry.owner.id, entry.group.id));
        const ids = new Map();
        for (const summary of summaries) {
            ids.set(summary.file_name, summary.file_id);
        }
        summaryIds.set(sourceKey(entry.owner.id, entry.group.id), ids);
        return summaries.map(summary => ({ ...summary, message_count: summary.chat_items, preview_message: summary.mes }));
    }

    function activeEntry() {
        if (native.selectedGroup !== undefined) {
            return entries.get(String(native.selectedGroup));
        }
        return active ? entries.get(String(active.projectionId)) : undefined;
    }

    async function createNativeGroup(input, options) {
        if (creation) {
            return Response.json(await creation);
        }
        creation = (async () => {
            const model = await requestBody(input, options);
            if (!Array.isArray(model.members) || model.members.length === 0) {
                throw new Error('Select at least one Character card.');
            }
            return serviceOperation(() => service.createGroup(model, [...selectedAccounts]));
        })();
        try {
            return Response.json(await creation);
        } catch (error) {
            report(error);
            throw error;
        } finally {
            creation = undefined;
        }
    }

    function originalGroupModel(model, entry) {
        const filenames = new Map(entry.group.members.map(filename => [characterId(entry.owner.id, filename), filename]));
        return {
            ...model,
            id: entry.group.id,
            members: model.members?.map(member => filenames.get(member) ?? member),
            disabled_members: model.disabled_members?.map(member => filenames.get(member) ?? member),
        };
    }

    async function interceptedFetch(input, options) {
        const path = requestPath(input, document.baseURI ?? window.location.href);
        if (path === '/api/groups/create') {
            return createNativeGroup(input, options);
        }
        if (path === '/api/groups/all') {
            const response = await originalFetch.call(window, input, options);
            if (!response.ok) {
                return response;
            }
            try {
                return Response.json(await mergeListing(await response.clone().json()));
            } catch (error) {
                report(error);
                return response;
            }
        }
        if (path === '/api/groups/edit') {
            const model = await requestBody(input, options);
            const entry = entries.get(String(model.id));
            if (entry && entry.owner.id !== service.account.id) {
                return originalFetch.call(window, input, { ...options, body: JSON.stringify(originalGroupModel(model, entry)) });
            }
        }
        if (path === '/api/chats/search') {
            const model = await requestBody(input, options);
            const entry = entries.get(String(model.group_id));
            if (entry && entry.owner.id !== service.account.id) {
                const summaries = await readSummaries(entry);
                const query = String(model.query ?? '').toLowerCase();
                return Response.json(summaries.filter(summary => !query || `${summary.file_name} ${summary.preview_message}`.toLowerCase().includes(query)));
            }
        }
        if (path === '/api/chats/group/get') {
            const model = await requestBody(input, options);
            const entry = activeEntry();
            const preloaded = openingTranscript && openingTranscript.chatId === model.id && openingTranscript.projectionId === native.selectedGroup;
            if (entry && entry.owner.id !== service.account.id && (preloaded || entry.group.chats.includes(model.id))) {
                const transcript = preloaded ? openingTranscript.transcript : await serviceOperation(() => service.loadChat(entry.owner.id, entry.group.id, model.id));
                return Response.json([{ chat_metadata: transcript.metadata }, ...presentMessages(entry.owner.id, transcript.messages)]);
            }
        }
        return originalFetch.call(window, input, options);
    }

    function element(tag, text, className) {
        const node = document.createElement(tag);
        if (text !== undefined) {
            node.textContent = text;
        }
        if (className) {
            node.className = className;
        }
        return node;
    }

    function accountCard(account) {
        const label = element('label', account.name, 'checkbox_label multiplayer-account');
        const image = element('img');
        image.src = account.avatar ?? native.default_avatar;
        image.style.width = '32px';
        image.style.height = '32px';
        image.style.borderRadius = '50%';
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        checkbox.value = account.id;
        checkbox.checked = selectedAccounts.has(account.id);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                selectedAccounts.add(account.id);
            } else {
                selectedAccounts.delete(account.id);
            }
        });
        label.append(image, checkbox);
        return label;
    }

    async function mountAccounts() {
        const form = document.getElementById('rm_group_chats_block');
        if (!form || accountPanel) {
            return;
        }
        accountPanel = element('section');
        accountPanel.id = 'multiplayer_group_accounts';
        form.append(accountPanel);
        await refreshAccountChoices();
    }

    async function refreshAccountChoices() {
        const snapshot = ++accountSnapshot;
        selectedAccounts.clear();
        accountPanel.replaceChildren(element('span', `Owned by ${service.account.name}`), element('h3', 'Add Other Accounts'));
        const accountChoices = await serviceOperation(() => service.listAccounts());
        if (snapshot !== accountSnapshot || !accountPanel) {
            return;
        }
        for (const account of accountChoices) {
            if (account.id !== service.account.id) {
                accountPanel.append(accountCard(account));
            }
        }
    }

    function mountPreference() {
        const container = document.getElementById('extensions_settings');
        if (!container || preferencePanel) {
            return;
        }
        preferencePanel = element('label', 'Allow others to add me to shared groups', 'checkbox_label');
        preferencePanel.id = 'multiplayer_allow_group_invites';
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        checkbox.checked = service.isDiscoverable();
        checkbox.addEventListener('change', () => {
            Promise.resolve(service.setDiscoverable(checkbox.checked)).catch(report);
        });
        preferencePanel.append(checkbox);
        container.append(preferencePanel);
    }

    function groupSelected(event) {
        panelGroupId = event.detail.id;
        if (!accountPanel) {
            return;
        }
        accountPanel.hidden = Boolean(event.detail.group);
        if (!event.detail.group) {
            void refreshAccountChoices().catch(report);
        }
    }

    function decorateGroupCard(card, entry) {
        if (entry.owner.id === service.account.id) {
            return;
        }
        const label = `Owned by ${entry.owner.name}`;
        let ownerLabel = card.querySelector('.multiplayer-owner-label');
        if (!ownerLabel) {
            ownerLabel = element('span', label, 'multiplayer-owner-label');
            card.append(ownerLabel);
        }
        if (ownerLabel.textContent !== label) {
            ownerLabel.textContent = label;
        }
        let avatar = card.querySelector('.avatar');
        if (!avatar) {
            avatar = element('div', undefined, 'avatar');
            const previous = card.querySelector('.missing-avatar');
            previous?.remove();
            card.append(avatar);
        }
        avatar.style.position = 'relative';
        if (!avatar.querySelector('.multiplayer-owner-badge')) {
            const badge = element('span', '♟', 'multiplayer-owner-badge');
            badge.title = label;
            Object.assign(badge.style, { position: 'absolute', right: '0', bottom: '0', borderRadius: '50%', background: 'var(--SmartThemeBlurTintColor, #222)', padding: '0 3px', zIndex: '1' });
            avatar.append(badge);
        }
        decorateCollage(avatar, entry);
    }

    function decorateCollage(avatar, entry) {
        const filenames = entry.group.members.slice(0, 4);
        const count = Math.max(1, filenames.length);
        let images = [...avatar.querySelectorAll('img')];
        if (images.length !== count) {
            for (const image of images) {
                image.remove();
            }
            images = Array.from({ length: count }, () => element('img'));
            avatar.append(...images);
        }
        const classes = avatar.className.split(' ').filter(name => name && !/^collage_\d+$/.test(name) && name !== 'avatar_collage');
        avatar.className = [...classes, 'avatar_collage', `collage_${count}`].join(' ');
        for (const [index, image] of images.entries()) {
            const filename = filenames[index];
            const src = filename ? service.characterImage(entry.owner.id, filename) : native.default_avatar;
            image.className = `img_${index + 1}`;
            if (image.dataset.multiplayerSource !== src) {
                delete image.dataset.multiplayerFailed;
                image.dataset.multiplayerSource = src;
            }
            if (image.getAttribute('src') !== src && !image.dataset.multiplayerFailed) {
                image.src = src;
            }
        }
    }

    function decoratePage() {
        for (const card of document.querySelectorAll('.group_select')) {
            const entry = entries.get(String(card.getAttribute('data-grid')));
            if (entry) {
                decorateGroupCard(card, entry);
            }
        }
        const preview = document.getElementById('group_avatar_preview');
        const panelEntry = entries.get(String(panelGroupId === undefined ? native.openGroupId : panelGroupId));
        if (preview && panelEntry && panelEntry.owner.id !== service.account.id) {
            decorateCollage(preview.querySelector('.avatar') ?? preview, panelEntry);
        }
        for (const image of document.querySelectorAll('img')) {
            const src = image.getAttribute('src');
            if (!src || image.dataset.multiplayerFailed) {
                continue;
            }
            const url = new URL(src, document.baseURI ?? window.location.href);
            const file = url.searchParams.get('file');
            const card = native.characters.find(character => character.avatar === file && character.multiplayer?.accountId);
            if (url.pathname === '/thumbnail' && card) {
                image.src = service.characterImage(card.multiplayer.accountId, card.multiplayer.filename);
            }
        }
    }

    function portraitError(event) {
        const image = event.target;
        if (image.tagName !== 'IMG' || !String(image.src).includes('/api/plugins/multiplayer/accounts/') || !String(image.src).includes('/characters/')) {
            return;
        }
        event.stopImmediatePropagation();
        image.dataset.multiplayerFailed = 'true';
        image.src = native.default_avatar;
    }

    function presentMessages(ownerId, messages) {
        return messages.map(message => {
            if (!message.original_avatar || message.is_user) {
                return structuredClone(message);
            }
            return { ...structuredClone(message), force_avatar: service.characterImage(ownerId, message.original_avatar) };
        });
    }

    async function renderTranscript(ownerId, transcript, request, group, chatId) {
        await native.clearChat({ clearData: false });
        if (request !== generation) {
            return false;
        }
        if (group) {
            group.chat_id = chatId;
        }
        native.chat.splice(0, native.chat.length, ...presentMessages(ownerId, transcript.messages));
        native.updateChatMetadata(structuredClone(transcript.metadata), true);
        await native.printMessages();
        if (request !== generation) {
            return false;
        }
        decoratePage();
        return true;
    }

    function installGroup(entry) {
        const projection = projectGroup(entry, new Set(native.groups.filter(group => !entries.has(String(group.id))).map(group => String(group.id))));
        const index = native.groups.findIndex(group => group.id === projection.id);
        if (index === -1) {
            native.groups.push(projection);
        } else {
            native.groups[index] = projection;
        }
        return projection;
    }

    async function openGroup(ownerId, groupId) {
        const request = ++generation;
        const entry = await serviceOperation(() => service.loadGroup(ownerId, groupId));
        const [cards, transcript] = await Promise.all([
            serviceOperation(() => service.loadCharacters(ownerId, entry.group.members)),
            entry.group.chat_id ? serviceOperation(() => service.loadChat(ownerId, groupId, entry.group.chat_id)) : { metadata: {}, messages: [] },
        ]);
        if (request !== generation) {
            return;
        }
        installCards(ownerId, cards);
        const projection = installGroup(entry);
        active = { ownerId, groupId, projectionId: projection.id };
        if (native.openGroupById && native.selectedGroup !== projection.id) {
            openingTranscript = { projectionId: projection.id, chatId: entry.group.chat_id, transcript, request };
            try {
                const opened = await native.openGroupById(projection.id);
                if (opened && request === generation) {
                    decoratePage();
                }
                return;
            } finally {
                openingTranscript = undefined;
            }
        }
        if (!await renderTranscript(ownerId, transcript, request)) {
            return;
        }
        native.select_group_chats?.(projection.id, true);
        await native.eventSource?.emit(native.event_types.CHAT_CHANGED, entry.group.chat_id);
    }

    async function openChat(ownerId, groupId, chatId) {
        const request = ++generation;
        const transcript = await serviceOperation(() => service.loadChat(ownerId, groupId, chatId));
        if (request !== generation) {
            return;
        }
        const projectionId = getProjectionId(ownerId, groupId);
        const group = native.groups.find(group => group.id === projectionId);
        active = { ownerId, groupId, projectionId };
        if (await renderTranscript(ownerId, transcript, request, group, chatId)) {
            await native.eventSource?.emit(native.event_types.CHAT_CHANGED, chatId);
        }
    }

    async function showChats(ownerId, groupId) {
        const entry = entries.get(String(getProjectionId(ownerId, groupId))) ?? { owner: { id: ownerId }, group: { id: groupId } };
        await readSummaries(entry);
        await native.displayPastChats();
    }

    function onClick(event) {
        const target = event.target;
        const card = target.closest?.('.group_select');
        const entry = card ? entries.get(String(card.getAttribute('data-grid'))) : undefined;
        if (entry && entry.owner.id !== service.account.id) {
            event.preventDefault();
            event.stopImmediatePropagation();
            void openGroup(entry.owner.id, entry.group.id).catch(report);
            return;
        }
        if (card || target.closest?.('.character_select')) {
            generation++;
        }
        const chatCard = target.closest?.('.select_chat_block');
        const current = activeEntry();
        if (!chatCard || !current || current.owner.id === service.account.id) {
            return;
        }
        if (target.closest('button, .menu_button, .PastChat_cross, .renameChatButton, .exportChatButton, .exportRawChatButton')) {
            return;
        }
        const filename = chatCard.getAttribute('file_name');
        const chatId = summaryIds.get(sourceKey(current.owner.id, current.group.id))?.get(filename);
        if (!chatId) {
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        void openChat(current.owner.id, current.group.id, chatId).then(() => {
            const popup = document.getElementById('shadow_select_chat_popup');
            if (popup) {
                popup.style.display = 'none';
            }
        }).catch(report);
    }

    function prepareNativePublication() {
        if (!openingTranscript || openingTranscript.projectionId !== native.selectedGroup || openingTranscript.request !== generation) {
            return;
        }
        native.updateChatMetadata(structuredClone(openingTranscript.transcript.metadata), true);
    }

    function subscribeNativePublication() {
        const events = native.eventSource;
        const name = native.event_types?.CHAT_CHANGED;
        if (!events || !name) {
            return;
        }
        if (events.makeFirst) {
            events.makeFirst(name, prepareNativePublication);
        } else if (events.prependListener) {
            events.prependListener(name, prepareNativePublication);
        } else {
            events.on(name, prepareNativePublication);
        }
        subscriptions.push([name, prepareNativePublication]);
    }

    async function mount() {
        if (mounted) {
            return;
        }
        mounted = true;
        window.fetch = interceptedFetch;
        document.addEventListener('click', onClick, true);
        document.addEventListener('error', portraitError, true);
        subscribeNativePublication();
        subscribe('groupSelected', groupSelected);
        subscribe(native.event_types?.CHARACTER_PAGE_LOADED, decoratePage);
        subscribe(native.event_types?.CHAT_CHANGED, () => {
            const entry = activeEntry();
            if (!entry || entry.owner.id === service.account.id) {
                generation++;
                active = undefined;
            }
        });
        if (window.MutationObserver) {
            observer = new window.MutationObserver(decoratePage);
            observer.observe(document.body, { childList: true, subtree: true });
        }
        mountPreference();
        try {
            await mountAccounts();
        } catch (error) {
            report(error);
        }
    }

    async function refreshGroups() {
        if (native.getCharacters) {
            await native.getCharacters();
            return;
        }
        const groups = await mergeListing(native.groups);
        native.groups.splice(0, native.groups.length, ...groups);
        decoratePage();
    }

    function dispose() {
        if (window.fetch === interceptedFetch) {
            window.fetch = originalFetch;
        }
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('error', portraitError, true);
        for (const [name, listener] of subscriptions) {
            native.eventSource.removeListener(name, listener);
        }
        subscriptions.length = 0;
        observer?.disconnect();
        accountPanel?.remove();
        preferencePanel?.remove();
        accountPanel = undefined;
        preferencePanel = undefined;
        mounted = false;
        generation++;
        accountSnapshot++;
    }

    return {
        /** @returns {Promise<void>} Installs native transport, account controls and display listeners once. */
        mount,
        /** @returns {void} Removes this adapter's listeners and controls and restores its fetch predecessor. */
        dispose,
        /** @returns {Promise<void>} Reloads the normal native character/group listing with shared discovery. */
        refreshGroups,
        /**
         * Opens an owner-sourced group using native selection and rendering without initialization.
         * @param {string} ownerId Source account handle.
         * @param {string} groupId Original native group ID, never its frontend projection.
         * @returns {Promise<void>} Resolves after the selected transcript is displayed; failed reads reject.
         */
        openGroup,
        /**
         * Applies a stored shared transcript to the currently selected group's native display.
         * @param {string} ownerId Source account handle.
         * @param {string} groupId Original native group ID.
         * @param {string} chatId Exact stored chat ID without an appended extension.
         * @returns {Promise<void>} Resolves after display; superseded reads do not replace newer selections.
         */
        openChat,
        /**
         * Loads owner chat summaries into the native chat chooser.
         * @param {string} ownerId Source account handle.
         * @param {string} groupId Original native group ID.
         * @returns {Promise<void>} Resolves when the native chooser has rendered.
         */
        showChats,
        /**
         * Decorates a native guest group card with its source portraits and ownership indicator.
         * @param {HTMLElement} card Native group card element.
         * @param {{owner: object, group: object}} entry Plugin owner/group envelope.
         * @returns {void}
         */
        decorateGroupCard,
    };
}

const nativeGenerationSelectors = '#option_regenerate, #option_continue, #mes_continue, .swipe_right, .swipe_left, [data-action="speak"]';
const addonGenerationSelectors = '.instead-feedback-icon, .instead-send-btn, #gg_swipe_button, #gg_response_button, #gg_continue_button, #guided_swipe_button, #guided_response_button, #gg_undo_button, #gg_revert_button, #gg_tools_menu a:has([data-i18n="Undo Last Addition"]), #gg_tools_menu a:has([data-i18n="Revert to Original"])';
const generationSelectors = `${nativeGenerationSelectors}, ${addonGenerationSelectors}`;
const bulkSelectors = '#option_delete_mes, #dialogue_del_mes, .del_checkbox';
const unsupportedMutationSelectors = '.mes_edit_copy, .mes_edit_up, .mes_edit_down, #rm_group_automode';
const submissionSelectors = '#send_but, #gg_simple_send_button, #gg_tools_menu a:has([data-i18n="Simple Send"])';

function stableId(message) {
    return message?.extra?.multiplayer?.messageId;
}

/**
 * Mounts shared-chat capture handlers and presents session state without mutating it.
 * @param {object} options Browser objects, state getter and submission/action callbacks.
 * @returns {object} Mount, refresh and disposal operations.
 */
export function createConversationUI({ document, window, getState, renderMessage, onSubmit, onGenerate, onEdit, onDelete, onRetry, onDiscard, shouldSendOnEnter = () => true, isPopupOpen = () => false, onError = error => console.error(error) }) {
    let mounted = false;
    let observer;
    const originals = new Map();
    const hiddenStyles = new Map();

    function state() {
        return getState();
    }

    function available(snapshot) {
        return snapshot.connected && snapshot.ownerPresent && !snapshot.generating && !snapshot.blocked;
    }

    function setProperty(element, property, value) {
        if (property === 'hidden' && value) {
            if (!hiddenStyles.has(element)) {
                hiddenStyles.set(element, [element.style.getPropertyValue('display'), element.style.getPropertyPriority('display')]);
            }
            element.style.setProperty('display', 'none', 'important');
        }
        if (!originals.has(element)) {
            originals.set(element, {});
        }
        const original = originals.get(element);
        if (!Object.hasOwn(original, property)) {
            original[property] = element[property];
        }
        if (element[property] !== value) {
            element[property] = value;
        }
    }

    function restore() {
        for (const [element, values] of originals) {
            for (const [property, value] of Object.entries(values)) {
                element[property] = value;
            }
        }
        originals.clear();
        for (const [element, [display, priority]] of hiddenStyles) {
            if (display) { element.style.setProperty('display', display, priority); } else { element.style.removeProperty('display'); }
        }
        hiddenStyles.clear();
    }

    function stop(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    function invoke(callback, ...args) {
        try {
            Promise.resolve(callback?.(...args)).catch(onError);
        } catch (error) {
            onError(error);
        }
    }

    function submit(snapshot) {
        if (!available(snapshot)) {
            return;
        }
        const text = document.querySelector('#send_textarea')?.value ?? '';
        if (text.length) {
            invoke(onSubmit, text);
        } else if (snapshot.isOwner) {
            invoke(onGenerate);
        }
    }

    function permissions(snapshot, message) {
        const ownPlayer = message?.is_user && message.extra?.multiplayer?.accountId === snapshot.accountId;
        return {
            edit: Boolean(ownPlayer || (snapshot.isOwner && message && !message.is_user)),
            delete: Boolean(ownPlayer || snapshot.isOwner),
            controls: Boolean(ownPlayer || snapshot.isOwner),
        };
    }

    function messageAt(element, snapshot) {
        const index = Number(element.closest('.mes')?.getAttribute('mesid'));
        return snapshot.messages[index];
    }

    function generationOptions(element) {
        if (element.matches('[data-action="speak"]')) {
            return { type: 'normal', params: { force_chid: Number(element.closest('[data-chid]')?.getAttribute('data-chid')) } };
        }
        if (element.matches('#option_continue, #mes_continue')) {
            return { type: 'continue' };
        }
        if (element.matches('#option_regenerate')) {
            return { type: 'regenerate' };
        }
        return { type: 'swipe', direction: element.matches('.swipe_left') ? 'left' : 'right', messageId: stableId(messageAt(element, state())) };
    }

    function captureClick(event) {
        const snapshot = state();
        if (!snapshot.shared || !(event.target instanceof window.Element)) {
            return;
        }
        const target = event.target;
        if (target.closest('[data-multiplayer-overlay]')) {
            if (!target.closest('[data-multiplayer-action]')) { stop(event); }
            return;
        }
        if (target.closest(unsupportedMutationSelectors)) { stop(event); return; }
        if (target.closest(submissionSelectors)) {
            stop(event);
            submit(snapshot);
            return;
        }
        if (target.closest(addonGenerationSelectors)) {
            if (!snapshot.isOwner || !available(snapshot)) {
                stop(event);
            }
            return;
        }
        if (target.closest(nativeGenerationSelectors)) {
            stop(event);
            if (snapshot.isOwner && available(snapshot)) {
                invoke(onGenerate, generationOptions(target.closest(nativeGenerationSelectors)));
            }
            return;
        }
        if (target.closest('#dialogue_del_mes_ok')) {
            stop(event);
            if (snapshot.isOwner && available(snapshot)) {
                const selected = document.querySelector('.mes .del_checkbox:checked');
                const message = selected && messageAt(selected, snapshot);
                if (message) {
                    invoke(onDelete, stableId(message), { bulk: true });
                    document.querySelector('#dialogue_del_mes_cancel')?.click();
                }
            }
            return;
        }
        if (target.closest(bulkSelectors) && (!snapshot.isOwner || !available(snapshot))) {
            stop(event);
            return;
        }
        if (!target.closest('.mes')) {
            return;
        }
        const message = messageAt(target, snapshot);
        const allowed = permissions(snapshot, message);
        const control = target.closest('.mes_buttons, .mes_edit_buttons, .mes_button, .mes_edit, .mes_edit_done, .mes_edit_delete');
        if (!control) {
            return;
        }
        const pending = snapshot.pending?.some(entry => (entry.body.messageId ?? stableId(entry.body.message)) === stableId(message));
        if (pending || !allowed.controls || !available(snapshot)) {
            stop(event);
            return;
        }
        if (target.closest('.mes_edit, .mes_edit_done') && !allowed.edit) {
            stop(event);
            return;
        }
        if (target.closest('.mes_edit_done')) {
            stop(event);
            const text = target.closest('.mes').querySelector('.edit_textarea')?.value ?? message.mes;
            invoke(onEdit, stableId(message), text);
        } else if (target.closest('.mes_edit_delete')) {
            stop(event);
            if (allowed.delete) {
                invoke(onDelete, stableId(message));
            }
        }
    }

    function captureInput(event) {
        if (state().shared && event.target instanceof window.Element && event.target.matches('.edit_textarea')) {
            event.stopImmediatePropagation();
        }
    }

    function captureKey(event) {
        const snapshot = state();
        if (!snapshot.shared || isPopupOpen() || event.key !== 'Enter' || event.isComposing) {
            return;
        }
        if (event.altKey) {
            stop(event);
            if (snapshot.isOwner && available(snapshot)) {
                invoke(onGenerate, { type: 'continue' });
            }
            return;
        }
        if (event.ctrlKey) {
            const editor = [...document.querySelectorAll('.edit_textarea')].find(element => !element.hidden && element.style.display !== 'none');
            if (editor) {
                stop(event);
                const message = messageAt(editor, snapshot);
                if (available(snapshot) && permissions(snapshot, message).edit) {
                    invoke(onEdit, stableId(message), editor.value);
                }
                return;
            }
            stop(event);
            submit(snapshot);
            return;
        }
        if (event.shiftKey || !shouldSendOnEnter() || document.activeElement?.id !== 'send_textarea') {
            return;
        }
        stop(event);
        submit(snapshot);
    }

    function textElement(className, text) {
        const element = document.createElement('div');
        element.className = className;
        element.textContent = text ?? '';
        return element;
    }

    function overlayMessage(message) {
        const prepared = { is_user: false, is_system: false, send_date: '', extra: {}, ...structuredClone(message), name: message?.name ?? '', mes: message?.mes ?? '' };
        const element = renderMessage?.(prepared) ?? document.createElement('div');
        element.dataset.multiplayerOverlay = '';
        element.classList.add('mes', 'multiplayer-provisional-message');
        if (!element.querySelector('.mes_text')) {
            const avatarWrapper = textElement('mesAvatarWrapper', '');
            const avatar = textElement('avatar', '');
            const image = document.createElement('img');
            image.alt = prepared.name;
            image.src = prepared.force_avatar ?? '';
            avatar.append(image);
            avatarWrapper.append(avatar);
            const block = textElement('mes_block', '');
            const name = textElement('ch_name', '');
            name.append(textElement('name_text', prepared.name));
            block.append(name, textElement('mes_text', prepared.mes));
            element.append(avatarWrapper, block);
        }
        for (const control of element.querySelectorAll('button, .mes_button, .swipe_left, .swipe_right')) {
            control.disabled = true;
            control.setAttribute('aria-disabled', 'true');
        }
        return element;
    }

    function renderOverlays(snapshot) {
        document.querySelectorAll('[data-multiplayer-overlay]').forEach(element => element.remove());
        const chat = document.querySelector('#chat');
        if (!chat) {
            return;
        }
        for (const pending of snapshot.pending ?? []) {
            const saved = snapshot.messages.find(message => stableId(message) === pending.body.messageId);
            const message = pending.type === 'send' ? pending.body.message : { ...saved, mes: pending.type === 'edit' ? pending.body.text : saved?.mes };
            const element = overlayMessage(message);
            element.dataset.multiplayerPending = pending.id;
            element.style.borderStyle = 'dashed';
            element.style.borderWidth = '1px';
            const content = element.querySelector('.mes_block') ?? element;
            content.append(textElement('multiplayer-save-status', pending.status === 'failed' ? 'Not saved' : 'Saving…'));
            if (pending.status === 'failed') {
                content.append(textElement('multiplayer-save-reason', pending.reason));
                for (const [label, callback] of [['Retry', onRetry], ['Discard', onDiscard]]) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.textContent = label;
                    button.dataset.multiplayerAction = label.toLowerCase();
                    button.addEventListener('click', () => invoke(callback, pending.id));
                    content.append(button);
                }
            } else {
                const control = document.createElement('button');
                control.disabled = true;
                control.textContent = 'Saving…';
                content.append(control);
            }
            chat.append(element);
        }
        const seen = new Set();
        for (const preview of snapshot.previews ?? []) {
            if (seen.has(preview.messageId)) {
                continue;
            }
            seen.add(preview.messageId);
            const element = overlayMessage({ name: preview.name, mes: preview.text, force_avatar: preview.force_avatar, extra: { multiplayer: { messageId: preview.messageId } } });
            element.dataset.multiplayerPreview = preview.messageId;
            chat.append(element);
        }
        if (snapshot.interruption) {
            const element = textElement('multiplayer-interruption', 'AI generation interrupted.');
            element.dataset.multiplayerOverlay = '';
            chat.append(element);
        }
    }

    function liveElements(selector) {
        return [...document.querySelectorAll(selector)].filter(element => !element.closest('.template_element'));
    }

    function refresh() {
        observer?.disconnect();
        restore();
        const snapshot = state();
        if (!snapshot.shared) {
            document.querySelectorAll('[data-multiplayer-overlay]').forEach(element => element.remove());
        } else {
            for (const element of liveElements(unsupportedMutationSelectors)) {
                setProperty(element, 'hidden', true);
            }
            for (const element of liveElements(generationSelectors)) {
                if (!snapshot.isOwner) {
                    setProperty(element, 'hidden', true);
                }
                if (!available(snapshot)) {
                    setProperty(element, 'disabled', true);
                }
            }
            const sendButton = document.querySelector('#send_but');
            if (sendButton && !available(snapshot)) {
                setProperty(sendButton, 'disabled', true);
            }
            for (const element of liveElements(bulkSelectors)) {
                if (!snapshot.isOwner) {
                    setProperty(element, 'hidden', true);
                }
            }
            for (const element of document.querySelectorAll('#chat .mes[mesid]:not([data-multiplayer-overlay])')) {
                const message = messageAt(element, snapshot);
                const allowed = permissions(snapshot, message);
                const pending = snapshot.pending?.some(entry => (entry.body.messageId ?? stableId(entry.body.message)) === stableId(message));
                const preview = snapshot.previews?.some(entry => entry.messageId === stableId(message));
                if (pending || preview) {
                    setProperty(element, 'hidden', true);
                }
                for (const control of element.querySelectorAll('.mes_buttons, .mes_edit_buttons')) {
                    if (!allowed.controls) {
                        setProperty(control, 'hidden', true);
                    }
                }
                for (const control of element.querySelectorAll('.mes_edit, .mes_edit_done')) {
                    if (!allowed.edit) {
                        setProperty(control, 'hidden', true);
                    }
                }
                for (const control of element.querySelectorAll('button, .mes_button')) {
                    if (!available(snapshot) || pending) {
                        setProperty(control, 'disabled', true);
                    }
                }
            }
            renderOverlays(snapshot);
        }
        if (mounted) {
            observer?.observe(document.body, { childList: true, subtree: true });
        }
    }

    return {
        /** Installs capture handlers before native submission and observes dynamic controls. */
        mount() {
            if (mounted) {
                return;
            }
            mounted = true;
            document.addEventListener('click', captureClick, true);
            document.addEventListener('keydown', captureKey, true);
            document.addEventListener('input', captureInput, true);
            observer = new window.MutationObserver(refresh);
            refresh();
        },
        /** Refreshes permissions and provisional overlays from the current session snapshot. */
        refresh,
        /** Removes handlers and provisional displays, restoring native control properties. */
        dispose() {
            mounted = false;
            observer?.disconnect();
            document.removeEventListener('click', captureClick, true);
            document.removeEventListener('keydown', captureKey, true);
            document.removeEventListener('input', captureInput, true);
            restore();
            document.querySelectorAll('[data-multiplayer-overlay]').forEach(element => element.remove());
        },
    };
}

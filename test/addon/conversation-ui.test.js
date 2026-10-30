import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const moduleUrl = new URL('../../addon/conversation-ui.js', import.meta.url);
const integration = await import(moduleUrl).catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes(moduleUrl.pathname)) {
        throw error;
    }
    return {};
});

function fixture(t, stateOverrides = {}) {
    assert.equal(typeof integration.createConversationUI, 'function');
    const dom = new JSDOM('<textarea id="send_textarea"></textarea><button id="send_but">Send</button><button id="option_regenerate">Regenerate</button><button id="option_delete_mes">Bulk delete</button><div id="chat"></div>', { url: 'http://localhost/' });
    t.after(() => dom.window.close());
    const { document } = dom.window;
    const calls = [];
    const state = {
        shared: true, isOwner: false, ownerPresent: true, connected: true,
        generating: false, accountId: 'guest', messages: [], pending: [], previews: [],
        ...stateOverrides,
    };
    let enterEnabled = true;
    const ui = integration.createConversationUI({
        document, window: dom.window, getState: () => state,
        onSubmit: text => { calls.push(['submit', text]); },
        onGenerate: () => { calls.push(['generate']); },
        onEdit: (...args) => { calls.push(['edit', ...args]); },
        onDelete: (...args) => { calls.push(['delete', ...args]); },
        onRetry: (...args) => { calls.push(['retry', ...args]); },
        onDiscard: (...args) => { calls.push(['discard', ...args]); },
        shouldSendOnEnter: () => enterEnabled, isPopupOpen: () => false,
    });
    document.querySelector('#send_but').addEventListener('click', () => calls.push(['nativeClick']));
    document.addEventListener('keydown', () => calls.push(['nativeKey']));
    ui.mount();
    t.after(() => ui.dispose());
    return { ui, state, calls, document, window: dom.window, setEnterEnabled(value) { enterEnabled = value; } };
}

function key(window, target, options = {}) {
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options }));
}

function addMessage(document, index) {
    const element = document.createElement('div');
    element.className = 'mes';
    element.setAttribute('mesid', String(index));
    element.innerHTML = '<div class="mes_buttons"><button class="mes_edit">Edit</button><button class="mes_edit_delete">Delete</button><button class="mes_copy">Copy</button></div>';
    document.querySelector('#chat').append(element);
    return element;
}

function hidden(element) {
    return element.hidden || element.style.display === 'none' || Boolean(element.closest('[hidden]'));
}

test('shared Send is captured before an already-installed native click handler', t => {
    const { document, calls } = fixture(t);
    document.querySelector('#send_textarea').value = 'my turn';
    document.querySelector('#send_but').click();
    assert.deepEqual(calls, [['submit', 'my turn']]);
});

for (const ctrlKey of [false, true]) {
    test(`shared ${ctrlKey ? 'Ctrl+Enter' : 'Enter'} with text bypasses native submission handlers`, t => {
        const { document, window, calls } = fixture(t);
        const composer = document.querySelector('#send_textarea');
        composer.value = 'keyboard turn';
        composer.focus();
        key(window, composer, { ctrlKey });
        assert.deepEqual(calls, [['submit', 'keyboard turn']]);
    });
}

test('ordinary chat submission is untouched', t => {
    const { document, window, calls } = fixture(t, { shared: false });
    const composer = document.querySelector('#send_textarea');
    composer.value = 'ordinary';
    composer.focus();
    document.querySelector('#send_but').click();
    key(window, composer);
    assert.deepEqual(calls, [['nativeClick'], ['nativeKey']]);
});

for (const options of [{ shiftKey: true }, { isComposing: true }]) {
    test(`drafting Enter ${JSON.stringify(options)} remains native`, t => {
        const { document, window, calls } = fixture(t);
        const composer = document.querySelector('#send_textarea');
        composer.value = 'draft';
        composer.focus();
        key(window, composer, options);
        assert.deepEqual(calls, [['nativeKey']]);
    });
}

test('disabled Enter-to-send preference retains plain Enter behavior', t => {
    const { document, window, calls, setEnterEnabled } = fixture(t);
    setEnterEnabled(false);
    const composer = document.querySelector('#send_textarea');
    composer.focus();
    composer.value = 'draft';
    key(window, composer);
    assert.deepEqual(calls, [['nativeKey']]);
});

for (const isOwner of [false, true]) {
    test(`empty Send ${isOwner ? 'requests queued owner generation' : 'cannot generate for guest'}`, t => {
        const { document, calls } = fixture(t, { isOwner });
        document.querySelector('#send_but').click();
        assert.deepEqual(calls, isOwner ? [['generate']] : []);
    });
}

for (const unavailable of [{ generating: true }, { ownerPresent: false }, { connected: false }]) {
    test(`unavailable actions leave composer usable: ${JSON.stringify(unavailable)}`, t => {
        const { document, calls } = fixture(t, unavailable);
        const composer = document.querySelector('#send_textarea');
        composer.value = 'keep drafting';
        document.querySelector('#send_but').click();
        assert.deepEqual(calls, []);
        assert.equal(composer.disabled, false);
        assert.equal(composer.readOnly, false);
        assert.equal(composer.value, 'keep drafting');
    });
}

test('guest controls expose only their own player-message edits and single deletion', t => {
    const { ui, state, document } = fixture(t);
    state.messages = [
        { is_user: true, extra: { multiplayer: { accountId: 'guest', messageId: 'mine' } } },
        { is_user: true, extra: { multiplayer: { accountId: 'host', messageId: 'other' } } },
        { is_user: false, extra: { multiplayer: { messageId: 'ai' } } },
    ];
    const elements = state.messages.map((message, index) => addMessage(document, index));
    ui.refresh();
    assert.equal(hidden(elements[0].querySelector('.mes_edit')), false);
    assert.equal(hidden(elements[0].querySelector('.mes_edit_delete')), false);
    for (const element of elements.slice(1)) {
        for (const button of element.querySelectorAll('button')) {
            assert.equal(hidden(button), true);
        }
    }
    assert.equal(hidden(document.querySelector('#option_delete_mes')), true);
    assert.equal(hidden(document.querySelector('#option_regenerate')), true);
});

test('owner cannot edit another account player message but can delete it', t => {
    const { ui, state, document } = fixture(t, { isOwner: true, accountId: 'host' });
    state.messages = [{ is_user: true, extra: { multiplayer: { accountId: 'guest', messageId: 'other' } } }];
    const element = addMessage(document, 0);
    ui.refresh();
    assert.equal(hidden(element.querySelector('.mes_edit')), true);
    assert.equal(hidden(element.querySelector('.mes_edit_delete')), false);
});

test('dispose restores ordinary native submission handling', t => {
    const { ui, document, calls } = fixture(t);
    ui.dispose();
    document.querySelector('#send_textarea').value = 'normal';
    document.querySelector('#send_but').click();
    assert.deepEqual(calls, [['nativeClick']]);
});

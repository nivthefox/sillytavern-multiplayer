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

test('pending turn is separate, dashed, labeled and non-interactive without replacing draft', t => {
    const { ui, state, document } = fixture(t);
    document.querySelector('#send_textarea').value = 'next draft';
    state.pending = [{ id: 'pending-1', type: 'send', status: 'pending', body: { message: { mes: '<script>draft</script>', name: 'PC', extra: { multiplayer: { messageId: 'one' } } }, iteration: 0 } }];
    ui.refresh();
    const pending = document.querySelector('[data-multiplayer-pending="pending-1"]');
    assert.ok(pending);
    assert.match(pending.textContent, /Saving…/);
    assert.match(pending.textContent, /<script>draft<\/script>/);
    assert.equal(pending.querySelector('script'), null);
    assert.equal(pending.style.borderStyle, 'dashed');
    assert.equal(pending.querySelectorAll('button:not(:disabled)').length, 0);
    assert.deepEqual(state.messages, []);
    assert.equal(document.querySelector('#send_textarea').value, 'next draft');
});

test('failed edit keeps attempted text and Retry/Discard forward opaque pending id without changing draft', t => {
    const { ui, state, document, calls } = fixture(t);
    state.messages = [{ mes: 'saved', is_user: true, extra: { multiplayer: { messageId: 'one', accountId: 'guest' } } }];
    state.pending = [{ id: 'edit-attempt', type: 'edit', status: 'failed', reason: 'Write failed', body: { messageId: 'one', text: 'attempt', iteration: 0 } }];
    document.querySelector('#send_textarea').value = 'next draft';
    ui.refresh();
    const pending = document.querySelector('[data-multiplayer-pending="edit-attempt"]');
    assert.match(pending.textContent, /attempt/);
    assert.match(pending.textContent, /Not saved/);
    assert.match(pending.textContent, /Write failed/);
    const buttons = [...pending.querySelectorAll('button')];
    buttons.find(button => button.textContent === 'Retry').click();
    buttons.find(button => button.textContent === 'Discard').click();
    assert.deepEqual(calls, [['retry', 'edit-attempt'], ['discard', 'edit-attempt']]);
    assert.equal(document.querySelector('#send_textarea').value, 'next draft');
    assert.equal(state.messages[0].mes, 'saved');
});

test('failed deletion retains saved content and clearing overlay restores saved display', t => {
    const { ui, state, document } = fixture(t);
    state.messages = [{ mes: 'do not lose me', extra: { multiplayer: { messageId: 'one' } } }];
    state.pending = [{ id: 'delete-attempt', type: 'delete', status: 'failed', body: { messageId: 'one', iteration: 0 } }];
    ui.refresh();
    assert.match(document.querySelector('[data-multiplayer-pending]').textContent, /do not lose me/);
    state.pending = [];
    ui.refresh();
    assert.equal(document.querySelector('[data-multiplayer-pending]'), null);
    assert.equal(state.messages[0].mes, 'do not lose me');
});

test('AI preview updates replace one provisional display and saved identity suppresses duplication', t => {
    const { ui, state, document } = fixture(t);
    state.previews = [{ messageId: 'ai-one', name: 'GM', text: 'first', force_avatar: '/npc.png' }];
    ui.refresh();
    state.previews[0].text = 'first second';
    ui.refresh();
    assert.equal(document.querySelectorAll('[data-multiplayer-preview="ai-one"]').length, 1);
    assert.match(document.querySelector('[data-multiplayer-preview]').textContent, /first second/);
    state.messages = [{ mes: 'saved', extra: { multiplayer: { messageId: 'ai-one' } } }];
    state.previews = [];
    ui.refresh();
    assert.equal(document.querySelector('[data-multiplayer-preview]'), null);
});

test('a streamed replacement swipe temporarily replaces its existing saved message', t => {
    const { ui, state, document } = fixture(t);
    state.messages = [{ mes: 'old response', is_user: false, extra: { multiplayer: { messageId: 'ai-one' } } }];
    const row = addMessage(document, 0);
    state.previews = [{ messageId: 'ai-one', name: 'GM', text: 'new response', force_avatar: '/npc.png' }];
    ui.refresh();
    assert.equal(hidden(row), true);
    assert.match(document.querySelector('[data-multiplayer-preview]')?.textContent ?? '', /new response/);
    state.previews = [];
    ui.refresh();
    assert.equal(hidden(row), false);
});

test('unsupported native move and clone controls cannot bypass shared persistence', t => {
    const { ui, state, document } = fixture(t, { isOwner: true, accountId: 'guest' });
    state.messages = [{ is_user: true, extra: { multiplayer: { messageId: 'mine', accountId: 'guest' } } }];
    const row = addMessage(document, 0);
    for (const name of ['mes_edit_copy', 'mes_edit_up', 'mes_edit_down']) {
        const control = document.createElement('button'); control.className = name;
        let activated = false;
        control.addEventListener('click', () => { activated = true; });
        row.append(control);
        ui.refresh();
        assert.equal(hidden(control), true);
        control.click();
        assert.equal(activated, false);
    }
});

test('Guided Simple Send uses shared submission without intercepting Guided Impersonate', t => {
    const { document, calls } = fixture(t);
    document.querySelector('#send_textarea').value = 'assisted turn';
    const send = document.createElement('button'); send.id = 'gg_simple_send_button'; document.body.append(send);
    send.addEventListener('click', () => calls.push(['addonSend']));
    send.click();
    const impersonate = document.createElement('button'); impersonate.id = 'gg_impersonate_button'; document.body.append(impersonate);
    impersonate.addEventListener('click', () => calls.push(['draftAssist'])); impersonate.click();
    assert.deepEqual(calls, [['submit', 'assisted turn'], ['draftAssist']]);
});

test('shared chats do not expose native automatic group generation', t => {
    const { ui, document } = fixture(t);
    const automatic = document.createElement('input'); automatic.type = 'checkbox'; automatic.id = 'rm_group_automode'; document.body.append(automatic);
    let activated = false;
    automatic.addEventListener('click', () => { activated = true; });
    ui.refresh();
    assert.equal(hidden(automatic), true);
    automatic.click();
    assert.equal(activated, false);
});

test('dispose restores ordinary native submission handling', t => {
    const { ui, document, calls } = fixture(t);
    ui.dispose();
    document.querySelector('#send_textarea').value = 'normal';
    document.querySelector('#send_but').click();
    assert.deepEqual(calls, [['nativeClick']]);
});

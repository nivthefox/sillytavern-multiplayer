import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { getSettingsContainer } from '../../addon/settings-ui.js';

test('settings share one native collapsed drawer', () => {
    const dom = new JSDOM('<div id="extensions_settings"></div>');
    const document = dom.window.document;
    const content = getSettingsContainer(document);
    assert.equal(getSettingsContainer(document), content);
    assert.equal(document.querySelectorAll('#multiplayer_settings').length, 1);
    assert.equal(content.className, 'inline-drawer-content');
    const drawer = content.parentElement;
    assert.equal(drawer.parentElement.id, 'extensions_settings');
    assert.equal(drawer.querySelector('.inline-drawer-header b').textContent, 'Multiplayer');
    assert.ok(drawer.querySelector('.inline-drawer-toggle .inline-drawer-icon.down'));
    dom.window.close();
});

test('settings drawer waits for the native settings container', () => {
    const dom = new JSDOM('');
    assert.equal(getSettingsContainer(dom.window.document), null);
    dom.window.close();
});

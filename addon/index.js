import { initializeOwnership } from './ownership-bootstrap.js';
import { getPluginStatus } from './plugin-status.js';

const statusMessages = {
    checking: 'Checking server plugin…',
    available: 'Server plugin connected. Shared multiplayer play is still under development.',
    missing: 'The multiplayer server plugin is not installed or enabled.',
    unavailable: 'Could not verify the multiplayer server plugin. Check your connection and login, then try again.',
};

function createDocumentationLink() {
    const link = document.createElement('a');
    link.href = 'https://github.com/nivthefox/sillytavern-multiplayer#installation';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Installation instructions';
    return link;
}

function createStatusPanel() {
    const panel = document.createElement('section');
    panel.id = 'multiplayer_setup';
    const heading = document.createElement('h3');
    heading.textContent = 'Multiplayer';
    const message = document.createElement('p');
    const instructions = document.createElement('p');
    instructions.textContent = 'Server administrator: in a persistent checkout of this repository, run npm run setup:plugin -- /path/to/SillyTavern, set enableServerPlugins: true in config.yaml, and restart SillyTavern. Players should ask their administrator to do this once for the server.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'menu_button';
    retry.textContent = 'Check again';
    panel.append(heading, message, instructions, createDocumentationLink(), retry);
    return { panel, message, instructions, retry };
}

function renderPluginStatus(view, status) {
    view.message.textContent = statusMessages[status];
    view.instructions.hidden = status !== 'missing';
    view.retry.disabled = status === 'checking';
}

async function refreshPluginStatus(view) {
    renderPluginStatus(view, 'checking');
    const status = await getPluginStatus(globalThis.fetch.bind(globalThis));
    renderPluginStatus(view, status);
}

function mountStatusPanel() {
    const container = document.getElementById('extensions_settings');
    if (!container || document.getElementById('multiplayer_setup')) {
        return;
    }
    const view = createStatusPanel();
    container.append(view.panel);
    view.retry.addEventListener('click', () => refreshPluginStatus(view));
    void refreshPluginStatus(view);
}

function initializeAddon() {
    if (typeof document === 'undefined') {
        return;
    }
    if (globalThis.SillyTavern) {
        void initializeOwnership().catch(error => globalThis.toastr?.error(error.message, 'Multiplayer'));
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountStatusPanel, { once: true });
        return;
    }
    mountStatusPanel();
}

initializeAddon();

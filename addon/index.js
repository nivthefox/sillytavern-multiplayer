import { getPluginStatus } from './plugin-status.js';

async function showPluginStatus() {
    const container = document.getElementById('extensions_settings');
    if (!container || document.getElementById('multiplayer_setup')) {
        return;
    }
    const panel = document.createElement('section');
    panel.id = 'multiplayer_setup';
    const heading = document.createElement('h3');
    heading.textContent = 'Multiplayer';
    const message = document.createElement('p');
    const instructions = document.createElement('p');
    instructions.textContent = 'Server administrator: in a persistent checkout of this repository, run npm run setup:plugin -- /path/to/SillyTavern, set enableServerPlugins: true in config.yaml, and restart SillyTavern. Players should ask their administrator to do this once for the server.';
    const documentation = document.createElement('a');
    documentation.href = 'https://github.com/nivthefox/sillytavern-multiplayer#installation';
    documentation.target = '_blank';
    documentation.rel = 'noopener noreferrer';
    documentation.textContent = 'Installation instructions';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'menu_button';
    retry.textContent = 'Check again';
    panel.append(heading, message, instructions, documentation, retry);
    container.append(panel);

    async function refresh() {
        retry.disabled = true;
        message.textContent = 'Checking server plugin…';
        instructions.hidden = true;
        const status = await getPluginStatus(globalThis.fetch.bind(globalThis));
        const messages = {
            available: 'Server plugin connected. Shared multiplayer play is still under development.',
            missing: 'The multiplayer server plugin is not installed or enabled.',
            unavailable: 'Could not verify the multiplayer server plugin. Check your connection and login, then try again.',
        };
        message.textContent = messages[status];
        instructions.hidden = status !== 'missing';
        retry.disabled = false;
    }

    retry.addEventListener('click', refresh);
    await refresh();
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', showPluginStatus, { once: true });
    } else {
        void showPluginStatus();
    }
}

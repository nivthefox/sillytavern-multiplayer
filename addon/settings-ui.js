/**
 * Gets or mounts the shared Multiplayer settings drawer.
 * @param {Document} document SillyTavern's document.
 * @returns {HTMLElement|null} Drawer content, or null when settings are unavailable.
 */
export function getSettingsContainer(document) {
    const existing = document.getElementById('multiplayer_settings_content');
    if (existing) {
        return existing;
    }
    const settings = document.getElementById('extensions_settings');
    if (!settings) {
        return null;
    }
    const drawer = document.createElement('div');
    drawer.id = 'multiplayer_settings';
    drawer.className = 'inline-drawer';
    const header = document.createElement('div');
    header.className = 'inline-drawer-toggle inline-drawer-header';
    const title = document.createElement('b');
    title.textContent = 'Multiplayer';
    const icon = document.createElement('div');
    icon.className = 'inline-drawer-icon fa-solid fa-circle-chevron-down down';
    header.append(title, icon);
    const content = document.createElement('div');
    content.id = 'multiplayer_settings_content';
    content.className = 'inline-drawer-content';
    drawer.append(header, content);
    settings.append(drawer);
    return content;
}

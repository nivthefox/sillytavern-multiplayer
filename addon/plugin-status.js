/**
 * Check whether the multiplayer server plugin is loaded for the current session.
 * @param {typeof fetch} request Same-origin HTTP fetch implementation.
 * @returns {Promise<'available'|'missing'|'unavailable'>} Plugin availability, distinguishing a missing route from other failures.
 */
export async function getPluginStatus(request) {
    try {
        const response = await request('/api/plugins/multiplayer/status', {
            cache: 'no-store',
            signal: AbortSignal.timeout(10000),
        });
        if (response.status === 404) {
            return 'missing';
        }
        if (!response.ok) {
            return 'unavailable';
        }
        const body = await response.json();
        return body.plugin === 'multiplayer' ? 'available' : 'unavailable';
    } catch {
        return 'unavailable';
    }
}

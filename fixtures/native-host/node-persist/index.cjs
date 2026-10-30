const values = new Map();

module.exports = {
    /**
     * @param {string} key Storage key; avatar:broken simulates a read failure.
     * @returns {Promise<unknown>} Stored value.
     */
    async getItem(key) {
        if (key === 'avatar:broken') {
            throw new Error('Storage unavailable');
        }
        return values.get(key);
    },

    /**
     * @param {string} key Storage key.
     * @param {unknown} value Value to seed.
     * @returns {Promise<Map>} Fixture storage after insertion.
     */
    async setItem(key, value) {
        return values.set(key, value);
    },
};

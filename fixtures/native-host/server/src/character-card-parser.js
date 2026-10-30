/**
 * @param {Buffer} buffer Fixture card contents.
 * @returns {string} Unmodified UTF-8 text for delegation assertions.
 */
export function read(buffer) {
    return buffer.toString('utf8');
}

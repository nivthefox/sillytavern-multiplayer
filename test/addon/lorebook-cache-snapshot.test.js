import assert from 'node:assert/strict';
import test from 'node:test';
import { createLorebookSession } from '../../addon/lorebook-session.js';

test('native cache snapshots distinguish unloaded advertisements and isolate complete cached contents', async () => {
    let finish;
    const session = createLorebookSession({ accountId: 'guest', send: async () => {}, isSelf: () => false,
        fetch: () => new Promise(resolve => { finish = resolve; }),
    });
    session.open({ accountId: 'owner', groupId: 'g', chatId: 'c' });
    const identity = { accountId: 'owner', filename: 'World.json' };
    const joining = session.joined({ isOwner: false, ownerPresent: true, lorebooks: [identity] });
    assert.equal(typeof session.getBooks, 'function');
    assert.deepEqual(session.getBooks(), [{ ...identity, data: undefined }]);
    finish(Response.json({ entries: { 1: { disable: true, content: 'GM secret' } } }));
    await joining;
    const books = session.getBooks();
    assert.equal(books[0].data.entries[1].content, 'GM secret');
    books[0].data.entries[1].content = 'mutated';
    books[0].filename = 'Other.json';
    assert.equal(session.getBooks()[0].data.entries[1].content, 'GM secret');
    assert.equal(session.getBooks()[0].filename, 'World.json');
    session.leave();
    assert.deepEqual(session.getBooks(), []);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createEventBus } from '../../plugin/event-bus.js';

const chat = { accountId: 'owner', groupId: 'group', chatId: 'chat' };

for (const destination of ['all', 'server']) {
    for (const kind of ['BigInt', 'circular', 'undefined']) {
        test(`server sends reject ${kind} before routing to ${destination}`, async t => {
            const bus = createEventBus({ authorizeJoin: async () => {} });
            t.after(() => bus.close());
            const delivered = [];
            const client = bus.connect('owner', envelope => delivered.push(envelope));
            await client.receive(JSON.stringify({ op: 'join', requestId: 'join', ...chat }));
            delivered.length = 0;
            const handled = [];
            bus.on('example.event', (...args) => handled.push(args));
            const circular = {};
            circular.self = circular;
            const body = { BigInt: { value: 1n }, circular, undefined: undefined }[kind];
            await assert.rejects(bus.send(chat, destination, 'example.event', body));
            assert.deepEqual(delivered, []);
            assert.deepEqual(handled, []);
            await bus.send(chat, destination, 'example.event', { valid: true });
            assert.equal(destination === 'all' ? delivered.length : handled.length, 1);
        });
    }
}

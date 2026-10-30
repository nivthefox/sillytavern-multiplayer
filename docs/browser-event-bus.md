# Browser event-bus library

`addon/event-bus.js` exports `BrowserEventBus`, a browser-safe ES module with no startup side effects. It implements the transport contract in [Server Plugin](specs/2026-10-30-server-plugin.html). It does not implement shared-chat UI, message persistence, generation, or lorebook access.

## Integration

Create one instance for your browser integration and share it with consuming addons. Separate instances create separate server connections and participate independently in session-owner selection.

```javascript
import { BrowserEventBus } from './addon/event-bus.js';

let currentSharedChat = null;
const bus = new BrowserEventBus({
    getCurrentChat: () => currentSharedChat,
    getRequestHeaders: () => SillyTavern.getContext().getRequestHeaders(),
});

bus.on('bus.disconnected', () => {
    showConnectionLost();
});

bus.on('bus.status', (chat, sender, status) => {
    updateSessionStatus(chat, status);
});

await bus.connect();
currentSharedChat = { accountId: 'scene-owner', groupId: 'group-id', chatId: 'chat-id' };
const { isOwner, ownerPresent, lorebooks } = await bus.join(currentSharedChat);

const unsubscribe = bus.on('my-addon.update', (chat, sender, body) => {
    displayUpdate(chat, sender, body);
});
await bus.send('all', 'my-addon.update', { text: 'Hello' });
unsubscribe();

currentSharedChat = null;
await bus.leave();
```

Adjust the import path for the consumer's location. The display functions above belong to the consuming addon. `getCurrentChat` must return the currently open shared chat's owning account, group, and chat IDs, or `null`, including while disconnected. Do not implement it as a remembered last successful join. The consumer owns chat selection and calls `join`/`leave` when that selection changes.

## API

- `connect()` returns a promise for WebSocket opening, not for chat joining. An already-open connection is a no-op. During scheduled retry backoff it rejects with `connection_unavailable` without interrupting automatic retries. Calling it explicitly restarts connection attempts after a ticket HTTP 403 has stopped retries and authentication has been restored.
- `join({ accountId, groupId, chatId })` resolves with `{ isOwner, ownerPresent, lorebooks }` on the matching server acknowledgment. A failed join preserves the previous server association. A newer join or leave rejects an outstanding join as superseded.
- `leave()` resolves without a value on acknowledgment, including when already unjoined.
- `send(destination, eventName, body)` resolves without a value when the server accepts routing, **not** when recipients finish handling it. Destinations are `owner`, `all`, `server`, or a received `sender.connectionId`. Event names are namespaced; bodies are opaque JSON. The server supplies the authenticated sender and chat context.
- `on(eventName, handler)` synchronously returns an idempotent unsubscribe function for that registration. Each handler receives `(chat, sender, body)` as independent deep copies, in registration order. Async completion is not awaited; failures are logged without blocking other handlers.
- `sessionStatus` exposes a defensive snapshot of the latest accepted `{ isOwner, ownerPresent }`, or `null` without session status. Consumers should use lifecycle notifications and the current chat when applying it.

`bus.connected` and `bus.disconnected` handlers receive `(null, null, null)`. `bus.status` receives `(chat, null, { isOwner, ownerPresent })`. Successful current-chat joins also publish status. These lifecycle names cannot be sent as application events. Server-originated application events retain their chat identity and have a null sender. Events and statuses for a different currently open chat are discarded.

## Recovery and failures

Tickets are requested with native session credentials and CSRF headers, without a request body, then presented to the same server's WebSocket endpoint. The library reconnects after 1, 2, 4, 8, then 15 seconds, keeping subsequent retries at 15 seconds. Opening a connection resets this delay; ticket HTTP 403 stops retries until explicit `connect()`.

The first connection starts unjoined. On reconnection, the library consults `getCurrentChat` and joins that chat, or none. It never replays sends. Connection opening and successful rejoining are separate stages; `bus.connected` is not proof of chat membership. A consumer needing the combined lorebook list can explicitly call `join` and use its acknowledged result.

Server failures reject with an `Error` preserving its `code` and `message`. Pending requests reject with an explicit unknown-outcome error when the connection drops: they may already have taken effect. Superseded joins reject separately. Neither condition implies that a request was undelivered. Consumers decide whether an application-level retry is safe.

Disconnected, unjoined, mismatched-current-chat, and known-ownerless sends fail without queueing. Nonserializable bodies and reserved event names are rejected locally without closing the socket.

## Testing dependencies

The constructor accepts `fetch`, `WebSocket`, `location`, `getRequestHeaders`, `getCurrentChat`, `setTimeout`, `clearTimeout`, and `logger`. Browser globals supply transport and timer defaults; native SillyTavern context supplies default request headers. Injected dependencies allow controlled-clock tests without a running SillyTavern installation.

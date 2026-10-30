# SillyTavern Multiplayer

Play a shared scene with other people and an AI GM in SillyTavern. Each player speaks through their own persona, while the scene owner controls AI turns and shares the group's characters and lorebooks.

The project includes a server plugin and a browser addon for accounts on the same SillyTavern server.

**Status:** the plugin's read-only HTTP resource routes are implemented. The browser addon and event bus remain scaffolds; shared play is not implemented yet.

## License

Copyright © 2026 Kevin Kragenbrink, II.

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version.

This program is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full terms.

SPDX license identifier: `AGPL-3.0-or-later`.

## Compatibility

The HTTP adapter targets native interfaces inspected in SillyTavern **1.18.0** (`release`, commit `b3308302e`). Live SillyTavern integration has not been tested. Route tests use isolated storage fixtures and Express 4.

Development and tests require **Node.js 22+** and npm. Source code uses modern JavaScript ES modules, with no build step.

## Installation

Symlink both directories from this project into the local SillyTavern installation. From the repository root:

```sh
npm ci
ln -s "$PWD/plugin" /root/tavern/plugins/multiplayer
ln -s "$PWD/addon" /root/tavern/public/scripts/extensions/third-party/multiplayer
```

Adjust `/root/tavern` if SillyTavern lives elsewhere. Enable `enableServerPlugins` in SillyTavern's configuration and restart the server.

The plugin registers resource routes under `/api/plugins/multiplayer`. It adds no browser controls or multiplayer connections.

## HTTP integration

The GET routes implement `/accounts`, account-qualified character cards/images, persona images and lorebooks, plus `/chats` and its account/group/chat resources. Authentication uses `request.user.profile.handle`; SillyTavern's native session and CSRF middleware must precede the router. Reads require no owner browser or event-bus connection.

Account discovery reads `extension_settings.multiplayer.allowGroupInvites` from each account's `settings.json`. An absent preference is enabled; `false` opts out of discovery without changing existing memberships. Account avatars come from configured native account-avatar storage, not a persona fallback.

`init(router, { host, issueTicket })` accepts optional integration dependencies:

- `host`: native account, directory, avatar, character-card parser, and byte-formatting operations. The default adapter resolves SillyTavern modules and its existing `node-persist` singleton from the server working directory, so the documented symlink installation works. Tests substitute these operations without booting SillyTavern.
- `issueTicket(request)`: an event-bus-owned function receiving the original authenticated request, including its socket and mount URL, and returning `{ ticket, expiresAt }`. The bus implementation must attach its listener before issuing the ticket and own ticket lifetime/consumption. The HTTP wrapper does neither. Until an issuer is wired into initialization, authenticated `POST /events/connect` requests return 500. Native upstream CSRF protection remains responsible for rejecting invalid POST requests.

Resource responses are not cached. Missing authorized files return 404, read/parse failures return 500, and unauthorized requests return 403 before resource reads. Routes never write native storage.

## Development

```sh
npm ci
npm test
```

Run plugin or addon tests separately:

```sh
npm run test:plugin
npm run test:addon
```

Tests use Node's built-in test runner, temporary native-storage fixtures, fake authenticated requests, and a local Express test server. They need no running SillyTavern, event bus, or AI service. The route-free scaffold was verified to fail the HTTP contract tests and committed before implementation; subsequent regression tests cover additional failure cases.

## Project layout

- `plugin/` — server plugin
- `addon/` — browser addon
- `test/` — plugin and addon unit tests
- `package.json` — shared project configuration and test commands
- `docs/brief.html` — project concept and scope
- `docs/specs/` — server plugin, chat ownership, shared conversations, and shared lorebook specifications

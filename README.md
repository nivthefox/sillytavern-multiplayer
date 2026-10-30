# SillyTavern Multiplayer

Play a shared scene with other people and an AI GM in SillyTavern. Each player speaks through their own persona, while the scene owner controls AI turns and shares the group's characters and lorebooks.

The project includes a server plugin and a browser addon for accounts on the same SillyTavern server.

**Status:** workspace scaffold only. Multiplayer features are not implemented yet.

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

The scaffold was developed against SillyTavern **1.18.0** (`release`, commit `b3308302e`). The supported version target is not yet confirmed, and live integration has not been tested.

Development and tests require **Node.js 22+** and npm. Source code uses modern JavaScript ES modules, with no build step.

## Installation

For local development, copy or symlink:

- `packages/plugin/` → `<SillyTavern>/plugins/multiplayer/`
- `packages/addon/` → `<SillyTavern>/public/scripts/extensions/third-party/multiplayer/`

Enable `enableServerPlugins` in SillyTavern's configuration and restart the server. Install these package directories, not the repository root.

The scaffold currently adds no controls, routes, or multiplayer connections.

## Development

```sh
npm ci
npm test
```

Run either package's tests separately:

```sh
npm run test:plugin
npm run test:addon
```

Tests use Node's built-in test runner and need no running SillyTavern or AI service. The initial suite contains three scaffold tests per package.

## Project layout

- `packages/plugin/` — server plugin
- `packages/addon/` — browser addon
- `docs/brief.html` — project concept and scope
- `docs/specs/` — server plugin, chat ownership, shared conversations, and shared lorebook specifications

# SillyTavern Multiplayer

Play a shared scene with other people and an AI GM in SillyTavern. Each player speaks through their own persona, while the scene owner controls AI turns and shares the group's characters and lorebooks.

The project includes a server plugin and a browser addon for accounts on the same SillyTavern server.

**Status:** under development. Shared multiplayer play is not available yet.

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

Target version: SillyTavern **1.18.0**. Requires **Node.js 22+** and npm.

## Installation

Symlink both directories from this project into the local SillyTavern installation. From the repository root:

```sh
npm ci --omit=dev
ln -s "$PWD/plugin" /root/tavern/plugins/multiplayer
ln -s "$PWD/addon" /root/tavern/public/scripts/extensions/third-party/multiplayer
```

Adjust `/root/tavern` if SillyTavern lives elsewhere. Enable `enableServerPlugins` in SillyTavern's configuration and restart the server.

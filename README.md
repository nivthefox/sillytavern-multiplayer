# SillyTavern Multiplayer

A multiplayer addon for sharing a scene with friends and an AI GM in SillyTavern. Each player will speak through their own persona, while the scene owner controls AI turns and shares the group's characters and lorebooks. Everyone uses an account on the same SillyTavern server.

**Still under development: shared multiplayer play is not available yet.** You can install the addon and check its server connection, but you cannot play a shared scene yet.

## Requirements

- SillyTavern **1.18.0** is the target version.
- The person running your SillyTavern server must install the server plugin once. Installing the addon alone is not enough.
- Server setup requires **Git, Node.js 22+, and npm**.

## Installation

### For players

1. In SillyTavern, open **Extensions → Install extension**.
2. Paste this address:

   ```text
   https://github.com/nivthefox/sillytavern-multiplayer
   ```

3. Open the extension settings and find **Multiplayer** to check the server connection.

If the server plugin is missing, ask the person running your SillyTavern server to complete the setup below. You do not need to run server commands yourself unless you run the server.

An administrator can also install the browser addon globally for everyone on the server.

### For the person running the server

Complete this once on the machine running SillyTavern, using the same operating-system account that runs it.

1. Open a terminal in a folder where you want to keep Multiplayer, then run:

   ```sh
   git clone https://github.com/nivthefox/sillytavern-multiplayer.git
   cd sillytavern-multiplayer
   npm run setup:plugin -- /path/to/SillyTavern
   ```

   Replace `/path/to/SillyTavern` with your SillyTavern installation folder. Put the path in quotes if it contains spaces. The setup command installs the plugin and its required packages.

2. Open SillyTavern's `config.yaml` (or your custom configuration file) and set:

   ```yaml
   enableServerPlugins: true
   ```

3. Restart SillyTavern.
4. In the Multiplayer extension settings, select **Check again** to confirm the connection.

**Keep the `sillytavern-multiplayer` folder where you installed it.** Moving or deleting it will stop the server plugin from working.

## Updating

Update the browser addon through SillyTavern's extension manager.

The person running the server should also open a terminal in the `sillytavern-multiplayer` folder and run:

```sh
git pull
npm run setup:plugin -- /path/to/SillyTavern
```

Replace the path as you did during installation, then restart SillyTavern. Update both the browser addon and server plugin together; the server plugin needs this manual update step.

## Troubleshooting

- **Server plugin missing:** Check that server setup is complete, `enableServerPlugins` is enabled, and SillyTavern has been restarted.
- **Could not verify the plugin:** Check your connection and make sure you are logged into SillyTavern, then select **Check again**.
- **Setup refuses to overwrite an existing installation:** There is already something installed at `plugins/multiplayer`. Setup leaves it untouched. The server administrator should check it before removing or relocating it and trying again.
- **Upgrading from the old manual installation:** Remove the old browser-addon symlink pointing to `addon/`, without deleting the folder it points to, then install through SillyTavern's extension dialog. An existing server-plugin symlink pointing to this installation can stay in place.

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

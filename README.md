# amethyst-mcp

MCP server driving Amethyst Mod Manager (2.6+) through its headless
JSON-RPC API (`amethyst-mod-manager-cli headless --stdio`, protocol v1).
Lets coding agents install local mod builds, deploy profiles, and inspect
manager state without copying zips around by hand.

Requires Amethyst 2.6.0 or newer. Defaults to the Flatpak backend
(`io.github.Amethyst.ModManager`); set `AMETHYST_CLI` to a native binary,
AppImage, or source `cli.py` to use another backend.

## Tools

- `status` - handshake; manager version and capability summary.
- `list_mods` - profile mod list, summary by default (use this, not
  `call` with `mods.list`, which returns ~100KB verbatim on big profiles).
- `call` - full passthrough to any headless method. `*.start` jobs return
  the final snapshot when `wait` is true.
- `job` - get, list, events, cancel, pause, resume for jobs.
- `install_mod` - install a local archive ZIP into a profile.
- `deploy` - deploy a profile to the game folder.
- `restore` - restore the game folder to vanilla.

## Run

```
pnpm install
pnpm build
./run-mcp.sh
```

Register in OpenCode (`opencode.json`):

```
"amethyst": {
  "type": "local",
  "command": ["/home/savagecore/Git/amethyst-mcp/run-mcp.sh"],
  "cwd": "/home/savagecore/Git/amethyst-mcp",
  "enabled": true,
  "timeout": 300000
}
```

Then `opencode reload` to connect.

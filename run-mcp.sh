#!/usr/bin/env bash
# Launcher for the amethyst-mcp server used by OpenCode.
#
# No secrets are needed: Nexus OAuth and all manager state live in Amethyst's
# own config directory. AMETHYST_CLI optionally points at a non-Flatpak
# backend (native package, AppImage, or source checkout cli.py).
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec node "$here/dist/index.js"

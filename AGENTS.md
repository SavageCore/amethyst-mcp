# AGENTS.md

## Build

- `pnpm install`, `pnpm build` (`tsc`, output `dist/`). Run with
  `./run-mcp.sh` (execs `node dist/index.js`).
- Branch `main`. Unreleased version stays `0.0.0`.

## Backend

- Amethyst headless API reference: `/home/savagecore/Git/Amethyst-Mod-Manager/docs/headless.md`
  (do not copy it here; read the sections needed).
- Backend command defaults to the Flatpak; `AMETHYST_CLI` overrides the
  binary for native/AppImage/source backends.
- Only one job runs per headless process. The client serializes `*.start`
  calls behind the active job; sync reads are unaffected.
- The headless backend runs in a Flatpak sandbox with a private `/tmp`:
  `install_mod` auto-stages archives under `/tmp`, `/var/tmp`,
  `/dev/shm` or `/run` to `~/.cache/amethyst-mcp/staging/` first,
  since the backend cannot see the host tmpfs (`archive_not_found`).
- `waiting_for_input` job snapshots are returned, never blocked on: answer
  through `installers.requests.*` via the `call` tool.
- tsc 6.0.3 chokes on `return f(await g(...))` spanning lines
  (TS1005 at the inner close); bind the awaited value to a const first.

## Smoke test

- `pnpm smoke` runs read-only checks (handshake, games, NMS profiles)
  against the real backend. First Flatpak spawn can take up to a minute.

## Muse Companion for Muse Web — v0.1.2

A UX and relay-reliability update for VS Code and Antigravity IDE.

### What's new

- **Instant answer delivery (`fs.watch`)** — the panel now watches `outbox/` with OS filesystem events in addition to interval polling, so Muse's answers appear in the panel the instant they arrive.
- **Live queue banner & elapsed timer** — displays a pulsing `Waiting for Muse (N in queue)… MM:SS` indicator above the composer while relay requests are in flight.
- **One-click Copy button on Muse answers** — every Muse reply bubble now includes a `Copy` button in the header with instant `Copied!` feedback.
- **Clean MCP bridge isolation** — `scanOutbox()` ignores `res-mcp-*.json` responses so the panel never consumes or archives tool responses meant for coding agents using `muse-relay-mcp`.
- **Atomic file writes & partial-write safety** — `req-<id>.json` (now explicitly tagged with `"source": "panel"`) and `control.json` are written atomically via temporary files so the SSH polling hook never sees a half-written request, and in-flight SSH answer files are not prematurely consumed.
- **UX & command polish** — clicking the `$(sparkle) Muse` Status Bar item now opens the Muse Chat Panel directly (and shows `Muse (Paused)` when paused); running `Muse: Relay Settings` automatically opens the Settings drawer; accidental empty relay messages are prevented; `Clear` preserves in-flight pending tickets; all command prompts and notifications follow the English/Indonesian UI language setting; added `museCompanion.relayDir` and `MUSE_RELAY_DIR` support.

### Install

Download `muse-web-companion-0.1.2.vsix` below, then in VS Code or Antigravity IDE: Extensions view → `...` menu → **Install from VSIX...** — or run:

```bash
code --install-extension muse-web-companion-0.1.2.vsix
# or for Antigravity IDE:
antigravity-ide --install-extension muse-web-companion-0.1.2.vsix
```

Reload the window after installing to activate v0.1.2.

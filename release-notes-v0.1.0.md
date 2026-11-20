First public release of **Muse Companion for Muse Web** — a VS Code companion extension for your personal Muse at muse.ai.

## Install

1. Download `muse-web-companion-0.1.0.vsix` from the assets below.
2. Install it: in VS Code, open the Extensions view → `...` menu → **Install from VSIX...** → pick the file (or run `code --install-extension muse-web-companion-0.1.0.vsix`).
3. Reload the VS Code window (`Developer: Reload Window` from the Command Palette).
4. Open the chat panel: click the **Muse** icon in the Activity Bar, or press `Ctrl+Shift+P` and run `Muse: Open the Muse Chat Panel`.

Context and Tunnel modes work immediately. For answers inside the panel, set up the one-time relay — see the README's Quick Start for difficulty labels and the shortest path.

## What's in 0.1.0

- Chat panel with Relay / Context / Tunnel modes and local history
- Async file relay with pause/resume and held-message flushing
- In-panel Settings with automatic Muse-side application via `control.json` / `applied.json`
- Watchdog re-wake for stranded requests (15 min, max 2 retries)
- Bilingual UI (English default, Bahasa Indonesia); all command titles in English
- 11 commands with editor/Explorer context menus and keybindings
- Optional MCP bridge (`ask_muse`, `ask_muse_start`, `ask_muse_check`) for other agents — separate project: [muse-relay-mcp](https://github.com/99apps-id/muse-relay-mcp)

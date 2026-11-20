## Muse Companion for Muse Web — v0.1.4

A small sync-and-hardening update for VS Code and Antigravity IDE.

### What's new

- **Pause state stays in sync with `control.json`** — the status bar (`Muse (Paused)`) and the open Chat panel now follow changes made outside the panel: the `/muse-pause`, `/muse-resume` and `/muse-status` slash commands of `muse-relay-mcp`, the Muse-side hook, or another editor window. Previously the panel only re-read the file when it was opened or when you changed a setting, so it could keep showing "Relay active" after the relay was paused elsewhere.
- **Content-Security-Policy for the Chat panel** — the webview now ships `default-src 'none'` and runs only its single inline script, matched by a per-load nonce. The panel loads no external resources, so nothing changes visually; this is defence in depth on top of the existing `textContent` rendering.

### Install

Download `muse-web-companion-0.1.4.vsix` below, then in VS Code or Antigravity IDE: Extensions view → `...` menu → **Install from VSIX...** — or run:

```bash
code --install-extension muse-web-companion-0.1.4.vsix --force
# or for Antigravity IDE:
antigravity-ide --install-extension muse-web-companion-0.1.4.vsix --force
```

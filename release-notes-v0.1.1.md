## Muse Companion for Muse Web — v0.1.1

A small polish release: the panel now explains its own context attachments.

### What's new

- **Attachment tooltips** — hovering **Active file**, **Text selection**, **Workspace structure**, or **Git diff** (in the composer and in Settings → Default attachments) shows a plain-language explanation of exactly what will be sent to Muse. Tooltips follow the UI language (English / Bahasa Indonesia).
- **README glossary** — a new "Context attachments, explained" table in the Usage section.
- **README header** — a cozy Muse office animation above a centered title and badges; badges are written as HTML so they always render on GitHub.
- `package.json` now carries the `repository` field (fixes vsce packaging with images in the README).

### Install

Download `muse-web-companion-0.1.1.vsix` below, then in VS Code: Extensions view → `...` menu → **Install from VSIX...** — or run:

```bash
code --install-extension muse-web-companion-0.1.1.vsix
```

Reload the VS Code window after installing to activate v0.1.1.

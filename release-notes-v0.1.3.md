## Muse Companion for Muse Web — v0.1.3

Approval mode: a human-in-the-loop gate for requests from coding agents.

### What's new

- **Approval mode for agent requests** — new relay setting *Require approval for agent requests* (mirrored to `control.json` as `requireApproval`). While on, questions from coding agents via [muse-relay-mcp](https://github.com/99apps-id/muse-relay-mcp) wait in a new `pending/` folder and appear in the panel as approval cards (**Approve / Reject**, with a notification when one arrives).
  - Approving moves the request into the inbox.
  - Rejecting returns a `DECLINED` answer to the agent.
  - Requests left unapproved for 30 minutes expire with an `EXPIRED` answer.
  - Panel-originated messages are never gated.

Works with `muse-relay-mcp` v0.1.2 or later.

### Install

Download `muse-web-companion-0.1.3.vsix` below, then in VS Code or Antigravity IDE: Extensions view → `...` menu → **Install from VSIX...** — or run:

```bash
code --install-extension muse-web-companion-0.1.3.vsix --force
# or for Antigravity IDE:
antigravity-ide --install-extension muse-web-companion-0.1.3.vsix --force
```

A newer release (v0.1.4) is available; this page preserves v0.1.3 for reference.

// Muse Companion for Muse Web — custom local extension, not affiliated with Meta.
// It does NOT embed muse.ai (embedding is not allowed) and it does NOT use a
// Muse personal API (none exists). It works in three honest ways:
//  1. Opens https://muse.ai in your real browser.
//  2. Copies rich context (file, selection, workspace tree, git diff,
//     diagnostics) to the clipboard, ready to paste into the Muse chat.
//  3. Async relay: the panel writes requests into ~/muse-relay/inbox on this
//     machine; the user's Muse agent polls that folder over an SSH/Tailscale
//     tunnel, answers into ~/muse-relay/outbox, and the panel renders them.
//
// Settings (v0.5.0): the panel has a Settings section. Panel-local settings
// apply instantly. Muse-side relay settings (hook poll interval, max
// requests per wake) are written to ~/muse-relay/control.json; Muse's
// poller detects the change on its next cycle and a Muse worker applies it
// automatically (no manual chat on muse.ai needed), then writes
// ~/muse-relay/applied.json back so the panel can show the applied state.

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function cfg() {
  return vscode.workspace.getConfiguration('museCompanion');
}

function museUrl() {
  return cfg().get('museUrl') || 'https://muse.ai';
}

function openMuse() {
  return vscode.env.openExternal(vscode.Uri.parse(museUrl()));
}

function truncate(text, label) {
  const max = Number(cfg().get('maxChars')) || 100000;
  if (text.length <= max) return text;
  return (
    text.slice(0, max) +
    `\n\n[... ${label} dipotong oleh Muse Companion: ${text.length - max} karakter sisanya tidak disalin. Naikkan museCompanion.maxChars di Settings bila perlu.]`
  );
}

async function copyAndOpen(text, message) {
  await vscode.env.clipboard.writeText(text);
  vscode.window.showInformationMessage(message);
  if (cfg().get('openAfterCopy')) {
    await openMuse();
  }
}

function langOf(doc) {
  return (doc && doc.languageId) || '';
}

function fenced(doc, content) {
  return '```' + langOf(doc) + '\n' + content + '\n```';
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : undefined;
}

function activeDoc() {
  const ed = vscode.window.activeTextEditor;
  return ed ? ed.document : undefined;
}

// --- Async relay via ~/muse-relay (inbox/outbox on this machine) ---
function relayRoot() {
  return path.join(os.homedir(), 'muse-relay');
}

function relayDirs() {
  const root = relayRoot();
  for (const d of ['inbox', 'outbox', 'archive']) {
    try { fs.mkdirSync(path.join(root, d), { recursive: true }); } catch {}
  }
  return root;
}

function newRequestId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// --- Relay settings ---
const ALLOWED_HOOK_POLL = [5, 10, 20, 30, 60, 120];
const ALLOWED_OUTBOX_POLL = [2, 4, 8, 15];
const ALLOWED_MAX_PER_WAKE = [1, 3, 5];
const ALLOWED_WARN_MINS = [1, 3, 5, 10, 0]; // 0 = off
const ALLOWED_RETENTION_DAYS = [7, 30, 90, 0]; // 0 = keep forever

const DEFAULT_SETTINGS = {
  uiLanguage: 'en',      // panel UI language ('en' default | 'id'); answer language is separate
  hookPollSecs: 5,       // Muse-side: relay hook poll interval (via control.json)
  maxPerWake: 3,         // Muse-side: max requests a worker answers per wake
  answerLanguage: 'id',  // Muse-side: language of relay answers ('id' | 'en')
  outboxPollSecs: 4,     // panel-local: how often the panel checks for answers
  notifyOnAnswer: true, // panel-local: VS Code notification when an answer arrives
  warnAfterMins: 3,      // panel-local: warn in chat when a request waits longer (0 = off)
  archiveRetentionDays: 30, // panel-local: prune archive files older than this (0 = forever)
  defaultAttach: { file: true, selection: false, tree: false, diff: false }
};

function pickAllowed(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function sanitizeSettings(raw) {
  const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
  s.uiLanguage = s.uiLanguage === 'id' ? 'id' : 'en';
  s.hookPollSecs = pickAllowed(Number(s.hookPollSecs), ALLOWED_HOOK_POLL, DEFAULT_SETTINGS.hookPollSecs);
  s.maxPerWake = pickAllowed(Number(s.maxPerWake), ALLOWED_MAX_PER_WAKE, DEFAULT_SETTINGS.maxPerWake);
  s.answerLanguage = s.answerLanguage === 'en' ? 'en' : 'id';
  s.outboxPollSecs = pickAllowed(Number(s.outboxPollSecs), ALLOWED_OUTBOX_POLL, DEFAULT_SETTINGS.outboxPollSecs);
  s.notifyOnAnswer = s.notifyOnAnswer !== false;
  s.warnAfterMins = pickAllowed(Number(s.warnAfterMins), ALLOWED_WARN_MINS, DEFAULT_SETTINGS.warnAfterMins);
  s.archiveRetentionDays = pickAllowed(Number(s.archiveRetentionDays), ALLOWED_RETENTION_DAYS, DEFAULT_SETTINGS.archiveRetentionDays);
  const da = Object.assign({}, DEFAULT_SETTINGS.defaultAttach, (raw && raw.defaultAttach) || {});
  s.defaultAttach = { file: !!da.file, selection: !!da.selection, tree: !!da.tree, diff: !!da.diff };
  return s;
}

// control.json is the shared control file between this panel and Muse's
// poller: {paused, desiredPollSecs, maxPerWake, updatedAt}. Writes always
// merge so the pause flag and the settings never clobber each other.
function relayControlPath() {
  return path.join(relayRoot(), 'control.json');
}

function readRelayControl() {
  try {
    const data = JSON.parse(fs.readFileSync(relayControlPath(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeRelayControl(patch) {
  relayDirs();
  const next = Object.assign({}, readRelayControl(), patch, { updatedAt: new Date().toISOString() });
  fs.writeFileSync(relayControlPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function readRelayPaused() {
  return readRelayControl().paused === true;
}

function writeRelayPaused(paused) {
  writeRelayControl({ paused: !!paused });
}

// applied.json is written by Muse (the worker that applied a settings
// change) so the panel can show what is actually in effect Muse-side.
function readRelayApplied() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(relayRoot(), 'applied.json'), 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function pruneArchive(retentionDays) {
  if (!retentionDays || retentionDays <= 0) return;
  try {
    const dir = path.join(relayDirs(), 'archive');
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(dir)) {
      try {
        const p = path.join(dir, f);
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
}

function register(context) {
  const sub = (d) => context.subscriptions.push(d);

  // Settings live in globalState so they survive restarts and are shared by
  // every panel instance; control.json mirrors the Muse-side subset.
  let settings = sanitizeSettings(context.globalState.get('museRelaySettings'));
  // Bilingual host messages (panel notifications): English by default.
  const L = (en, id) => (settings.uiLanguage === 'id' ? id : en);
  const saveSettings = (patch) => {
    settings = sanitizeSettings(Object.assign({}, settings, patch));
    context.globalState.update('museRelaySettings', settings);
    try {
      writeRelayControl({ desiredPollSecs: settings.hookPollSecs, maxPerWake: settings.maxPerWake });
    } catch {}
    return settings;
  };
  // Make sure control.json reflects the stored Muse-side settings from the
  // start, and prune the archive per the retention setting.
  try { writeRelayControl({ desiredPollSecs: settings.hookPollSecs, maxPerWake: settings.maxPerWake }); } catch {}
  pruneArchive(settings.archiveRetentionDays);

  // Status bar button
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  status.text = '$(sparkle) Muse';
  status.tooltip = 'Buka Muse web (muse.ai)';
  status.command = 'museCompanion.openMuse';
  status.show();
  sub(status);

  sub(vscode.commands.registerCommand('museCompanion.openMuse', async () => {
    await openMuse();
  }));

  // --- Tunnel commands: the bridge to the user's real Muse agent ---
  sub(vscode.commands.registerCommand('museCompanion.askTunnelReadFile', async (uri) => {
    let filePath;
    if (uri && uri.fsPath) {
      filePath = uri.fsPath;
    } else {
      const doc = activeDoc();
      if (!doc) {
        vscode.window.showWarningMessage('Muse Companion: tidak ada file aktif.');
        return;
      }
      filePath = doc.fileName;
    }
    const question = await vscode.window.showInputBox({
      prompt: 'Mau Muse apakan dengan file ini? (kosongkan untuk: baca & jelaskan)',
      placeHolder: 'Contoh: audit file ini, cari bug di fungsi login'
    });
    if (question === undefined) return; // cancelled
    const ask = question.trim() || 'baca file ini dan jelaskan isinya, lalu tunjukkan masalah atau perbaikan yang kamu temukan';
    const text =
      `Hai Muse, ${ask}.\n` +
      `File-nya ada di laptop saya, baca langsung lewat tunnel dari path ini:\n` +
      `${filePath}`;
    await copyAndOpen(text, 'Muse Companion: permintaan tunnel tersalin. Tempel (Ctrl+V) di chat Muse, lalu Enter.');
  }));

  sub(vscode.commands.registerCommand('museCompanion.askTunnelReadWorkspace', async () => {
    const root = workspaceRoot();
    if (!root) {
      vscode.window.showWarningMessage('Muse Companion: tidak ada workspace terbuka.');
      return;
    }
    const question = await vscode.window.showInputBox({
      prompt: 'Mau Muse apakan dengan workspace ini? (kosongkan untuk: jelajahi & rangkum)',
      placeHolder: 'Contoh: audit mendalam folder crates/odon-channel, terutama telegram'
    });
    if (question === undefined) return;
    const ask = question.trim() || 'jelajahi workspace ini dan rangkum struktur serta keadaan proyeknya';
    const text =
      `Hai Muse, ${ask}.\n` +
      `Workspace-nya ada di laptop saya, kerjakan langsung lewat tunnel dari folder ini:\n` +
      `${root}`;
    await copyAndOpen(text, 'Muse Companion: permintaan tunnel workspace tersalin. Tempel di chat Muse, lalu Enter.');
  }));

  // --- Clipboard context commands ---
  sub(vscode.commands.registerCommand('museCompanion.sendFile', async () => {
    const doc = activeDoc();
    if (!doc) {
      vscode.window.showWarningMessage('Muse Companion: tidak ada file aktif.');
      return;
    }
    const content = truncate(doc.getText(), 'isi file');
    const text =
      `Hai Muse, ini file dari VS Code saya:\n\n` +
      `Path: ${doc.fileName}\n\n` +
      fenced(doc, content);
    await copyAndOpen(text, 'Muse Companion: file aktif tersalin. Tempel di chat Muse.');
  }));

  sub(vscode.commands.registerCommand('museCompanion.askAboutFile', async () => {
    const doc = activeDoc();
    if (!doc) {
      vscode.window.showWarningMessage('Muse Companion: tidak ada file aktif.');
      return;
    }
    const question = await vscode.window.showInputBox({
      prompt: 'Pertanyaanmu tentang file ini?',
      placeHolder: 'Contoh: kenapa fungsi ini lambat?'
    });
    if (!question) return;
    const content = truncate(doc.getText(), 'isi file');
    const text =
      `Hai Muse, ${question}\n\n` +
      `File: ${doc.fileName}\n\n` +
      fenced(doc, content);
    await copyAndOpen(text, 'Muse Companion: pertanyaan + file tersalin. Tempel di chat Muse.');
  }));

  sub(vscode.commands.registerCommand('museCompanion.sendSelection', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.selection.isEmpty) {
      vscode.window.showWarningMessage('Muse Companion: belum ada teks yang diseleksi.');
      return;
    }
    const sel = ed.document.getText(ed.selection);
    const start = ed.selection.start.line + 1;
    const end = ed.selection.end.line + 1;
    const text =
      `Hai Muse, ini potongan kode dari VS Code saya:\n\n` +
      `File: ${ed.document.fileName} (baris ${start}-${end})\n\n` +
      fenced(ed.document, truncate(sel, 'seleksi'));
    await copyAndOpen(text, 'Muse Companion: seleksi tersalin. Tempel di chat Muse.');
  }));

  const buildTree = (root) => {
    const ignore = new Set(['.git', 'node_modules', 'target', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'vendor']);
    const lines = [];
    const walk = (dir, prefix, depth) => {
      if (depth > 6 || lines.length > 2000) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (ignore.has(e.name)) continue;
        lines.push(prefix + e.name + (e.isDirectory() ? '/' : ''));
        if (e.isDirectory()) walk(path.join(dir, e.name), prefix + '  ', depth + 1);
        if (lines.length > 2000) return;
      }
    };
    walk(root, '', 0);
    return lines.join('\n');
  };

  sub(vscode.commands.registerCommand('museCompanion.sendWorkspaceTree', async () => {
    const root = workspaceRoot();
    if (!root) {
      vscode.window.showWarningMessage('Muse Companion: tidak ada workspace terbuka.');
      return;
    }
    const text =
      `Hai Muse, ini struktur workspace VS Code saya:\n\n` +
      `Root: ${root}\n\n` +
      '```\n' + truncate(buildTree(root), 'struktur workspace') + '\n```';
    await copyAndOpen(text, 'Muse Companion: struktur workspace tersalin. Tempel di chat Muse.');
  }));

  const gitRun = (root, args) => new Promise((resolve) => {
    cp.execFile('git', args, { cwd: root, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });

  sub(vscode.commands.registerCommand('museCompanion.sendGitDiff', async () => {
    const root = workspaceRoot();
    if (!root) {
      vscode.window.showWarningMessage('Muse Companion: tidak ada workspace terbuka.');
      return;
    }
    const run = (args) => new Promise((resolve) => {
      cp.execFile('git', args, { cwd: root, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? `(git ${args.join(' ')} gagal: ${err.message})` : stdout);
      });
    });
    const status = await run(['status', '--short', '--branch']);
    const diff = await run(['diff', 'HEAD', '--stat']);
    const diffBody = await run(['diff', 'HEAD']);
    const text =
      `Hai Muse, ini keadaan git workspace saya:\n\n` +
      `Root: ${root}\n\n` +
      'Status:\n```\n' + status + '```\n\n' +
      'Diff stat:\n```\n' + diff + '```\n\n' +
      'Diff:\n```diff\n' + truncate(diffBody, 'git diff') + '\n```';
    await copyAndOpen(text, 'Muse Companion: git status + diff tersalin. Tempel di chat Muse.');
  }));

  sub(vscode.commands.registerCommand('museCompanion.sendDiagnostics', async () => {
    const diags = vscode.languages.getDiagnostics();
    const lines = [];
    for (const [uri, list] of diags) {
      for (const d of list) {
        const sev = ['Error', 'Warning', 'Info', 'Hint'][d.severity] || 'Info';
        lines.push(`${sev} ${uri.fsPath}:${d.range.start.line + 1}:${d.range.start.character + 1} — ${d.message}${d.source ? ` (${d.source})` : ''}`);
      }
    }
    if (!lines.length) {
      vscode.window.showInformationMessage('Muse Companion: tidak ada Problems/diagnostics saat ini.');
      return;
    }
    const text =
      `Hai Muse, ini Problems/diagnostics dari VS Code saya — bantu jelaskan dan perbaiki:\n\n` +
      '```\n' + truncate(lines.join('\n'), 'diagnostics') + '\n```';
    await copyAndOpen(text, `Muse Companion: ${lines.length} diagnostics tersalin. Tempel di chat Muse.`);
  }));

  // --- Sidebar chat panel (WebviewView) ---
  const chatProvider = {
    resolveWebviewView(webviewView) {
      webviewView.webview.options = { enableScripts: true };
      webviewView.webview.html = chatHtml();

      let pollTimer = null;
      const scanOutbox = () => {
        let arrived = 0;
        try {
          const outDir = path.join(relayDirs(), 'outbox');
          for (const f of fs.readdirSync(outDir)) {
            if (!/^res-.*\.json$/.test(f)) continue;
            try {
              const data = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
              webviewView.webview.postMessage({ type: 'relayAnswer', id: data.id, answer: data.answer || L('(empty answer from Muse)', '(jawaban kosong dari Muse)') });
              try { fs.renameSync(path.join(outDir, f), path.join(relayRoot(), 'archive', f)); } catch {}
              arrived++;
            } catch {}
          }
        } catch {}
        if (arrived > 0 && settings.notifyOnAnswer) {
          vscode.window.showInformationMessage(L('Muse Relay: a new answer has arrived in the Muse panel.', 'Muse Relay: jawaban baru diterima di panel Muse.'));
        }
      };
      const restartPollTimer = () => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(scanOutbox, settings.outboxPollSecs * 1000);
      };
      scanOutbox();
      restartPollTimer();
      webviewView.onDidDispose(() => { if (pollTimer) clearInterval(pollTimer); });

      const postRelayState = () => {
        webviewView.webview.postMessage({ type: 'relayState', paused: readRelayPaused() });
      };
      const postSettings = () => {
        webviewView.webview.postMessage({ type: 'settings', settings, applied: readRelayApplied() });
      };
      postRelayState();

      webviewView.webview.onDidReceiveMessage(async (msg) => {
        if (!msg) return;
        if (msg.type === 'openMuse') {
          await openMuse();
          return;
        }
        if (msg.type === 'getRelayState') {
          postRelayState();
          return;
        }
        if (msg.type === 'getSettings') {
          postSettings();
          return;
        }
        if (msg.type === 'updateSettings') {
          try {
            const before = settings;
            saveSettings(msg.settings || {});
            if (before.outboxPollSecs !== settings.outboxPollSecs) restartPollTimer();
            if (before.archiveRetentionDays !== settings.archiveRetentionDays) pruneArchive(settings.archiveRetentionDays);
            postSettings();
          } catch (e) {
            vscode.window.showErrorMessage(L('Muse Companion: failed to save settings — ', 'Muse Companion: gagal menyimpan pengaturan — ') + e.message);
          }
          return;
        }
        if (msg.type === 'togglePause') {
          try {
            writeRelayPaused(!!msg.paused);
            postRelayState();
            vscode.window.showInformationMessage(
              msg.paused
                ? L('Muse Relay: paused. Requests in the inbox will not be processed and new messages are held in the panel.', 'Muse Relay: di-pause. Request di inbox tidak akan diproses dan pesan baru ditahan di panel.')
                : L('Muse Relay: resumed. Held messages will be sent.', 'Muse Relay: dilanjutkan. Pesan yang ditahan akan dikirim.')
            );
          } catch (e) {
            vscode.window.showErrorMessage(L('Muse Relay: failed to change the pause state — ', 'Muse Relay: gagal mengubah status pause — ') + e.message);
          }
          return;
        }
        if (msg.type !== 'send') return;
        const prompt = (msg.text || '').trim();
        if (msg.mode === 'relay') {
          if (readRelayPaused()) {
            postRelayState();
            webviewView.webview.postMessage({ type: 'heldByHost', text: prompt });
            return;
          }
          const attach = msg.attach || {};
          const req = {
            id: newRequestId(),
            createdAt: new Date().toISOString(),
            prompt: prompt,
            answerLanguage: settings.answerLanguage,
            workspaceRoot: workspaceRoot() || null,
            activeFile: null,
            contextFile: null,
            selection: null,
            tree: null,
            diff: null
          };
          const doc = activeDoc();
          if (doc) req.activeFile = doc.fileName;
          if (attach.file && doc) {
            req.contextFile = { path: doc.fileName, content: truncate(doc.getText(), 'isi file') };
          }
          if (attach.selection) {
            const ed = vscode.window.activeTextEditor;
            if (ed && !ed.selection.isEmpty) {
              req.selection = { path: ed.document.fileName, startLine: ed.selection.start.line + 1, endLine: ed.selection.end.line + 1, content: truncate(ed.document.getText(ed.selection), 'seleksi') };
            }
          }
          if (attach.tree && req.workspaceRoot) {
            req.tree = truncate(buildTree(req.workspaceRoot), 'struktur workspace');
          }
          if (attach.diff && req.workspaceRoot) {
            const diffBody = await gitRun(req.workspaceRoot, ['diff', 'HEAD']);
            req.diff = diffBody === null ? null : truncate(diffBody, 'git diff');
          }
          try {
            const inbox = path.join(relayDirs(), 'inbox');
            fs.writeFileSync(path.join(inbox, `req-${req.id}.json`), JSON.stringify(req, null, 2), 'utf8');
            webviewView.webview.postMessage({ type: 'queued', text: prompt, id: req.id });
            vscode.window.showInformationMessage(L('Muse Relay: message queued in the inbox. Muse checks every ' + settings.hookPollSecs + ' seconds; answer time depends on the task.', 'Muse Relay: pesan masuk inbox. Muse mengambilnya tiap ' + settings.hookPollSecs + ' detik; waktu jawaban tergantung kerumitan tugas.'));
          } catch (e) {
            vscode.window.showErrorMessage(L('Muse Relay: failed to write to the inbox — ', 'Muse Relay: gagal menulis inbox — ') + e.message);
          }
          return;
        }
        const parts = [];
        if (msg.mode === 'tunnel') {
          const root = workspaceRoot();
          const doc = activeDoc();
          parts.push(`Hai Muse, ${prompt || 'kerjakan ini'}.`);
          parts.push('Kerjakan langsung di laptop saya lewat tunnel:');
          if (doc) parts.push(`File aktif: ${doc.fileName}`);
          if (root) parts.push(`Workspace: ${root}`);
        } else {
          parts.push(`Hai Muse, ${prompt || 'tolong lihat konteks ini'}.`);
          const attach = msg.attach || {};
          if (attach.file) {
            const doc = activeDoc();
            if (doc) parts.push(`\nFile aktif: ${doc.fileName}\n` + fenced(doc, truncate(doc.getText(), 'isi file')));
            else parts.push('\n(Tidak ada file aktif untuk dilampirkan.)');
          }
          if (attach.selection) {
            const ed = vscode.window.activeTextEditor;
            if (ed && !ed.selection.isEmpty) {
              parts.push(`\nSeleksi dari ${ed.document.fileName} baris ${ed.selection.start.line + 1}-${ed.selection.end.line + 1}:\n` + fenced(ed.document, truncate(ed.document.getText(ed.selection), 'seleksi')));
            } else {
              parts.push('\n(Tidak ada seleksi teks saat ini.)');
            }
          }
          if (attach.tree) {
            const root = workspaceRoot();
            if (root) {
              parts.push(`\nStruktur workspace (${root}):\n` + '```\n' + truncate(buildTree(root), 'struktur workspace') + '\n```');
            }
          }
          if (attach.diff) {
            const root = workspaceRoot();
            if (root) {
              const diffBody = await gitRun(root, ['diff', 'HEAD']);
              if (diffBody) parts.push('\nGit diff:\n```diff\n' + truncate(diffBody, 'git diff') + '\n```');
            }
          }
        }
        const composed = parts.join('\n');
        await vscode.env.clipboard.writeText(composed);
        webviewView.webview.postMessage({ type: 'sent', text: prompt, mode: msg.mode });
        vscode.window.showInformationMessage(L('Muse Chat: message copied. Paste it (Ctrl+V) into the open muse.ai chat and press Enter.', 'Muse Chat: pesan tersalin. Tempel (Ctrl+V) di muse.ai yang sudah dibuka, lalu Enter.'));
        if (cfg().get('openAfterCopy')) await openMuse();
      });
    }
  };
  sub(vscode.window.registerWebviewViewProvider('museCompanion.chatView', chatProvider, { webviewOptions: { retainContextWhenHidden: true } }));

  sub(vscode.commands.registerCommand('museCompanion.openChat', async () => {
    await vscode.commands.executeCommand('museCompanion.chatView.focus');
  }));

  sub(vscode.commands.registerCommand('museCompanion.openSettings', async () => {
    await vscode.commands.executeCommand('museCompanion.chatView.focus');
  }));
}

function chatHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0; margin: 0; display: flex; flex-direction: column; height: 100vh; background: var(--vscode-sideBar-background); }
  .topbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
  .topbar .title { font-weight: 600; font-size: 12px; letter-spacing: 0.02em; }
  .status { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); padding: 2px 8px; border-radius: 999px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-testing-iconPassed, #3fb68b); display: inline-block; }
  .dot.paused { background: var(--vscode-editorWarning-foreground, #d7a21a); }
  .spacer { flex: 1; }
  .linkbtn { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 12px; padding: 4px 6px; font-family: inherit; }
  .linkbtn:hover { text-decoration: underline; }
  #settings { display: none; border-bottom: 1px solid var(--vscode-panel-border); padding: 10px 12px 12px; background: var(--vscode-editor-background); overflow-y: auto; max-height: 55vh; }
  #settings.open { display: block; }
  .group { margin-bottom: 14px; }
  .group:last-child { margin-bottom: 4px; }
  .group-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
  .field { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 0; }
  .field label { flex: 1; font-size: 12px; }
  .field .hint { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 1px; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 4px; padding: 3px 6px; font-family: inherit; font-size: 12px; min-width: 118px; }
  input[type="checkbox"] { accent-color: var(--vscode-focusBorder); width: 14px; height: 14px; margin: 0; }
  .applied { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 2px 0 0; }
  .saved { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: right; min-height: 14px; }
  #history { flex: 1; overflow-y: auto; padding: 10px 12px; }
  .msg { margin-bottom: 8px; padding: 7px 9px; border-radius: 4px; white-space: pre-wrap; word-wrap: break-word; line-height: 1.45; }
  .user { background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); }
  .muse { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-left: 3px solid var(--vscode-focusBorder); }
  .who { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
  .sys { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 2px 0; margin-bottom: 6px; }
  .composer { border-top: 1px solid var(--vscode-panel-border); padding: 10px 12px; background: var(--vscode-sideBar-background); }
  .modes { display: flex; border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; margin-bottom: 8px; }
  .modes label { flex: 1; text-align: center; font-size: 11px; padding: 5px 2px; cursor: pointer; color: var(--vscode-descriptionForeground); border-right: 1px solid var(--vscode-panel-border); }
  .modes label:last-child { border-right: none; }
  .modes input { display: none; }
  .modes label.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-bottom: 8px; font-size: 12px; }
  .chips label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
  textarea { width: 100%; min-height: 60px; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; padding: 7px 8px; font-family: inherit; font-size: var(--vscode-font-size); }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .row { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
  button.primary { flex: 1; padding: 6px 10px; border: none; border-radius: 4px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-family: inherit; font-size: 12px; }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { padding: 6px 10px; border: none; border-radius: 4px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); font-family: inherit; font-size: 12px; }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
  <div class="topbar">
    <span class="title">Muse</span>
    <span class="status"><span class="dot" id="statusDot"></span><span id="statusText">Relay active</span></span>
    <span class="spacer"></span>
    <button class="linkbtn" id="settingsBtn" data-i18n="settings">Settings</button>
  </div>

  <div id="settings">
    <div class="group">
      <div class="group-title" data-i18n="generalGroup">General</div>
      <div class="field">
        <label data-i18n="uiLanguage">UI language</label>
        <select id="s-uiLang">
          <option value="en">English</option>
          <option value="id">Bahasa Indonesia</option>
        </select>
      </div>
    </div>

    <div class="group">
      <div class="group-title" data-i18n="relayGroup">Muse relay</div>
      <div class="field">
        <label><span data-i18n="hookPoll">Hook polling interval</span><span class="hint" data-i18n="hookPollHint">How often Muse checks the relay inbox on this machine. Applied by Muse automatically from the control file — no need to ask in the muse.ai chat.</span></label>
        <select id="s-hookPoll">
          <option value="5" data-i18n="sec5">5 seconds</option>
          <option value="10" data-i18n="sec10">10 seconds</option>
          <option value="20" data-i18n="sec20">20 seconds</option>
          <option value="30" data-i18n="sec30">30 seconds</option>
          <option value="60" data-i18n="sec60">60 seconds</option>
          <option value="120" data-i18n="sec120">120 seconds</option>
        </select>
      </div>
      <div class="applied" id="appliedLine"></div>
      <div class="field">
        <label><span data-i18n="maxPerWake">Max requests per turn</span><span class="hint" data-i18n="maxPerWakeHint">How many requests Muse answers in a single wake-up.</span></label>
        <select id="s-maxPerWake">
          <option value="1" data-i18n="req1">1 request</option>
          <option value="3" data-i18n="req3">3 requests</option>
          <option value="5" data-i18n="req5">5 requests</option>
        </select>
      </div>
      <div class="field">
        <label data-i18n="answerLanguage">Relay answer language</label>
        <select id="s-language">
          <option value="id">Bahasa Indonesia</option>
          <option value="en">English</option>
        </select>
      </div>
    </div>

    <div class="group">
      <div class="group-title" data-i18n="panelGroup">Panel</div>
      <div class="field">
        <label data-i18n="outboxPoll">Check for answers every</label>
        <select id="s-outboxPoll">
          <option value="2" data-i18n="sec2">2 seconds</option>
          <option value="4" data-i18n="sec4">4 seconds</option>
          <option value="8" data-i18n="sec8">8 seconds</option>
          <option value="15" data-i18n="sec15">15 seconds</option>
        </select>
      </div>
      <div class="field">
        <label data-i18n="notify">Notify when an answer arrives</label>
        <input type="checkbox" id="s-notify">
      </div>
      <div class="field">
        <label data-i18n="warn">Warn when waiting longer than</label>
        <select id="s-warn">
          <option value="1" data-i18n="min1">1 minute</option>
          <option value="3" data-i18n="min3">3 minutes</option>
          <option value="5" data-i18n="min5">5 minutes</option>
          <option value="10" data-i18n="min10">10 minutes</option>
          <option value="0" data-i18n="off">Off</option>
        </select>
      </div>
      <div class="field">
        <label><span data-i18n="retention">Keep relay archive for</span><span class="hint" data-i18n="retentionHint">Older request/answer files in the archive folder are deleted automatically.</span></label>
        <select id="s-retention">
          <option value="7" data-i18n="day7">7 days</option>
          <option value="30" data-i18n="day30">30 days</option>
          <option value="90" data-i18n="day90">90 days</option>
          <option value="0" data-i18n="forever">Forever</option>
        </select>
      </div>
    </div>

    <div class="group">
      <div class="group-title" data-i18n="attachGroup">Default attachments</div>
      <div class="field"><label data-i18n="attFile" data-i18n-title="attFileTip">Active file</label><input type="checkbox" id="s-att-file"></div>
      <div class="field"><label data-i18n="attSelection" data-i18n-title="attSelectionTip">Text selection</label><input type="checkbox" id="s-att-selection"></div>
      <div class="field"><label data-i18n="attTree" data-i18n-title="attTreeTip">Workspace structure</label><input type="checkbox" id="s-att-tree"></div>
      <div class="field"><label data-i18n="attDiff" data-i18n-title="attDiffTip">Git diff</label><input type="checkbox" id="s-att-diff"></div>
    </div>

    <div class="saved" id="savedLine"></div>
  </div>

  <div id="history"></div>

  <div class="composer">
    <div class="modes" id="modes">
      <label data-mode="relay" class="active"><input type="radio" name="mode" value="relay" checked><span data-i18n="modeRelay">Relay</span></label>
      <label data-mode="context"><input type="radio" name="mode" value="context"><span data-i18n="modeContext">Context</span></label>
      <label data-mode="tunnel"><input type="radio" name="mode" value="tunnel"><span data-i18n="modeTunnel">Tunnel</span></label>
    </div>
    <div class="chips" id="chips">
      <label data-i18n-title="attFileTip"><input type="checkbox" id="a-file" checked> <span data-i18n="attFile">Active file</span></label>
      <label data-i18n-title="attSelectionTip"><input type="checkbox" id="a-selection"> <span data-i18n="attSelection">Text selection</span></label>
      <label data-i18n-title="attTreeTip"><input type="checkbox" id="a-tree"> <span data-i18n="attTree">Workspace structure</span></label>
      <label data-i18n-title="attDiffTip"><input type="checkbox" id="a-diff"> <span data-i18n="attDiff">Git diff</span></label>
    </div>
    <textarea id="input" data-i18n-ph="inputPlaceholder" placeholder="Message Muse… (Ctrl+Enter to send)"></textarea>
    <div class="row">
      <button class="primary" id="send" data-i18n="send">Send to Muse</button>
      <button class="secondary" id="pause">Pause relay</button>
      <button class="secondary" id="open">muse.ai</button>
      <button class="secondary" id="clear" data-i18n="clear">Clear</button>
    </div>
  </div>

<script>
  var STR = {
    en: {
      settings: 'Settings', statusActive: 'Relay active', statusPaused: 'Relay paused',
      pause: 'Pause relay', resume: 'Resume relay',
      generalGroup: 'General', uiLanguage: 'UI language',
      relayGroup: 'Muse relay', hookPoll: 'Hook polling interval',
      hookPollHint: 'How often Muse checks the relay inbox on this machine. Applied by Muse automatically from the control file — no need to ask in the muse.ai chat.',
      maxPerWake: 'Max requests per turn', maxPerWakeHint: 'How many requests Muse answers in a single wake-up.',
      answerLanguage: 'Relay answer language',
      panelGroup: 'Panel', outboxPoll: 'Check for answers every', notify: 'Notify when an answer arrives',
      warn: 'Warn when waiting longer than', retention: 'Keep relay archive for',
      retentionHint: 'Older request/answer files in the archive folder are deleted automatically.',
      attachGroup: 'Default attachments', attFile: 'Active file', attSelection: 'Text selection', attTree: 'Workspace structure', attDiff: 'Git diff',
      attFileTip: 'Sends the whole content of the file currently open in your editor, so Muse can read it before answering.',
      attSelectionTip: 'Sends only the text you have selected (highlighted) in the editor - best for asking about a few specific lines.',
      attTreeTip: 'Sends the folder and file names of your project - a map of the project, without any file contents.',
      attDiffTip: 'Sends your uncommitted changes: the lines added, edited, or removed since your last commit. Great for code review.',
      sec2: '2 seconds', sec4: '4 seconds', sec5: '5 seconds', sec8: '8 seconds', sec10: '10 seconds', sec15: '15 seconds', sec20: '20 seconds', sec30: '30 seconds', sec60: '60 seconds', sec120: '120 seconds',
      req1: '1 request', req3: '3 requests', req5: '5 requests',
      min1: '1 minute', min3: '3 minutes', min5: '5 minutes', min10: '10 minutes', off: 'Off',
      day7: '7 days', day30: '30 days', day90: '90 days', forever: 'Forever',
      modeRelay: 'Relay', modeContext: 'Context', modeTunnel: 'Tunnel',
      inputPlaceholder: 'Message Muse… (Ctrl+Enter to send)', send: 'Send to Muse', clear: 'Clear',
      you: 'You', emptyHistory: 'No messages yet. Write a message below, choose its context attachments, then Send to Muse.',
      copiedNote: 'Copied to the clipboard and muse.ai opened — paste (Ctrl+V) there to send it.',
      queuedNote: 'Queued in the relay inbox — Muse\u2019s answer will appear here.',
      noText: '(no text — context only)',
      heldPanel: 'Held (relay paused): "{text}" — it will be sent when the relay resumes.',
      heldHost: 'The relay is paused — the message "{text}" was not written to the inbox. Resume the relay and send it again.',
      warnWait: 'Request "{label}" has been waiting for more than {mins} minutes. Muse may be working on a long task, or the relay may be stopped — check the relay status at the top of the panel.',
      saved: 'Saved ',
      appliedSame: 'Applied by Muse: {n} seconds (since {t})',
      appliedDiff: 'Requested: {req} seconds — applied by Muse: {n} seconds. Changes are applied automatically on the next polling cycle.',
      appliedPending: 'Requested: {req} seconds. No application confirmation from Muse yet — changes are applied automatically on the next polling cycle.'
    },
    id: {
      settings: 'Pengaturan', statusActive: 'Relay aktif', statusPaused: 'Relay di-pause',
      pause: 'Pause relay', resume: 'Lanjutkan relay',
      generalGroup: 'Umum', uiLanguage: 'Bahasa antarmuka',
      relayGroup: 'Relay Muse', hookPoll: 'Interval polling hook',
      hookPollHint: 'Seberapa sering Muse memeriksa inbox relay di laptop ini. Diterapkan Muse secara otomatis dari file kontrol — tidak perlu meminta lewat chat muse.ai.',
      maxPerWake: 'Maks. request per giliran', maxPerWakeHint: 'Berapa request yang dijawab Muse dalam satu kali bangun.',
      answerLanguage: 'Bahasa jawaban relay',
      panelGroup: 'Panel', outboxPoll: 'Cek jawaban setiap', notify: 'Notifikasi saat jawaban tiba',
      warn: 'Peringatan bila menunggu lebih dari', retention: 'Simpan arsip relay selama',
      retentionHint: 'File request/jawaban lama di folder archive dihapus otomatis setelah batas ini.',
      attachGroup: 'Lampiran bawaan', attFile: 'File aktif', attSelection: 'Seleksi teks', attTree: 'Struktur workspace', attDiff: 'Git diff',
      attFileTip: 'Mengirim seluruh isi file yang sedang terbuka di editor, supaya Muse bisa membacanya sebelum menjawab.',
      attSelectionTip: 'Mengirim hanya teks yang sedang kamu blok/pilih di editor - cocok untuk bertanya soal beberapa baris tertentu.',
      attTreeTip: 'Mengirim daftar folder dan nama file proyekmu - peta proyek, tanpa isi file apa pun.',
      attDiffTip: 'Mengirim perubahan yang belum di-commit: baris yang ditambah, diubah, atau dihapus sejak commit terakhir. Cocok untuk review kode.',
      sec2: '2 detik', sec4: '4 detik', sec5: '5 detik', sec8: '8 detik', sec10: '10 detik', sec15: '15 detik', sec20: '20 detik', sec30: '30 detik', sec60: '60 detik', sec120: '120 detik',
      req1: '1 request', req3: '3 request', req5: '5 request',
      min1: '1 menit', min3: '3 menit', min5: '5 menit', min10: '10 menit', off: 'Nonaktif',
      day7: '7 hari', day30: '30 hari', day90: '90 hari', forever: 'Selamanya',
      modeRelay: 'Relay', modeContext: 'Konteks', modeTunnel: 'Tunnel',
      inputPlaceholder: 'Tulis pesan untuk Muse… (Ctrl+Enter untuk kirim)', send: 'Kirim ke Muse', clear: 'Bersihkan',
      you: 'Kamu', emptyHistory: 'Belum ada pesan. Tulis pesan di bawah, pilih lampiran konteksnya, lalu Kirim ke Muse.',
      copiedNote: 'Tersalin ke clipboard dan muse.ai dibuka — tempel (Ctrl+V) di sana untuk mengirim.',
      queuedNote: 'Masuk inbox relay — jawaban Muse akan muncul di sini.',
      noText: '(tanpa teks — konteks saja)',
      heldPanel: 'Ditahan (relay di-pause): "{text}" — akan terkirim saat relay dilanjutkan.',
      heldHost: 'Relay sedang di-pause — pesan "{text}" tidak ditulis ke inbox. Lanjutkan relay lalu kirim lagi.',
      warnWait: 'Request "{label}" sudah menunggu lebih dari {mins} menit. Muse mungkin sedang mengerjakan tugas yang panjang, atau relay sedang terhenti — periksa status relay di bagian atas panel.',
      saved: 'Tersimpan ',
      appliedSame: 'Diterapkan Muse: {n} detik (sejak {t})',
      appliedDiff: 'Diminta: {req} detik — diterapkan Muse: {n} detik. Perubahan diterapkan otomatis pada siklus polling berikutnya.',
      appliedPending: 'Diminta: {req} detik. Belum ada konfirmasi penerapan dari Muse — perubahan diterapkan otomatis pada siklus polling berikutnya.'
    }
  };
  var lang = 'en';
  function t(key) { return (STR[lang] && STR[lang][key]) || STR.en[key] || key; }
  function tpl(key, vars) {
    var s = t(key);
    Object.keys(vars || {}).forEach(function (k) { s = s.split('{' + k + '}').join(String(vars[k])); });
    return s;
  }
  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var k = el.getAttribute('data-i18n');
      if (STR[lang][k]) el.textContent = STR[lang][k];
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
      var k = el.getAttribute('data-i18n-ph');
      if (STR[lang][k]) el.setAttribute('placeholder', STR[lang][k]);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      var k = el.getAttribute('data-i18n-title');
      if (STR[lang][k]) el.setAttribute('title', STR[lang][k]);
    });
    document.documentElement.setAttribute('lang', lang);
    renderPause();
    renderApplied(window.__applied || null);
    render();
  }

  var vscodeApi = acquireVsCodeApi();
  var state = vscodeApi.getState() || { history: [] };
  if (!Array.isArray(state.history)) state.history = [];
  if (!Array.isArray(state.held)) state.held = [];
  if (!Array.isArray(state.pending)) state.pending = [];
  var relayPaused = false;
  var settings = null;
  var historyEl = document.getElementById('history');

  function save() { vscodeApi.setState(state); }

  function render() {
    historyEl.innerHTML = '';
    if (!state.history.length) {
      var d0 = document.createElement('div');
      d0.className = 'sys';
      d0.textContent = t('emptyHistory');
      historyEl.appendChild(d0);
      return;
    }
    state.history.forEach(function (h) {
      if (h.role === 'sys') {
        var s = document.createElement('div');
        s.className = 'sys';
        s.textContent = h.text;
        historyEl.appendChild(s);
        return;
      }
      var d = document.createElement('div');
      d.className = 'msg ' + (h.role === 'muse' ? 'muse' : 'user');
      var who = document.createElement('div');
      who.className = 'who';
      who.textContent = h.role === 'muse' ? 'Muse' : t('you') + (h.mode ? ' · ' + h.mode : '');
      var body = document.createElement('div');
      body.textContent = h.text;
      d.appendChild(who);
      d.appendChild(body);
      historyEl.appendChild(d);
      if (h.role !== 'muse' && (h.mode === 'context' || h.mode === 'tunnel')) {
        var s2 = document.createElement('div');
        s2.className = 'sys';
        s2.textContent = t('copiedNote');
        historyEl.appendChild(s2);
      }
      if (h.role !== 'muse' && h.mode === 'relay') {
        var s3 = document.createElement('div');
        s3.className = 'sys';
        s3.textContent = t('queuedNote');
        historyEl.appendChild(s3);
      }
    });
    historyEl.scrollTop = historyEl.scrollHeight;
  }

  function renderPause() {
    document.getElementById('pause').textContent = relayPaused ? t('resume') : t('pause');
    document.getElementById('statusText').textContent = relayPaused ? t('statusPaused') : t('statusActive');
    document.getElementById('statusDot').className = relayPaused ? 'dot paused' : 'dot';
  }

  function fmtTime(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleTimeString(lang === 'id' ? 'id-ID' : 'en-US', { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  function renderSettings() {
    if (!settings) return;
    document.getElementById('s-uiLang').value = settings.uiLanguage || 'en';
    document.getElementById('s-hookPoll').value = String(settings.hookPollSecs);
    document.getElementById('s-maxPerWake').value = String(settings.maxPerWake);
    document.getElementById('s-language').value = settings.answerLanguage;
    document.getElementById('s-outboxPoll').value = String(settings.outboxPollSecs);
    document.getElementById('s-notify').checked = !!settings.notifyOnAnswer;
    document.getElementById('s-warn').value = String(settings.warnAfterMins);
    document.getElementById('s-retention').value = String(settings.archiveRetentionDays);
    var da = settings.defaultAttach || {};
    document.getElementById('s-att-file').checked = !!da.file;
    document.getElementById('s-att-selection').checked = !!da.selection;
    document.getElementById('s-att-tree').checked = !!da.tree;
    document.getElementById('s-att-diff').checked = !!da.diff;
    applyAttachDefaults();
  }

  function applyAttachDefaults() {
    if (!settings || !settings.defaultAttach) return;
    document.getElementById('a-file').checked = !!settings.defaultAttach.file;
    document.getElementById('a-selection').checked = !!settings.defaultAttach.selection;
    document.getElementById('a-tree').checked = !!settings.defaultAttach.tree;
    document.getElementById('a-diff').checked = !!settings.defaultAttach.diff;
  }

  function renderApplied(applied) {
    var line = document.getElementById('appliedLine');
    if (!line) return;
    if (!settings) { line.textContent = ''; return; }
    if (applied && applied.hookPollSecs) {
      var same = Number(applied.hookPollSecs) === Number(settings.hookPollSecs);
      line.textContent = same
        ? tpl('appliedSame', { n: applied.hookPollSecs, t: applied.appliedAt ? fmtTime(applied.appliedAt) : '' })
        : tpl('appliedDiff', { req: settings.hookPollSecs, n: applied.hookPollSecs });
    } else {
      line.textContent = tpl('appliedPending', { req: settings.hookPollSecs });
    }
  }

  function collectAndSave() {
    if (!settings) settings = {};
    settings.uiLanguage = document.getElementById('s-uiLang').value;
    settings.hookPollSecs = Number(document.getElementById('s-hookPoll').value);
    settings.maxPerWake = Number(document.getElementById('s-maxPerWake').value);
    settings.answerLanguage = document.getElementById('s-language').value;
    settings.outboxPollSecs = Number(document.getElementById('s-outboxPoll').value);
    settings.notifyOnAnswer = document.getElementById('s-notify').checked;
    settings.warnAfterMins = Number(document.getElementById('s-warn').value);
    settings.archiveRetentionDays = Number(document.getElementById('s-retention').value);
    settings.defaultAttach = {
      file: document.getElementById('s-att-file').checked,
      selection: document.getElementById('s-att-selection').checked,
      tree: document.getElementById('s-att-tree').checked,
      diff: document.getElementById('s-att-diff').checked
    };
    lang = settings.uiLanguage === 'id' ? 'id' : 'en';
    vscodeApi.postMessage({ type: 'updateSettings', settings: settings });
    document.getElementById('savedLine').textContent = t('saved') + new Date().toLocaleTimeString(lang === 'id' ? 'id-ID' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    applyI18n();
  }

  ['s-uiLang','s-hookPoll','s-maxPerWake','s-language','s-outboxPoll','s-notify','s-warn','s-retention','s-att-file','s-att-selection','s-att-tree','s-att-diff'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', collectAndSave);
  });

  document.getElementById('settingsBtn').addEventListener('click', function () {
    var el = document.getElementById('settings');
    el.className = el.className === 'open' ? '' : 'open';
    if (el.className === 'open') vscodeApi.postMessage({ type: 'getSettings' });
  });

  function currentMode() {
    var r = document.querySelector('input[name="mode"]:checked');
    return r ? r.value : 'relay';
  }

  document.querySelectorAll('#modes label').forEach(function (lab) {
    lab.addEventListener('click', function () {
      document.querySelectorAll('#modes label').forEach(function (l) { l.className = ''; });
      lab.className = 'active';
      document.getElementById('chips').style.opacity = (lab.getAttribute('data-mode') === 'tunnel') ? '0.4' : '1';
    });
  });

  function currentAttach() {
    return {
      file: document.getElementById('a-file').checked,
      selection: document.getElementById('a-selection').checked,
      tree: document.getElementById('a-tree').checked,
      diff: document.getElementById('a-diff').checked
    };
  }

  function flushHeld() {
    if (relayPaused || !state.held.length) return;
    var items = state.held.splice(0, state.held.length);
    save();
    items.forEach(function (h) {
      vscodeApi.postMessage({ type: 'send', text: h.text, mode: 'relay', attach: h.attach });
    });
  }

  document.getElementById('send').addEventListener('click', function () {
    var text = document.getElementById('input').value.trim();
    var mode = currentMode();
    var attach = currentAttach();
    if (mode === 'relay' && relayPaused) {
      state.held.push({ text: text, attach: attach });
      state.history.push({ role: 'sys', text: tpl('heldPanel', { text: text || t('noText') }) });
      save(); render();
      document.getElementById('input').value = '';
      return;
    }
    vscodeApi.postMessage({ type: 'send', text: text, mode: mode, attach: attach });
    document.getElementById('input').value = '';
  });

  document.getElementById('pause').addEventListener('click', function () {
    vscodeApi.postMessage({ type: 'togglePause', paused: !relayPaused });
  });
  document.getElementById('input').addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') document.getElementById('send').click();
  });
  document.getElementById('open').addEventListener('click', function () { vscodeApi.postMessage({ type: 'openMuse' }); });
  document.getElementById('clear').addEventListener('click', function () { state.history = []; state.pending = []; save(); render(); });

  setInterval(function () {
    if (!settings || !settings.warnAfterMins || !state.pending.length) return;
    var now = Date.now();
    var changed = false;
    state.pending.forEach(function (p) {
      if (!p.warned && now - p.at > settings.warnAfterMins * 60000) {
        p.warned = true;
        changed = true;
        state.history.push({ role: 'sys', text: tpl('warnWait', { label: p.label || p.id, mins: settings.warnAfterMins }) });
      }
    });
    if (changed) { save(); render(); }
  }, 15000);

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m) return;
    if (m.type === 'sent') { state.history.push({ text: m.text || t('noText'), mode: m.mode }); save(); render(); }
    if (m.type === 'queued') {
      state.history.push({ text: m.text || t('noText'), mode: 'relay' });
      state.pending.push({ id: m.id, at: Date.now(), label: (m.text || '').slice(0, 40), warned: false });
      save(); render();
    }
    if (m.type === 'relayAnswer') {
      state.history.push({ role: 'muse', text: m.answer });
      state.pending = state.pending.filter(function (p) { return p.id !== m.id; });
      save(); render();
    }
    if (m.type === 'heldByHost') { state.history.push({ role: 'sys', text: tpl('heldHost', { text: m.text || '' }) }); save(); render(); }
    if (m.type === 'relayState') {
      relayPaused = !!m.paused;
      renderPause();
      flushHeld();
    }
    if (m.type === 'settings') {
      settings = m.settings;
      window.__applied = m.applied || null;
      lang = settings && settings.uiLanguage === 'id' ? 'id' : 'en';
      renderSettings();
      applyI18n();
    }
  });

  render();
  renderPause();
  vscodeApi.postMessage({ type: 'getRelayState' });
  vscodeApi.postMessage({ type: 'getSettings' });
</script>
</body>
</html>`;
}

function activate(context) {
  register(context);
}

function deactivate() {}

module.exports = { activate, deactivate };

# LanPair

Real-time pair editing for Antigravity / Code OSS over the local network.
Two people on the same LAN edit the same files simultaneously and see each
other's cursors. Built on Yjs (CRDT); no cloud server, no accounts, no internet.

Status: Phase 4 (discovery, reconnection, .gitignore, disk changes, local undo). Phase 5 (mirror mode) is optional. See `PROMPT-claude-code-lanpair.md` for the roadmap.

## Development

```sh
npm install
npm run build     # bundle to dist/extension.js
npm test          # vitest (pure logic)
npm run test:integration  # runs inside the installed Antigravity (opens windows briefly)
npm run test:pair         # host + guest Antigravity instances typing together (LANPAIR_PAIR_SECONDS, default 120)
npm run package   # produce lanpair.vsix
```

Install in Antigravity: Extensions → ⋯ → Install from VSIX… → `lanpair.vsix`.

## Sync core (Phase 1)

- `src/sync/delta.ts`: plain-text delta with compose/transform (OT on top of the CRDT).
- `src/sync/document.ts`: editor-agnostic document; all offsets are LF-normalized,
  CRLF documents are converted at the edge.
- `src/sync/EditorBinding.ts`: TextDocument ↔ Y.Text. Keeps the invariant
  `ytext == apply(editorText, pending)`; remote changes are composed into
  `pending` and flushed with one `applyEdit` at a time, local changes are
  transformed through `pending` and pushed immediately. Our own edit's echo is
  recognized by its expected text; if the user typed first, VS Code rejects
  the edit (document version check) and it is retried.
- `src/sync/DocRegistry.ts`: path → Y.Doc (ref counted) and the session Awareness.

Manual check: open any file and run **LanPair: Debug: Mirror Active Editor
(toggle)**. A second editor opens beside it, joined through two Y.Docs with
20–250 ms of artificial latency. Type in both at once; they must never diverge.
Binding warnings go to the "LanPair" output channel.

## Using it

Host: open the folder to share, run **LanPair: Start Hosting**. A notification
shows `IP:port` and a 6-digit PIN (also in the status bar; **Copy Join Info**).

Both: Start Hosting and Join ask for the name (and, the first time, the color)
shown next to your cursor; change it any time with **LanPair: Set Name and Color**.

Guest: run **LanPair: Join Session…** and pick the host from the list of
sessions found on the network (mDNS), or enter `IP:port`; then type the PIN. The host's
folder opens as `lanpair://<session>/` (in this window if it is empty,
otherwise in a new one) and the Explorer shows the host's files. Text files
are edited live; binary or oversized files open read-only. Ctrl+S on the guest
saves the file on the host (the host's save participants, such as format on
save, run there too).

Both sides see each other's cursors and selections, with the name floating
above the cursor (`lanpair.nameLabels`: always / whileMoving / never).
In shared files Ctrl+Z / Ctrl+Shift+Z undo and redo only your own edits
(`lanpair.localUndo`).

If the connection drops, the guest keeps editing and reconnects on its own
(1 s → 10 s backoff, heartbeat every 10 s); edits made meanwhile on both
sides are merged. Files changed on the host's disk (git checkout, external
formatter) reach the guest as a minimal change, so cursors elsewhere stay put.
Files ignored by `.gitignore` or `lanpair.exclude` are invisible to guests.
**LanPair: Follow Participant** follows someone's file and cursor until you
move your own cursor. Click the status bar item for the session menu.

Protocol: one WebSocket per guest, binary frames `{type, docId, payload}`
(`src/protocol.ts`, `PROTOCOL_VERSION` checked in the handshake). Nothing is
sent before a valid PIN; 5 wrong PINs block the address for the session.
Every path from a guest is validated against `..`, absolute paths and
symbolic links leaving the shared folder (`src/host/WorkspaceIndex.ts`).

## Known limitations

- Undo via the Edit menu still uses the editor's native stack (only the
  keyboard shortcuts are redirected to LanPair's own-edits undo).
- Linux hosts with ufw (or firewalld) must allow the port; the host shows the
  `ufw allow` command. Fix `lanpair.port` so the rule keeps working.
- If the host's file changes on disk while the host has unsaved session edits,
  the editor keeps the session text (like VS Code does for any dirty file).
- The guest cannot create, rename or delete files.
- The guest window applies the host's `.vscode/settings.json` like any workspace
  folder; only join sessions of people you trust.
- On the guest, remote edits mark the editor as dirty; saving (Ctrl+S) is
  how it becomes clean again.
- Only Y.Text content is synced; embeds/attributes are not supported (not needed for code).

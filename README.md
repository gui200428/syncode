# LanPair

Real-time pair editing for Antigravity / Code OSS over the local network.
Two people on the same LAN edit the same files simultaneously and see each
other's cursors. Built on Yjs (CRDT); no cloud server, no accounts, no internet.

Status: Phase 2 (one file at a time over the LAN; file tree and cursors come in Phase 3). See `PROMPT-claude-code-lanpair.md` for the roadmap.

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

## Using it (Phase 2)

Host: open the folder to share, run **LanPair: Start Hosting**. A notification
shows `IP:port` and a 6-digit PIN (also in the status bar; **Copy Join Info**).

Guest: run **LanPair: Join Session…**, type `IP:port` and the PIN, then
**LanPair: Open Remote File…** with a path relative to the shared folder
(e.g. `src/index.ts`). Ctrl+S on the guest saves the file on the host.

Protocol: one WebSocket per guest, binary frames `{type, docId, payload}`
(`src/protocol.ts`, `PROTOCOL_VERSION` checked in the handshake). Nothing is
sent before a valid PIN; 5 wrong PINs block the address for the session.
Every path from a guest is validated against `..`, absolute paths and
symbolic links leaving the shared folder (`src/host/WorkspaceIndex.ts`).

## Known limitations

- Undo/redo uses the editor's native stack, which also undoes edits made by
  the other participant. `Y.UndoManager` for local-only undo is planned for Phase 4.
- Phase 2: the guest opens files by path (no file tree yet), no remote cursors,
  no mDNS discovery and no reconnection.
- On the guest, remote edits mark the editor as dirty; saving (Ctrl+S) is
  how it becomes clean again.
- Only Y.Text content is synced; embeds/attributes are not supported (not needed for code).

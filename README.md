# LanPair

Real-time pair editing for Antigravity / Code OSS over the local network.
Two people on the same LAN edit the same files simultaneously and see each
other's cursors. Built on Yjs (CRDT); no cloud server, no accounts, no internet.

Status: Phase 1 (CRDT core, no networking yet). See `PROMPT-claude-code-lanpair.md` for the roadmap.

## Development

```sh
npm install
npm run build     # bundle to dist/extension.js
npm test          # vitest (pure logic)
npm run test:integration  # runs inside the installed Antigravity (opens windows briefly)
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

## Known limitations

- Undo/redo uses the editor's native stack, which also undoes edits made by
  the other participant. `Y.UndoManager` for local-only undo is planned for Phase 4.
- Only Y.Text content is synced; embeds/attributes are not supported (not needed for code).

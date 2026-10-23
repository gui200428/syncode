# LanPair

Real-time pair editing for Antigravity / Code OSS over the local network.
Two people on the same LAN edit the same files simultaneously and see each
other's cursors. Built on Yjs (CRDT); no cloud server, no accounts, no internet.

Status: Phase 5 (mirror mode: the guest can work on a local copy so its language servers work). See `PROMPT-claude-code-lanpair.md` for the roadmap.

## Development

```sh
npm install
npm run build     # bundle to dist/extension.js
npm test          # vitest (pure logic)
npm run test:integration  # runs inside the installed Antigravity (opens windows briefly)
npm run test:pair         # host + guest Antigravity instances typing together (LANPAIR_PAIR_SECONDS, default 120)
npm run test:mirror       # the same with the guest in mirror mode
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

### Mirror mode (guest)

After the PIN, Join asks how to open the shared folder:

- **Open the shared folder**: the `lanpair://` folder above. Nothing is written
  to the guest's disk, but language servers (IntelliSense, go to definition,
  diagnostics), terminals and tools do not work on it.
- **Mirror into a local folder**: pick a folder (empty, or a clone of the same
  project). The host's files are copied into it and it opens as a normal local
  folder, so everything that needs files on disk works: the guest can run
  `npm install` there (excluded folders such as `node_modules` are not copied,
  and files created on the guest stay on the guest).

How the mirror stays in sync:

- Files that are not open are copies of the host's **saved** files, updated
  when they change on the host (saves, git checkout, new or deleted files).
- A file opened in an editor is edited live, like in the other mode. It shows
  the host's unsaved changes too, so it is marked dirty while the shared text
  has unsaved changes.
- Saving is shared: Ctrl+S on the guest saves on both machines, and a save on
  the host saves the guest's copy (save participants such as format on save
  run on the side that saves).
- If files in the folder differ from the host's and were not written by
  LanPair (first mirror into a clone, or local changes), you are asked whether
  to replace them or keep yours. Files changed on the guest are never deleted.
  LanPair remembers what it wrote in its own storage, not in the folder.
- The window reconnects when the folder is opened again (join info is kept in
  the editor's secret storage). If the host started a new session, enter the
  new PIN. **Leave Session** stops mirroring; the files stay as a local copy.
- Paths from the host are validated before anything is written: no `..`, no
  absolute paths, no symbolic links leaving the folder, never inside `.git`.

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
- The guest cannot create, rename or delete shared files. In mirror mode, files
  created on the guest stay local, and only edits made in an editor are
  shared (a guest-side formatter CLI or `git checkout` is not sent to the host;
  the host's next change to such a file replaces it).
- In mirror mode, the guest's language server sees the host's unsaved changes
  only in files open on the guest; other files are the saved versions.
- Mirror mode copies at most 50,000 files (16 MB each).
- The guest window applies the host's `.vscode/settings.json` like any workspace
  folder (in mirror mode it is also on disk, together with tasks and other
  workspace files); only join sessions of people you trust.
- On the guest, remote edits mark the editor as dirty; saving (Ctrl+S) is
  how it becomes clean again.
- Only Y.Text content is synced; embeds/attributes are not supported (not needed for code).

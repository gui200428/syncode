# Notes: Antigravity / Code OSS compatibility

Target: Antigravity IDE 1.107.0 (Code OSS 1.107.0, Linux x64), `engines.vscode: ^1.107.0`.
Run `npm run test:integration` to re-check these behaviors (uses `/opt/antigravity-ide/antigravity-ide`,
override with `LANPAIR_EDITOR`).

| Date | Version | Observation | Workaround |
|------|---------|-------------|------------|
| 2026-10-22 | 1.107.0 | `workspace.applyEdit` is not atomic with respect to typing. It goes through the async bulk-edit service: the document version is validated when the request arrives, but if the user types before it is applied, the edit is still applied **at its stale line/character positions** (probe: applyEdit insert at (0,2) on `hello`, then `type E` → `EhWello`, applyEdit resolves `true`). If the typing reaches the renderer first, the edit is correctly rejected. | `VscodeRawDocument.applyEdits` uses `TextEditor.edit` when the document has a visible editor: it is applied synchronously in the renderer, in order with keystrokes, and resolves `false` if the version changed (verified by integration tests). `workspace.applyEdit` is only used when no editor shows the document, where the user cannot type. EditorBinding also checks its invariant whenever it becomes idle and resynchronizes from the Y.Text if needed. |
| 2026-10-22 | 1.107.0 | The change event of an edit reaches the extension host before the edit's promise resolves (as in VS Code). | None needed; EditorBinding relies on it to recognize its own echo. |
| 2026-10-22 | 1.107.0 | With a fresh profile, Antigravity logs `ace depends on UNKNOWN service agentSessions` and tries to show a "Migrate Settings" dialog. Harmless for extensions. | None. |

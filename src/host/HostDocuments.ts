import * as vscode from 'vscode';
import { RemoteError } from '../protocol';
import { DocRegistry, type DocEntry } from '../sync/DocRegistry';
import { EditorBinding } from '../sync/EditorBinding';
import { bindableDocument } from '../sync/VscodeDocument';
import type { HostDocs } from './SessionServer';
import type { WorkspaceIndex } from './WorkspaceIndex';

interface Bound {
  document: vscode.TextDocument;
  binding: EditorBinding;
}

/**
 * Host implementation of HostDocs. Each shared file is backed by the host's
 * own TextDocument (opened in the background if needed), so unsaved host
 * edits are what guests see, CRLF files keep their EOL and saving goes
 * through the normal editor save.
 */
export class HostDocuments implements HostDocs, vscode.Disposable {
  readonly registry = new DocRegistry();
  private readonly bound = new Map<string, Bound>();
  private readonly realPaths = new Map<string, string>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly index: WorkspaceIndex,
    private readonly log: (message: string) => void,
  ) {
    const removed = this.registry.onDidRemove((e) => this.unbind(e.path));
    this.subscriptions.push(
      new vscode.Disposable(() => removed.dispose()),
      vscode.workspace.onDidCloseTextDocument((doc) => this.onClosed(doc)),
    );
  }

  async open(path: string): Promise<DocEntry> {
    const real = await this.index.resolveTextFile(path);
    const canonical = (await this.index.relative(real)) ?? path;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(real));
    // If the host already has the file open with unsaved changes, those win.
    const entry = this.registry.acquire(canonical, () => document.getText());
    this.realPaths.set(canonical, real);
    if (!this.bound.has(canonical)) this.bind(canonical, document, entry);
    return entry;
  }

  close(path: string): void {
    this.registry.release(path);
  }

  async save(path: string): Promise<void> {
    const b = this.bound.get(path);
    if (!b) throw new RemoteError('not-open', 'file is not open on the host');
    await b.binding.whenIdle();
    if (b.document.isDirty && !(await b.document.save())) {
      throw new RemoteError('save-failed', 'the host could not save the file');
    }
  }

  dispose(): void {
    for (const s of this.subscriptions.splice(0)) s.dispose();
    for (const path of [...this.bound.keys()]) this.unbind(path);
    this.registry.dispose();
  }

  private bind(path: string, document: vscode.TextDocument, entry: DocEntry): void {
    const binding = new EditorBinding(entry.text, bindableDocument(document), {
      log: (m) => this.log(`[${path}] ${m}`),
    });
    this.bound.set(path, { document, binding });
  }

  private unbind(path: string): void {
    this.bound.get(path)?.binding.dispose();
    this.bound.delete(path);
    if (!this.registry.get(path)) this.realPaths.delete(path);
  }

  /** The editor may close background documents; reopen while guests still use them. */
  private onClosed(document: vscode.TextDocument): void {
    for (const [path, b] of this.bound) {
      if (b.document !== document) continue;
      this.unbind(path);
      const entry = this.registry.get(path);
      const real = this.realPaths.get(path);
      if (!entry || !real) return;
      void vscode.workspace.openTextDocument(vscode.Uri.file(real)).then(
        (doc) => {
          if (this.registry.get(path) === entry && !this.bound.has(path)) this.bind(path, doc, entry);
        },
        (err: unknown) => this.log(`[${path}] could not reopen: ${String(err)}`),
      );
      return;
    }
  }
}

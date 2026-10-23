import * as vscode from 'vscode';
import { RemoteError, type FsChange, type NotifyPayload } from '../protocol';
import { EditorBinding } from '../sync/EditorBinding';
import type { DocLocator } from '../sync/RemoteCursors';
import { bindableDocument } from '../sync/VscodeDocument';
import type { MirrorDisk, SyncResult } from './MirrorDisk';
import type { SessionClient } from './SessionClient';

/** True if a document for this mirror path is open: it follows the Y.Text, not the disk. */
export function isOpenInEditor(root: vscode.Uri, rel: string): boolean {
  const uri = vscode.Uri.joinPath(root, ...rel.split('/')).toString();
  return vscode.workspace.textDocuments.some((d) => !d.isClosed && d.uri.toString() === uri);
}

interface Bound {
  document: vscode.TextDocument;
  binding: EditorBinding;
}

/**
 * Guest side of mirror mode. The host's files live in a local folder opened
 * as a normal workspace, so the guest's language servers, terminals and git
 * work on them.
 *
 * - Files that are not open are plain copies of the host's saved files
 *   (MirrorDisk), refreshed when the host's files change.
 * - A file opened in an editor is bound to its live Y.Text, like the host's
 *   own documents: edits flow both ways and the document is dirty while the
 *   shared text has unsaved changes.
 * - Saving is shared: a save here asks the host to save, and a save on the
 *   host saves the local document, so both disks hold the same version.
 */
export class MirrorWorkspace implements DocLocator, vscode.Disposable {
  private readonly bound = new Map<string, Bound>();
  /** Documents being connected to their Y.Doc. */
  private readonly opening = new Map<string, Promise<void>>();
  /** Binary or oversized files: plain copies, never live. */
  private readonly unsyncable = new Set<string>();
  /** Paths whose current save was started because the host saved. */
  private readonly hostSaves = new Set<string>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly bindingsEmitter = new vscode.EventEmitter<void>();
  /** Fires when a document starts or stops being bound. */
  readonly onDidChangeBindings = this.bindingsEmitter.event;
  private disposed = false;

  constructor(
    private readonly client: SessionClient,
    readonly root: vscode.Uri,
    private readonly disk: MirrorDisk,
    private readonly log: (message: string) => void,
  ) {
    const notify = client.onDidNotify((n) => this.onNotify(n));
    const state = client.onDidChangeState((s) => {
      // Files may have changed on the host while we were away.
      if (s === 'connected') void this.resync();
    });
    this.subscriptions.push(
      new vscode.Disposable(() => notify.dispose()),
      new vscode.Disposable(() => state.dispose()),
      vscode.workspace.onDidOpenTextDocument((d) => this.bindDocument(d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.onClosed(d)),
      vscode.workspace.onDidSaveTextDocument((d) => void this.onSaved(d)),
    );
  }

  /** Brings the folder up to date and binds the documents already open. */
  async start(): Promise<SyncResult> {
    await this.disk.load();
    const result = await this.disk.sync();
    this.bindOpenDocuments();
    return result;
  }

  // DocLocator

  docIdFor(document: vscode.TextDocument): string | undefined {
    const rel = this.relOf(document.uri);
    // Files that exist only here (node_modules, build output) are not shared.
    return rel && this.disk.knows(rel) ? (this.client.canonicalPath(rel) ?? rel) : undefined;
  }

  bindingFor(document: vscode.TextDocument): EditorBinding | undefined {
    const rel = this.relOf(document.uri);
    const b = rel ? this.bound.get(rel) : undefined;
    return b?.document === document ? b.binding : undefined;
  }

  uriFor(docId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ...docId.split('/'));
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.subscriptions.splice(0)) s.dispose();
    for (const [rel, b] of this.bound) {
      b.binding.dispose();
      this.client.closeDoc(rel);
    }
    this.bound.clear();
    this.opening.clear();
    this.bindingsEmitter.fire();
    this.bindingsEmitter.dispose();
  }

  private relOf(uri: vscode.Uri): string | undefined {
    return uri.scheme === 'file' ? this.disk.relativePath(uri.fsPath) : undefined;
  }

  private async resync(): Promise<void> {
    try {
      await this.disk.sync();
      this.bindOpenDocuments();
    } catch (err) {
      this.log(`resync after reconnecting failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private bindOpenDocuments(): void {
    for (const d of vscode.workspace.textDocuments) this.bindDocument(d);
  }

  private bindDocument(document: vscode.TextDocument): void {
    if (this.disposed || document.isClosed) return;
    const rel = this.relOf(document.uri);
    if (!rel || !this.disk.knows(rel) || this.unsyncable.has(rel)) return;
    if (this.bound.has(rel) || this.opening.has(rel)) return;
    const opening = this.client.openDoc(rel).then(
      (entry) => {
        if (this.opening.get(rel) !== opening || this.disposed || document.isClosed) {
          this.client.closeDoc(rel);
          return;
        }
        this.opening.delete(rel);
        // The editor holds the saved copy; the binding brings in unsaved shared edits.
        const binding = new EditorBinding(entry.text, bindableDocument(document), {
          log: (m) => this.log(`[${entry.path}] ${m}`),
        });
        this.bound.set(rel, { document, binding });
        this.bindingsEmitter.fire();
      },
      (err: unknown) => {
        if (this.opening.get(rel) === opening) this.opening.delete(rel);
        if (err instanceof RemoteError && (err.code === 'binary' || err.code === 'too-large')) {
          this.unsyncable.add(rel);
        } else if (!this.disposed) {
          this.log(`could not share ${rel}: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    );
    this.opening.set(rel, opening);
  }

  private onClosed(document: vscode.TextDocument): void {
    const rel = this.relOf(document.uri);
    if (!rel) return;
    this.opening.delete(rel); // a pending open releases itself
    const b = this.bound.get(rel);
    if (!b || b.document !== document) return;
    b.binding.dispose();
    this.bound.delete(rel);
    this.client.closeDoc(rel);
    this.bindingsEmitter.fire();
    // Closed without saving: the disk copy may be older than the host's.
    void this.disk.sync(rel).catch((err: unknown) => this.log(`could not refresh ${rel}: ${String(err)}`));
  }

  private async onSaved(document: vscode.TextDocument): Promise<void> {
    const rel = this.relOf(document.uri);
    const b = rel ? this.bound.get(rel) : undefined;
    if (!rel || !b || b.document !== document) return;
    if (this.hostSaves.delete(rel)) {
      await this.disk.markSaved(rel);
      return;
    }
    // Saved here: the host writes the same text to its disk.
    await b.binding.whenIdle();
    try {
      await this.client.save(rel);
    } catch (err) {
      void vscode.window.showWarningMessage(
        `LanPair: the host could not save ${rel}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.disk.markSaved(rel);
  }

  /** The host saved `rel`: save the local document too (its text is the shared one). */
  private async saveFromHost(rel: string): Promise<void> {
    const b = this.bound.get(rel);
    if (!b || !b.document.isDirty) return;
    await b.binding.whenIdle();
    if (this.bound.get(rel) !== b || !b.document.isDirty) return;
    this.hostSaves.add(rel);
    if (!(await b.document.save())) {
      this.hostSaves.delete(rel);
      this.log(`[${rel}] could not save the local copy after the host saved`);
    }
  }

  /** Mirror paths currently bound to the host's canonical docId `docId`. */
  private boundPaths(docId: string): string[] {
    return [...this.bound.keys()].filter((rel) => (this.client.canonicalPath(rel) ?? rel) === docId);
  }

  private onNotify(n: NotifyPayload): void {
    if (this.disposed) return;
    if (n.event === 'saved') {
      for (const rel of this.boundPaths(n.path)) void this.saveFromHost(rel);
      return;
    }
    const rest: FsChange[] = [];
    for (const c of n.changes) {
      const live = this.boundPaths(c.path);
      // A live file changed on the host's disk means the host saved it.
      if (c.type === 'changed' && live.length > 0) for (const rel of live) void this.saveFromHost(rel);
      else rest.push(c);
    }
    if (rest.length === 0) return;
    void this.disk.applyHostChanges(rest).then(
      () => this.bindOpenDocuments(),
      (err: unknown) => this.log(`could not apply host changes: ${String(err)}`),
    );
  }
}

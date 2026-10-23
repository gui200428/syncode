import * as vscode from 'vscode';
import { RemoteError, type FsChange } from '../protocol';
import type { DocEntry } from '../sync/DocRegistry';
import { EditorBinding } from '../sync/EditorBinding';
import type { DocLocator } from '../sync/RemoteCursors';
import { bindableDocument } from '../sync/VscodeDocument';
import type { SessionClient } from './SessionClient';

export const SCHEME = 'syncode';

/** How long file operations wait for a (re)connection before failing. */
const CONNECT_WAIT_MS = 20_000;

export function remoteUri(sessionId: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, authority: sessionId, path: `/${path}` });
}

function docPath(uri: vscode.Uri): string {
  return uri.path.replace(/^\/+/, '').replace(/\/+$/, '');
}

function toFsError(err: unknown, uri: vscode.Uri): Error {
  if (err instanceof vscode.FileSystemError) return err;
  if (err instanceof RemoteError) {
    if (err.code === 'not-found') return vscode.FileSystemError.FileNotFound(uri);
    if (err.code === 'closed') return vscode.FileSystemError.Unavailable(uri);
    if (err.code === 'not-a-file') return vscode.FileSystemError.FileIsADirectory(uri);
    return vscode.FileSystemError.NoPermissions(`${uri.path}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Guest view of the host's shared folder: `syncode://<sessionId>/<path>`.
 * Text files are served from their synced Y.Text and every TextDocument opened
 * on them is bound to it; binary or oversized files are read-only copies.
 * Saving asks the host to write its own copy.
 */
export class SynCodeFs implements vscode.FileSystemProvider, DocLocator, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changeEmitter.event;
  private readonly bindingsEmitter = new vscode.EventEmitter<void>();
  /** Fires when a document starts or stops being bound. */
  readonly onDidChangeBindings = this.bindingsEmitter.event;

  private client: SessionClient | undefined;
  private sessionId: string | undefined;
  private waiting: { sessionId: string; promise: Promise<SessionClient | undefined> } | undefined;
  /** One client reference per synced path while editors may use it. */
  private readonly entries = new Map<string, Promise<DocEntry>>();
  /**
   * mtimes we report for synced files. They only change when the guest saves,
   * so the editor never reloads (and replaces) a live document from "disk".
   */
  private readonly mtimes = new Map<string, number>();
  private readonly bindings = new Map<string, EditorBinding>();
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly log: (message: string) => void) {
    this.subscriptions = [
      vscode.workspace.onDidOpenTextDocument((d) => this.bindDocument(d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.unbindDocument(d)),
    ];
  }

  /** Starts serving a session (or stops with undefined). */
  setSession(client: SessionClient | undefined): void {
    for (const b of this.bindings.values()) b.dispose();
    this.bindings.clear();
    if (this.client) for (const path of this.entries.keys()) this.client.closeDoc(path);
    this.entries.clear();
    this.mtimes.clear();
    this.client = client;
    this.sessionId = client?.welcome.sessionId;
    if (client) {
      client.onDidNotify((n) => {
        if (n.event === 'fs') this.onHostChanges(n.changes);
      });
      // Re-read documents left open from before a reload or reconnection.
      for (const d of vscode.workspace.textDocuments) {
        if (d.uri.scheme === SCHEME && d.uri.authority === this.sessionId) void this.entry(d.uri).then(() => this.bindDocument(d), () => {});
      }
    }
    this.bindingsEmitter.fire();
  }

  /** Lets file operations wait while the session for `sessionId` is connecting. */
  setConnecting(sessionId: string, promise: Promise<SessionClient | undefined>): void {
    this.waiting = { sessionId, promise };
    void promise.finally(() => {
      if (this.waiting?.promise === promise) this.waiting = undefined;
    });
  }

  // DocLocator

  docIdFor(document: vscode.TextDocument): string | undefined {
    const uri = document.uri;
    if (uri.scheme !== SCHEME || uri.authority !== this.sessionId) return undefined;
    const path = docPath(uri);
    return this.client?.canonicalPath(path) ?? path;
  }

  bindingFor(document: vscode.TextDocument): EditorBinding | undefined {
    return this.bindings.get(document.uri.toString());
  }

  uriFor(docId: string): vscode.Uri {
    return remoteUri(this.sessionId ?? 'unknown', docId);
  }

  // FileSystemProvider

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const client = await this.clientFor(uri);
    const path = docPath(uri);
    try {
      const st = await client.stat(path);
      if (st.kind === 'directory') {
        return { type: vscode.FileType.Directory, ctime: st.ctime, mtime: st.mtime, size: 0 };
      }
      let mtime = st.mtime;
      if (st.syncable) {
        const key = client.canonicalPath(path) ?? path;
        mtime = this.mtimes.get(key) ?? st.mtime;
        this.mtimes.set(key, mtime);
      }
      return {
        type: vscode.FileType.File,
        ctime: st.ctime,
        mtime,
        size: st.size,
        permissions: st.syncable ? undefined : vscode.FilePermission.Readonly,
      };
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const client = await this.clientFor(uri);
    try {
      const entries = await client.list(docPath(uri));
      return entries.map(([name, kind]) => [name, kind === 'directory' ? vscode.FileType.Directory : vscode.FileType.File]);
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const client = await this.clientFor(uri);
    try {
      const entry = await this.entry(uri);
      return Buffer.from(entry.text.toString(), 'utf8');
    } catch (err) {
      if (err instanceof RemoteError && (err.code === 'binary' || err.code === 'too-large')) {
        try {
          return await client.read(docPath(uri));
        } catch (readErr) {
          throw toFsError(readErr, uri);
        }
      }
      throw toFsError(err, uri);
    }
  }

  async writeFile(uri: vscode.Uri): Promise<void> {
    // The Y.Text already holds the content; the host saves its own copy.
    const client = await this.clientFor(uri);
    const path = docPath(uri);
    if (!this.entries.has(path)) throw vscode.FileSystemError.NoPermissions('Only shared text files can be saved.');
    await this.bindings.get(uri.toString())?.whenIdle();
    try {
      await client.save(path);
    } catch (err) {
      throw toFsError(err, uri);
    }
    this.mtimes.set(client.canonicalPath(path) ?? path, Date.now());
  }

  createDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  dispose(): void {
    this.setSession(undefined);
    for (const s of this.subscriptions) s.dispose();
    this.changeEmitter.dispose();
    this.bindingsEmitter.dispose();
  }

  private async clientFor(uri: vscode.Uri): Promise<SessionClient> {
    if (this.waiting && this.waiting.sessionId === uri.authority && this.sessionId !== uri.authority) {
      await Promise.race([this.waiting.promise, new Promise((r) => setTimeout(r, CONNECT_WAIT_MS))]);
    }
    if (!this.client || !this.client.isOpen || uri.authority !== this.sessionId) {
      throw vscode.FileSystemError.Unavailable(`${uri.toString()}: not connected to this SynCode session`);
    }
    return this.client;
  }

  private async entry(uri: vscode.Uri): Promise<DocEntry> {
    const client = await this.clientFor(uri);
    const path = docPath(uri);
    let pending = this.entries.get(path);
    if (!pending) {
      pending = client.openDoc(path);
      this.entries.set(path, pending);
      pending.catch(() => {
        if (this.entries.get(path) === pending) this.entries.delete(path);
      });
    }
    return pending;
  }

  private onHostChanges(changes: readonly FsChange[]): void {
    if (!this.sessionId) return;
    const events: vscode.FileChangeEvent[] = [];
    for (const c of changes) {
      // Live documents follow the Y.Text; never let the editor reload them.
      if (c.type === 'changed' && this.entries.has(c.path)) continue;
      const type =
        c.type === 'created'
          ? vscode.FileChangeType.Created
          : c.type === 'deleted'
            ? vscode.FileChangeType.Deleted
            : vscode.FileChangeType.Changed;
      events.push({ type, uri: remoteUri(this.sessionId, c.path) });
    }
    if (events.length > 0) this.changeEmitter.fire(events);
  }

  private bindDocument(document: vscode.TextDocument): void {
    const uri = document.uri;
    if (uri.scheme !== SCHEME || uri.authority !== this.sessionId) return;
    const key = uri.toString();
    if (this.bindings.has(key)) return;
    const pending = this.entries.get(docPath(uri));
    if (!pending) return; // read-only (binary) file
    void pending.then(
      (entry) => {
        if (this.bindings.has(key) || document.isClosed || this.entries.get(docPath(uri)) !== pending) return;
        this.bindings.set(
          key,
          new EditorBinding(entry.text, bindableDocument(document), { log: (m) => this.log(`[${entry.path}] ${m}`) }),
        );
        this.bindingsEmitter.fire();
      },
      () => {},
    );
  }

  private unbindDocument(document: vscode.TextDocument): void {
    const uri = document.uri;
    if (uri.scheme !== SCHEME) return;
    const key = uri.toString();
    this.bindings.get(key)?.dispose();
    if (this.bindings.delete(key)) this.bindingsEmitter.fire();
    const path = docPath(uri);
    if (uri.authority === this.sessionId && this.entries.delete(path)) this.client?.closeDoc(path);
  }
}

import * as vscode from 'vscode';
import { RemoteError } from '../protocol';
import type { DocEntry } from '../sync/DocRegistry';
import { EditorBinding } from '../sync/EditorBinding';
import { bindableDocument } from '../sync/VscodeDocument';
import type { SessionClient } from './SessionClient';

export const SCHEME = 'lanpair';

export function remoteUri(sessionId: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, authority: sessionId, path: `/${path}` });
}

function docPath(uri: vscode.Uri): string {
  return uri.path.replace(/^\/+/, '');
}

function toFsError(err: unknown, uri: vscode.Uri): Error {
  if (err instanceof RemoteError) {
    if (err.code === 'not-found') return vscode.FileSystemError.FileNotFound(uri);
    if (err.code === 'closed') return vscode.FileSystemError.Unavailable(uri);
    return vscode.FileSystemError.NoPermissions(`${uri.path}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Guest view of the host's files: `lanpair://<sessionId>/<path>`. File content
 * comes from the synced Y.Text, saving asks the host to write its copy, and
 * every TextDocument opened on this scheme is bound to its Y.Text.
 * Directory listing arrives in Phase 3.
 */
export class LanPairFs implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changeEmitter.event;

  private client: SessionClient | undefined;
  private sessionId: string | undefined;
  /** One client reference per path while the editor may read it. */
  private readonly entries = new Map<string, Promise<DocEntry>>();
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
    if (client) for (const d of vscode.workspace.textDocuments) this.bindDocument(d);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const entry = await this.entry(uri);
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: this.mtimes.get(entry.path) ?? 0,
      size: Buffer.byteLength(entry.text.toString()),
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const entry = await this.entry(uri);
    return Buffer.from(entry.text.toString(), 'utf8');
  }

  async writeFile(uri: vscode.Uri): Promise<void> {
    // The Y.Text already holds the content; the host saves its own copy.
    const client = this.clientFor(uri);
    const path = docPath(uri);
    const binding = this.bindings.get(uri.toString());
    await binding?.whenIdle();
    try {
      await client.save(path);
    } catch (err) {
      throw toFsError(err, uri);
    }
    this.mtimes.set(client.canonicalPath(path) ?? path, Date.now());
  }

  readDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.Unavailable(`${uri.path}: folder browsing is not available yet`);
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
  }

  private clientFor(uri: vscode.Uri): SessionClient {
    if (!this.client || !this.client.isOpen || uri.authority !== this.sessionId) {
      throw vscode.FileSystemError.Unavailable(`${uri.toString()}: not connected to this LanPair session`);
    }
    return this.client;
  }

  private async entry(uri: vscode.Uri): Promise<DocEntry> {
    const client = this.clientFor(uri);
    const path = docPath(uri);
    let pending = this.entries.get(path);
    if (!pending) {
      pending = client.openDoc(path);
      this.entries.set(path, pending);
      pending.then(
        (e) => this.mtimes.set(e.path, this.mtimes.get(e.path) ?? Date.now()),
        () => this.entries.delete(path),
      );
    }
    try {
      return await pending;
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  private bindDocument(document: vscode.TextDocument): void {
    const uri = document.uri;
    if (uri.scheme !== SCHEME || uri.authority !== this.sessionId) return;
    const key = uri.toString();
    if (this.bindings.has(key)) return;
    const pending = this.entries.get(docPath(uri));
    if (!pending) return;
    void pending.then((entry) => {
      if (this.bindings.has(key) || document.isClosed) return;
      this.bindings.set(
        key,
        new EditorBinding(entry.text, bindableDocument(document), { log: (m) => this.log(`[${entry.path}] ${m}`) }),
      );
    });
  }

  private unbindDocument(document: vscode.TextDocument): void {
    const uri = document.uri;
    if (uri.scheme !== SCHEME) return;
    const key = uri.toString();
    this.bindings.get(key)?.dispose();
    this.bindings.delete(key);
    const path = docPath(uri);
    if (uri.authority === this.sessionId && this.entries.delete(path)) this.client?.closeDoc(path);
  }
}

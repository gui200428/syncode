import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import { toUint8 } from '../host/SessionServer';
import {
  decodeFrame,
  decodeJson,
  encodeFrame,
  jsonFrame,
  MAX_FRAME_BYTES,
  MsgType,
  PROTOCOL_VERSION,
  RemoteError,
  type FileKind,
  type FileStatResult,
  type HelloPayload,
  type NotifyPayload,
  type RejectCode,
  type RejectPayload,
  type RequestMap,
  type RequestMethod,
  type ResponsePayload,
  type WelcomePayload,
} from '../protocol';
import type { Disposable } from '../sync/document';
import { DocRegistry, normalizeDocPath, type DocEntry } from '../sync/DocRegistry';

export class JoinError extends Error {
  constructor(
    readonly code: RejectCode | 'network',
    message: string,
    readonly attemptsLeft?: number,
  ) {
    super(message);
  }
}

export interface SessionClientOptions {
  host: string;
  port: number;
  pin: string;
  name: string;
  color: string;
  log?: (message: string) => void;
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface OpenDoc {
  entry: DocEntry;
  synced: Promise<void>;
  markSynced: () => void;
  dispose: () => void;
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** Guest side of a session: one WebSocket multiplexing every open file. */
export class SessionClient implements Disposable {
  readonly registry = new DocRegistry();
  private readonly requests = new Map<number, PendingRequest>();
  private readonly docs = new Map<string, OpenDoc>();
  /** Requested path → canonical docId returned by the host. */
  private readonly aliases = new Map<string, string>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private readonly notifyListeners = new Set<(n: NotifyPayload) => void>();
  private nextRequestId = 1;
  private closed = false;
  private readonly log: (message: string) => void;

  static connect(options: SessionClientOptions): Promise<SessionClient> {
    return new Promise((resolve, reject) => {
      const url = `ws://${formatHost(options.host)}:${options.port}`;
      const ws = new WebSocket(url, { maxPayload: MAX_FRAME_BYTES, handshakeTimeout: options.timeoutMs ?? 5000 });
      let settled = false;
      const fail = (err: JoinError) => {
        if (settled) return;
        settled = true;
        ws.terminate();
        reject(err);
      };
      const timer = setTimeout(
        () =>
          fail(
            new JoinError(
              'timeout',
              `No answer from ${url}. Check the address and that the host's firewall allows incoming TCP on port ${options.port} (ufw, firewalld or Windows Firewall).`,
            ),
          ),
        options.timeoutMs ?? 5000,
      );
      ws.once('open', () => {
        const hello: HelloPayload = {
          protocol: PROTOCOL_VERSION,
          pin: options.pin,
          name: options.name,
          color: options.color,
        };
        ws.send(jsonFrame(MsgType.Hello, hello));
      });
      ws.once('message', (data) => {
        clearTimeout(timer);
        try {
          const frame = decodeFrame(toUint8(data));
          if (frame.type === MsgType.Reject) {
            const r = decodeJson<RejectPayload>(frame.payload);
            fail(new JoinError(r.code, r.message, r.attemptsLeft));
          } else if (frame.type === MsgType.Welcome) {
            settled = true;
            resolve(new SessionClient(ws, decodeJson<WelcomePayload>(frame.payload), options));
          } else {
            fail(new JoinError('protocol', 'Unexpected first message from host.'));
          }
        } catch (err) {
          fail(new JoinError('protocol', String(err)));
        }
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        fail(new JoinError('network', `Cannot connect to ${url}: ${err.message}`));
      });
      ws.once('close', () => {
        clearTimeout(timer);
        fail(new JoinError('network', `Connection to ${url} closed during handshake.`));
      });
    });
  }

  private constructor(
    private readonly ws: WebSocket,
    readonly welcome: WelcomePayload,
    options: SessionClientOptions,
  ) {
    this.log = options.log ?? (() => {});
    this.registry.awareness.on('update', this.onAwarenessUpdate);
    ws.on('message', (data) => this.onMessage(toUint8(data)));
    ws.on('close', (code, reason) => this.onClose(`${code} ${reason.toString()}`.trim()));
    ws.on('error', (err) => this.log(`connection error: ${err.message}`));
  }

  private readonly onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this) return; // came from the host
    const changed = [...changes.added, ...changes.updated, ...changes.removed];
    this.send(encodeFrame(MsgType.Awareness, '', awarenessProtocol.encodeAwarenessUpdate(this.registry.awareness, changed)));
  };

  get isOpen(): boolean {
    return !this.closed;
  }

  /**
   * Opens a file of the host and resolves once its content is synced. Each
   * call takes one reference; release it with closeDoc().
   */
  async openDoc(path: string): Promise<DocEntry> {
    const requested = normalizeDocPath(path);
    const known = this.aliases.get(requested);
    const existing = known ? this.docs.get(known) : undefined;
    if (existing) {
      await existing.synced;
      return this.registry.acquire(existing.entry.path);
    }
    const { path: canonical } = await this.request('open', { path: requested });
    this.aliases.set(requested, canonical);
    let doc = this.docs.get(canonical);
    if (doc) {
      // Opened concurrently under another name; the host kept a single reference.
      await doc.synced;
      return this.registry.acquire(canonical);
    }
    const entry = this.registry.acquire(canonical);
    let markSynced!: () => void;
    const synced = new Promise<void>((r) => (markSynced = r));
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === this) return; // came from the host
      const encoder = encoding.createEncoder();
      syncProtocol.writeUpdate(encoder, update);
      this.send(encodeFrame(MsgType.Sync, canonical, encoding.toUint8Array(encoder)));
    };
    entry.doc.on('update', onUpdate);
    doc = { entry, synced, markSynced, dispose: () => entry.doc.off('update', onUpdate) };
    this.docs.set(canonical, doc);

    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, entry.doc);
    this.send(encodeFrame(MsgType.Sync, canonical, encoding.toUint8Array(encoder)));
    await synced;
    return entry;
  }

  /** Releases one reference from openDoc(); the host is told when none remain. */
  closeDoc(path: string): void {
    const canonical = this.aliases.get(normalizeDocPath(path)) ?? normalizeDocPath(path);
    const doc = this.docs.get(canonical);
    if (!doc) return;
    this.registry.release(canonical);
    if (this.registry.get(canonical)) return;
    doc.dispose();
    this.docs.delete(canonical);
    for (const [alias, target] of this.aliases) if (target === canonical) this.aliases.delete(alias);
    if (!this.closed) void this.request('close', { path: canonical }).catch(() => {});
  }

  /** Canonical docId for a path previously passed to openDoc(). */
  canonicalPath(path: string): string | undefined {
    return this.aliases.get(normalizeDocPath(path));
  }

  stat(path: string): Promise<FileStatResult> {
    return this.request('stat', { path: normalizeDocPath(path) });
  }

  async list(path: string): Promise<Array<[string, FileKind]>> {
    return (await this.request('list', { path: normalizeDocPath(path) })).entries;
  }

  async read(path: string): Promise<Uint8Array> {
    return Buffer.from((await this.request('read', { path: normalizeDocPath(path) })).base64, 'base64');
  }

  async save(path: string): Promise<void> {
    const canonical = this.aliases.get(normalizeDocPath(path)) ?? normalizeDocPath(path);
    await this.request('save', { path: canonical });
  }

  onDidClose(listener: (reason: string) => void): Disposable {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  onDidNotify(listener: (n: NotifyPayload) => void): Disposable {
    this.notifyListeners.add(listener);
    return { dispose: () => this.notifyListeners.delete(listener) };
  }

  dispose(): void {
    if (!this.closed) this.ws.close(1000, 'guest left');
    this.onClose('guest left');
  }

  private request<M extends RequestMethod>(method: M, params: RequestMap[M]['params']): Promise<RequestMap[M]['result']> {
    if (this.closed) return Promise.reject(new RemoteError('closed', 'session is closed'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve: resolve as (r: unknown) => void, reject });
      this.send(jsonFrame(MsgType.Request, { id, method, params }));
    });
  }

  private send(frame: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  private onMessage(data: Uint8Array): void {
    try {
      const frame = decodeFrame(data);
      switch (frame.type) {
        case MsgType.Sync: {
          const doc = this.docs.get(frame.docId);
          if (!doc) return;
          const decoder = decoding.createDecoder(frame.payload);
          const encoder = encoding.createEncoder();
          const kind = syncProtocol.readSyncMessage(decoder, encoder, doc.entry.doc, this);
          if (encoding.length(encoder) > 0) {
            this.send(encodeFrame(MsgType.Sync, frame.docId, encoding.toUint8Array(encoder)));
          }
          if (kind === syncProtocol.messageYjsSyncStep2) doc.markSynced();
          return;
        }
        case MsgType.Response: {
          const res = decodeJson<ResponsePayload>(frame.payload);
          const pending = this.requests.get(res.id);
          if (!pending) return;
          this.requests.delete(res.id);
          if (res.error) pending.reject(new RemoteError(res.error.code, res.error.message));
          else pending.resolve(res.result);
          return;
        }
        case MsgType.Notify: {
          const n = decodeJson<NotifyPayload>(frame.payload);
          for (const l of this.notifyListeners) l(n);
          return;
        }
        case MsgType.Awareness:
          awarenessProtocol.applyAwarenessUpdate(this.registry.awareness, frame.payload, this);
          return;
        default:
          this.log(`ignoring unexpected message type ${frame.type}`);
      }
    } catch (err) {
      this.log(`bad message from host: ${String(err)}`);
    }
  }

  private onClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.requests.values()) p.reject(new RemoteError('closed', 'session closed'));
    this.requests.clear();
    for (const doc of this.docs.values()) doc.dispose();
    this.docs.clear();
    const awareness = this.registry.awareness;
    awareness.off('update', this.onAwarenessUpdate);
    const remote = [...awareness.getStates().keys()].filter((id) => id !== awareness.clientID);
    awarenessProtocol.removeAwarenessStates(awareness, remote, 'disconnect');
    for (const l of this.closeListeners) l(reason);
  }
}

import { timingSafeEqual } from 'node:crypto';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import {
  decodeFrame,
  decodeJson,
  encodeFrame,
  jsonFrame,
  MAX_FRAME_BYTES,
  MsgType,
  PROTOCOL_VERSION,
  ProtocolError,
  RemoteError,
  type FileKind,
  type FileStatResult,
  type HelloPayload,
  type NotifyPayload,
  type RejectPayload,
  type RequestPayload,
  type ResponsePayload,
  type TreeResult,
  type WelcomePayload,
} from '../protocol';
import type { Disposable } from '../sync/document';
import type { DocEntry } from '../sync/DocRegistry';

/** Host-side document access used by the server; implemented over vscode by HostDocuments. */
export interface HostDocs {
  /**
   * Validates the guest-supplied path, loads the file and takes one reference.
   * The returned entry.path is the canonical docId (symbolic links resolved).
   * Throws RemoteError for invalid, missing, binary or too large files.
   */
  open(path: string): Promise<DocEntry>;
  /** Drops a reference taken by open(). */
  close(path: string): void;
  /** Writes the document to disk. */
  save(path: string): Promise<void>;
  stat(path: string): Promise<FileStatResult>;
  list(path: string): Promise<Array<[string, FileKind]>>;
  /** Raw bytes of a file as saved on disk. */
  read(path: string): Promise<Uint8Array>;
  /** Files and folders below a folder, recursively. */
  tree(path: string): Promise<TreeResult>;
}

export interface SessionServerOptions {
  /** 0 picks a free port. */
  port: number;
  host?: string;
  pin: string;
  sessionId: string;
  hostName: string;
  rootName: string;
  docs: HostDocs;
  /** Session presence; the host's own state is set on it by RemoteCursors. */
  awareness: awarenessProtocol.Awareness;
  log?: (message: string) => void;
  maxPinAttempts?: number;
  helloTimeoutMs?: number;
  /** Ping interval; a guest that misses two pings is dropped. Default 10 s. */
  heartbeatMs?: number;
}

export interface GuestInfo {
  id: number;
  name: string;
  color: string;
  address: string;
}

export function toUint8(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function pinMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isHello(value: unknown): value is HelloPayload {
  const v = value as HelloPayload;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.protocol === 'number' &&
    typeof v.pin === 'string' &&
    typeof v.name === 'string' &&
    typeof v.color === 'string'
  );
}

class GuestConnection {
  /** Canonical docIds this guest has opened. */
  readonly docs = new Set<string>();
  /** Awareness client ids announced over this connection. */
  readonly awarenessIds = new Set<number>();

  constructor(
    readonly info: GuestInfo,
    private readonly ws: WebSocket,
  ) {}

  send(frame: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }
}

interface SharedDoc {
  entry: DocEntry;
  subscribers: Set<GuestConnection>;
  dispose: () => void;
}

/**
 * WebSocket server embedded in the host's extension. A guest must send a Hello
 * with the session PIN as its first frame; nothing else is sent before that.
 * After 5 wrong PINs the remote address is blocked for the session.
 */
export class SessionServer implements Disposable {
  private readonly connections = new Set<GuestConnection>();
  private readonly failures = new Map<string, number>();
  private readonly shared = new Map<string, SharedDoc>();
  private readonly guestListeners = new Set<() => void>();
  private nextGuestId = 1;
  private readonly log: (message: string) => void;
  private readonly maxPinAttempts: number;
  private readonly alive = new WeakSet<WebSocket>();
  private readonly heartbeat: ReturnType<typeof setInterval>;

  static start(options: SessionServerOptions): Promise<SessionServer> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: options.host ?? '0.0.0.0',
        port: options.port,
        maxPayload: MAX_FRAME_BYTES,
      });
      wss.once('listening', () => resolve(new SessionServer(wss, options)));
      wss.once('error', reject);
    });
  }

  private constructor(
    private readonly wss: WebSocketServer,
    private readonly options: SessionServerOptions,
  ) {
    this.log = options.log ?? (() => {});
    this.maxPinAttempts = options.maxPinAttempts ?? 5;
    wss.on('connection', (ws, req) => this.accept(ws, req.socket.remoteAddress ?? 'unknown'));
    wss.on('error', (err) => this.log(`server error: ${err.message}`));
    options.awareness.on('update', this.onAwarenessUpdate);
    // Detect guests that vanished without closing (Wi-Fi drop, sleep).
    this.heartbeat = setInterval(() => {
      for (const ws of wss.clients) {
        if (!this.alive.has(ws)) {
          ws.terminate();
          continue;
        }
        this.alive.delete(ws);
        ws.ping();
      }
    }, options.heartbeatMs ?? 10_000);
  }

  private readonly onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin instanceof GuestConnection) {
      for (const id of [...changes.added, ...changes.updated]) origin.awarenessIds.add(id);
      for (const id of changes.removed) origin.awarenessIds.delete(id);
    }
    const changed = [...changes.added, ...changes.updated, ...changes.removed];
    const frame = encodeFrame(
      MsgType.Awareness,
      '',
      awarenessProtocol.encodeAwarenessUpdate(this.options.awareness, changed),
    );
    for (const c of this.connections) if (c !== origin) c.send(frame);
  };

  get port(): number {
    const address = this.wss.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  get guests(): GuestInfo[] {
    return [...this.connections].map((c) => c.info);
  }

  onDidChangeGuests(listener: () => void): Disposable {
    this.guestListeners.add(listener);
    return { dispose: () => this.guestListeners.delete(listener) };
  }

  /** Test hook: cuts every guest connection as a network failure would. */
  simulateNetworkDrop(): void {
    for (const ws of this.wss.clients) ws.terminate();
  }

  dispose(): void {
    clearInterval(this.heartbeat);
    this.options.awareness.off('update', this.onAwarenessUpdate);
    for (const c of this.connections) c.close(1001, 'session ended');
    for (const ws of this.wss.clients) ws.terminate();
    for (const conn of [...this.connections]) this.drop(conn);
    this.wss.close();
  }

  private reject(ws: WebSocket, payload: RejectPayload): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(jsonFrame(MsgType.Reject, payload));
    ws.close(4000 + ['pin', 'blocked', 'version', 'timeout', 'protocol'].indexOf(payload.code), payload.code);
  }

  private accept(ws: WebSocket, address: string): void {
    this.alive.add(ws);
    ws.on('pong', () => this.alive.add(ws));
    if ((this.failures.get(address) ?? 0) >= this.maxPinAttempts) {
      this.log(`refused blocked address ${address}`);
      this.reject(ws, { code: 'blocked', message: 'Too many wrong PINs; ask the host to start a new session.' });
      return;
    }
    const timer = setTimeout(
      () => this.reject(ws, { code: 'timeout', message: 'No handshake received.' }),
      this.options.helloTimeoutMs ?? 10_000,
    );
    ws.once('message', (data) => {
      clearTimeout(timer);
      this.handleHello(ws, address, toUint8(data));
    });
    ws.once('close', () => clearTimeout(timer));
    ws.on('error', (err) => this.log(`connection error from ${address}: ${err.message}`));
  }

  private handleHello(ws: WebSocket, address: string, data: Uint8Array): void {
    let hello: unknown;
    try {
      const frame = decodeFrame(data);
      if (frame.type !== MsgType.Hello) throw new ProtocolError('expected Hello');
      hello = decodeJson(frame.payload);
      if (!isHello(hello)) throw new ProtocolError('invalid Hello');
    } catch (err) {
      this.reject(ws, { code: 'protocol', message: String(err instanceof Error ? err.message : err) });
      return;
    }
    if (hello.protocol !== PROTOCOL_VERSION) {
      this.reject(ws, {
        code: 'version',
        message: `Protocol mismatch: host speaks v${PROTOCOL_VERSION}, guest v${hello.protocol}. Install the same LanPair version on both machines.`,
      });
      return;
    }
    if (!pinMatches(this.options.pin, hello.pin)) {
      const failures = (this.failures.get(address) ?? 0) + 1;
      this.failures.set(address, failures);
      const attemptsLeft = Math.max(0, this.maxPinAttempts - failures);
      this.log(`wrong PIN from ${address} (${attemptsLeft} attempts left)`);
      this.reject(ws, {
        code: attemptsLeft > 0 ? 'pin' : 'blocked',
        message: attemptsLeft > 0 ? 'Wrong PIN.' : 'Too many wrong PINs; ask the host to start a new session.',
        attemptsLeft,
      });
      return;
    }

    this.failures.delete(address);
    const info: GuestInfo = {
      id: this.nextGuestId++,
      name: hello.name.slice(0, 64) || 'Guest',
      color: hello.color.slice(0, 32),
      address,
    };
    const conn = new GuestConnection(info, ws);
    this.connections.add(conn);
    const welcome: WelcomePayload = {
      protocol: PROTOCOL_VERSION,
      sessionId: this.options.sessionId,
      hostName: this.options.hostName,
      rootName: this.options.rootName,
    };
    conn.send(jsonFrame(MsgType.Welcome, welcome));
    const known = [...this.options.awareness.getStates().keys()];
    if (known.length > 0) {
      conn.send(encodeFrame(MsgType.Awareness, '', awarenessProtocol.encodeAwarenessUpdate(this.options.awareness, known)));
    }
    ws.on('message', (d) => this.onMessage(conn, toUint8(d)));
    ws.on('close', () => this.drop(conn));
    this.log(`guest "${info.name}" joined from ${address}`);
    this.emitGuests();
  }

  private onMessage(conn: GuestConnection, data: Uint8Array): void {
    try {
      const frame = decodeFrame(data);
      switch (frame.type) {
        case MsgType.Sync:
          this.handleSync(conn, frame.docId, frame.payload);
          break;
        case MsgType.Request:
          void this.handleRequest(conn, decodeJson<RequestPayload>(frame.payload));
          break;
        case MsgType.Awareness:
          awarenessProtocol.applyAwarenessUpdate(this.options.awareness, frame.payload, conn);
          break;
        default:
          throw new ProtocolError(`unexpected message type ${frame.type}`);
      }
    } catch (err) {
      this.log(`protocol error from "${conn.info.name}": ${String(err)}`);
      conn.close(1002, 'protocol error');
    }
  }

  private handleSync(conn: GuestConnection, docId: string, payload: Uint8Array): void {
    const shared = this.shared.get(docId);
    if (!shared || !conn.docs.has(docId)) return; // not opened (or already closed): ignore
    const decoder = decoding.createDecoder(payload);
    const encoder = encoding.createEncoder();
    syncProtocol.readSyncMessage(decoder, encoder, shared.entry.doc, conn);
    if (encoding.length(encoder) > 0) conn.send(encodeFrame(MsgType.Sync, docId, encoding.toUint8Array(encoder)));
  }

  private async handleRequest(conn: GuestConnection, req: RequestPayload): Promise<void> {
    const respond = (response: Omit<ResponsePayload, 'id'>) =>
      conn.send(jsonFrame(MsgType.Response, { id: req.id, ...response }));
    try {
      const params = (req.params ?? {}) as { path?: unknown };
      if (typeof params.path !== 'string') throw new RemoteError('invalid-params', 'path is required');
      switch (req.method) {
        case 'open': {
          const entry = await this.options.docs.open(params.path);
          if (!this.connections.has(conn)) {
            this.options.docs.close(entry.path); // guest left while loading
            return;
          }
          if (conn.docs.has(entry.path)) {
            this.options.docs.close(entry.path); // keep one reference per guest
          } else {
            conn.docs.add(entry.path);
            this.subscribe(conn, entry);
          }
          respond({ result: { path: entry.path, epoch: entry.doc.guid } });
          // Ask for anything the guest has that we lack (e.g. edits made offline).
          const encoder = encoding.createEncoder();
          syncProtocol.writeSyncStep1(encoder, entry.doc);
          conn.send(encodeFrame(MsgType.Sync, entry.path, encoding.toUint8Array(encoder)));
          return;
        }
        case 'close':
          if (conn.docs.delete(params.path)) {
            this.unsubscribe(conn, params.path);
            this.options.docs.close(params.path);
          }
          respond({ result: {} });
          return;
        case 'save': {
          if (!conn.docs.has(params.path)) throw new RemoteError('not-open', 'file is not open');
          await this.options.docs.save(params.path);
          respond({ result: {} });
          this.notify(params.path, { event: 'saved', path: params.path });
          return;
        }
        case 'stat':
          respond({ result: await this.options.docs.stat(params.path) });
          return;
        case 'list':
          respond({ result: { entries: await this.options.docs.list(params.path) } });
          return;
        case 'read':
          respond({ result: { base64: Buffer.from(await this.options.docs.read(params.path)).toString('base64') } });
          return;
        case 'tree':
          respond({ result: await this.options.docs.tree(params.path) });
          return;
        default:
          throw new RemoteError('unknown-method', `unknown method ${String(req.method)}`);
      }
    } catch (err) {
      const code = err instanceof RemoteError ? err.code : 'internal';
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'internal') this.log(`request ${req.method} failed: ${message}`);
      respond({ error: { code, message } });
    }
  }

  /** Sends a notification to every guest that has `path` open. */
  notify(path: string, payload: NotifyPayload): void {
    const frame = jsonFrame(MsgType.Notify, payload);
    for (const c of this.shared.get(path)?.subscribers ?? []) c.send(frame);
  }

  /** Sends a notification to every guest. */
  notifyAll(payload: NotifyPayload): void {
    const frame = jsonFrame(MsgType.Notify, payload);
    for (const c of this.connections) c.send(frame);
  }

  private subscribe(conn: GuestConnection, entry: DocEntry): void {
    let shared = this.shared.get(entry.path);
    if (!shared) {
      const subscribers = new Set<GuestConnection>();
      const onUpdate = (update: Uint8Array, origin: unknown) => {
        const encoder = encoding.createEncoder();
        syncProtocol.writeUpdate(encoder, update);
        const frame = encodeFrame(MsgType.Sync, entry.path, encoding.toUint8Array(encoder));
        // Forward to every guest except the one the update came from.
        for (const s of subscribers) if (s !== origin) s.send(frame);
      };
      entry.doc.on('update', onUpdate);
      shared = { entry, subscribers, dispose: () => entry.doc.off('update', onUpdate) };
      this.shared.set(entry.path, shared);
    }
    shared.subscribers.add(conn);
  }

  private unsubscribe(conn: GuestConnection, path: string): void {
    const shared = this.shared.get(path);
    if (!shared) return;
    shared.subscribers.delete(conn);
    if (shared.subscribers.size === 0) {
      shared.dispose();
      this.shared.delete(path);
    }
  }

  private drop(conn: GuestConnection): void {
    if (!this.connections.delete(conn)) return;
    for (const path of conn.docs) {
      this.unsubscribe(conn, path);
      this.options.docs.close(path);
    }
    conn.docs.clear();
    awarenessProtocol.removeAwarenessStates(this.options.awareness, [...conn.awarenessIds], 'disconnect');
    this.log(`guest "${conn.info.name}" left`);
    this.emitGuests();
  }

  private emitGuests(): void {
    for (const l of this.guestListeners) l();
  }
}

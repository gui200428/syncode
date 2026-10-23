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
  /** Reconnection delays in ms; the last one repeats. Default 1s → 10s. */
  backoffMs?: readonly number[];
  /** Without a ping from the host for this long, the connection is considered dead. */
  deadAfterMs?: number;
}

export type ConnectionState = 'connected' | 'reconnecting';

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface OpenDoc {
  entry: DocEntry;
  epoch: string;
  synced: Promise<void>;
  markSynced: () => void;
  dispose: () => void;
}

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000, 10000];
/** Close codes after which reconnecting is pointless (left, session ended, rejected). */
const FINAL_CLOSE_CODES = new Set([1000, 1001, 4000, 4001, 4002]);

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

interface Handshake {
  ws: WebSocket;
  welcome: WelcomePayload;
  /** Frames received after the Welcome, before the client attached its handler. */
  takeBuffered: () => Uint8Array[];
}

/** Opens a WebSocket and performs the Hello/Welcome handshake. */
function handshake(options: SessionClientOptions): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const url = `ws://${formatHost(options.host)}:${options.port}`;
    const ws = new WebSocket(url, { maxPayload: MAX_FRAME_BYTES, handshakeTimeout: options.timeoutMs ?? 5000 });
    let settled = false;
    const fail = (err: JoinError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      const hello: HelloPayload = { protocol: PROTOCOL_VERSION, pin: options.pin, name: options.name, color: options.color };
      ws.send(jsonFrame(MsgType.Hello, hello));
    });
    ws.once('message', (data) => {
      try {
        const frame = decodeFrame(toUint8(data));
        if (frame.type === MsgType.Reject) {
          const r = decodeJson<RejectPayload>(frame.payload);
          fail(new JoinError(r.code, r.message, r.attemptsLeft));
        } else if (frame.type === MsgType.Welcome) {
          settled = true;
          clearTimeout(timer);
          // The next frames can arrive in the same tick; keep them for attach().
          const buffered: Uint8Array[] = [];
          const buffer = (d: Parameters<typeof toUint8>[0]) => buffered.push(toUint8(d));
          ws.on('message', buffer);
          const takeBuffered = () => {
            ws.off('message', buffer);
            return buffered;
          };
          resolve({ ws, welcome: decodeJson<WelcomePayload>(frame.payload), takeBuffered });
        } else {
          fail(new JoinError('protocol', 'Unexpected first message from host.'));
        }
      } catch (err) {
        fail(new JoinError('protocol', String(err)));
      }
    });
    ws.once('error', (err) => fail(new JoinError('network', `Cannot connect to ${url}: ${err.message}`)));
    ws.once('close', () => fail(new JoinError('network', `Connection to ${url} closed during handshake.`)));
  });
}

/**
 * Guest side of a session: one WebSocket multiplexing every open file.
 * If the connection drops, it reconnects with backoff, reopens the documents
 * and re-runs the Yjs sync handshake, which merges edits made meanwhile on
 * either side. It only gives up when the host ended the session.
 */
export class SessionClient implements Disposable {
  readonly registry = new DocRegistry();
  private ws: WebSocket;
  private readonly requests = new Map<number, PendingRequest>();
  private readonly docs = new Map<string, OpenDoc>();
  /** Requested path → canonical docId returned by the host. */
  private readonly aliases = new Map<string, string>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private readonly notifyListeners = new Set<(n: NotifyPayload) => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private nextRequestId = 1;
  private closed = false;
  private connected = true;
  private lastPing = Date.now();
  private readonly watchdog: ReturnType<typeof setInterval>;
  private readonly log: (message: string) => void;

  static async connect(options: SessionClientOptions): Promise<SessionClient> {
    return new SessionClient(await handshake(options), options);
  }

  readonly welcome: WelcomePayload;

  private constructor(
    first: Handshake,
    private readonly options: SessionClientOptions,
  ) {
    this.log = options.log ?? (() => {});
    this.ws = first.ws;
    this.welcome = first.welcome;
    this.registry.awareness.on('update', this.onAwarenessUpdate);
    this.attach(first);
    const deadAfter = options.deadAfterMs ?? 25_000;
    this.watchdog = setInterval(() => {
      if (this.connected && Date.now() - this.lastPing > deadAfter) {
        this.log(`no heartbeat from host for ${Math.round(deadAfter / 1000)}s; reconnecting`);
        this.ws.terminate();
      }
    }, Math.min(5000, deadAfter / 2));
  }

  /** False once the session is over (left, host stopped, or rejected on reconnect). */
  get isOpen(): boolean {
    return !this.closed;
  }

  /** False while reconnecting. */
  get isConnected(): boolean {
    return this.connected && !this.closed;
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
    const { path: canonical, epoch } = await this.request('open', { path: requested });
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
    doc = { entry, epoch, synced, markSynced, dispose: () => entry.doc.off('update', onUpdate) };
    this.docs.set(canonical, doc);
    this.sendSyncStep1(canonical, entry);
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
    if (this.isConnected) void this.request('close', { path: canonical }).catch(() => {});
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

  onDidChangeState(listener: (state: ConnectionState) => void): Disposable {
    this.stateListeners.add(listener);
    return { dispose: () => this.stateListeners.delete(listener) };
  }

  /** Test hook: drops the socket as a network failure would. */
  simulateNetworkDrop(): void {
    this.ws.terminate();
  }

  dispose(): void {
    if (!this.closed && this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'guest left');
    this.finish('guest left');
  }

  private attach({ ws, takeBuffered }: Handshake): void {
    this.lastPing = Date.now();
    ws.on('message', (data) => this.onMessage(toUint8(data)));
    for (const frame of takeBuffered()) this.onMessage(frame);
    ws.on('ping', () => (this.lastPing = Date.now()));
    ws.on('close', (code, reason) => {
      if (ws === this.ws) this.onDisconnect(code, reason.toString());
    });
    ws.on('error', (err) => this.log(`connection error: ${err.message}`));
  }

  private onDisconnect(code: number, reason: string): void {
    if (this.closed) return;
    if (FINAL_CLOSE_CODES.has(code)) {
      this.finish(`${code} ${reason}`.trim());
      return;
    }
    this.log(`connection lost (${code}${reason ? ` ${reason}` : ''}); reconnecting`);
    this.setConnected(false);
    for (const p of this.requests.values()) p.reject(new RemoteError('closed', 'connection lost'));
    this.requests.clear();
    // Other participants' cursors are stale until the host sends them again.
    // Forget them (instead of removeAwarenessStates, which bumps their clocks)
    // so the states the host resends after reconnecting are accepted.
    const awareness = this.registry.awareness;
    const remote = [...awareness.getStates().keys()].filter((id) => id !== awareness.clientID);
    for (const id of remote) {
      awareness.states.delete(id);
      awareness.meta.delete(id);
    }
    if (remote.length > 0) awareness.emit('change', [{ added: [], updated: [], removed: remote }, this]);
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    const delays = this.options.backoffMs ?? DEFAULT_BACKOFF;
    for (let attempt = 0; !this.closed; attempt++) {
      await new Promise((r) => setTimeout(r, delays[Math.min(attempt, delays.length - 1)]));
      if (this.closed) return;
      let result: Handshake;
      try {
        result = await handshake(this.options);
      } catch (err) {
        if (err instanceof JoinError && err.code !== 'network' && err.code !== 'timeout') {
          this.finish(`host refused to reconnect: ${err.message}`);
          return;
        }
        this.log(`reconnect attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (result.welcome.sessionId !== this.welcome.sessionId) {
        result.ws.close(1000, 'session changed');
        this.finish('the host started a new session');
        return;
      }
      if (this.closed) {
        result.ws.close(1000, 'guest left');
        return;
      }
      this.ws = result.ws;
      this.attach(result);
      try {
        await this.resync();
      } catch (err) {
        if (this.closed) return;
        this.log(`resync failed: ${err instanceof Error ? err.message : String(err)}`);
        result.ws.terminate(); // triggers another reconnect
        return;
      }
      this.log(`reconnected after ${attempt + 1} attempt(s)`);
      this.setConnected(true);
      return;
    }
  }

  /** Reopens every document and exchanges sync steps, merging offline edits both ways. */
  private async resync(): Promise<void> {
    for (const [path, doc] of this.docs) {
      const { epoch } = await this.request('open', { path });
      if (epoch !== doc.epoch) {
        // The host recreated the document; merging would duplicate content.
        this.finish(`document ${path} was recreated by the host`);
        throw new Error('session ended');
      }
      this.sendSyncStep1(path, doc.entry);
    }
    // When we dropped, the host (and other guests) removed our state, which
    // bumped our clock there by one. Re-publish twice so ours is newer.
    const awareness = this.registry.awareness;
    const state = awareness.getLocalState();
    if (state !== null) {
      awareness.setLocalState({ ...state });
      awareness.setLocalState({ ...state });
    }
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const l of this.stateListeners) l(connected ? 'connected' : 'reconnecting');
  }

  private sendSyncStep1(path: string, entry: DocEntry): void {
    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, entry.doc);
    this.send(encodeFrame(MsgType.Sync, path, encoding.toUint8Array(encoder)));
  }

  private readonly onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this) return; // came from the host
    const changed = [...changes.added, ...changes.updated, ...changes.removed];
    this.send(encodeFrame(MsgType.Awareness, '', awarenessProtocol.encodeAwarenessUpdate(this.registry.awareness, changed)));
  };

  private request<M extends RequestMethod>(method: M, params: RequestMap[M]['params']): Promise<RequestMap[M]['result']> {
    if (this.closed) return Promise.reject(new RemoteError('closed', 'session is closed'));
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new RemoteError('closed', 'reconnecting to the host'));
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

  private finish(reason: string): void {
    if (this.closed) return;
    this.log(`session closed: ${reason}`);
    this.closed = true;
    this.connected = false;
    clearInterval(this.watchdog);
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

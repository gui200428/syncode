import * as Y from 'yjs';
import { normalizeEol, NormalizedDocument, type Eol } from '../../src/sync/document';
import { EditorBinding } from '../../src/sync/EditorBinding';
import { FakeRawDocument } from './FakeRawDocument';

const NET = Symbol('net');

/** Bidirectional in-memory link between two Y.Docs; `manual` queues updates until deliver(). */
export class Link {
  private readonly queues = new Map<Y.Doc, Uint8Array[]>();

  constructor(
    private readonly a: Y.Doc,
    private readonly b: Y.Doc,
    private readonly manual = false,
  ) {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), NET);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b), NET);
    this.wire(a, b);
    this.wire(b, a);
  }

  get queued(): number {
    return (this.queues.get(this.a)?.length ?? 0) + (this.queues.get(this.b)?.length ?? 0);
  }

  /** Delivers queued updates; `to` limits delivery to one side. */
  deliver(to?: Y.Doc): void {
    for (const [target, queue] of this.queues) {
      if (to && target !== to) continue;
      for (const u of queue.splice(0)) Y.applyUpdate(target, u, NET);
    }
  }

  private wire(from: Y.Doc, to: Y.Doc): void {
    const queue: Uint8Array[] = [];
    this.queues.set(to, queue);
    from.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === NET) return;
      if (this.manual) queue.push(update);
      else Y.applyUpdate(to, update, NET);
    });
  }
}

/** Host with `hostText` plus a guest joined over a link; settles before returning. */
export async function createPair(
  hostText: string,
  opts: { hostEol?: Eol; guestEol?: Eol; manual?: boolean } = {},
): Promise<{ host: Peer; guest: Peer; link: Link }> {
  const host = createPeer(hostText, { eol: opts.hostEol, manual: opts.manual });
  const guestDoc = new Y.Doc();
  const link = new Link(host.ydoc, guestDoc, opts.manual);
  const guest = createPeer('', { eol: opts.guestEol, manual: opts.manual, ydoc: guestDoc });
  await settle([host, guest], link);
  return { host, guest, link };
}

export interface Peer {
  ydoc: Y.Doc;
  raw: FakeRawDocument;
  binding: EditorBinding;
  logs: string[];
  /** LF-normalized editor text. */
  text(): string;
  ytext(): string;
}

export function createPeer(
  initial: string,
  opts: { eol?: Eol; manual?: boolean; ydoc?: Y.Doc } = {},
): Peer {
  // Without a given Y.Doc this peer acts as host: the Y.Text is seeded from the editor.
  const ydoc = opts.ydoc ?? new Y.Doc();
  if (!opts.ydoc) ydoc.getText('content').insert(0, normalizeEol(initial));
  const raw = new FakeRawDocument(initial, opts.eol ?? '\n', { manual: opts.manual });
  const logs: string[] = [];
  const binding = new EditorBinding(ydoc.getText('content'), new NormalizedDocument(raw), {
    log: (m) => logs.push(m),
  });
  return {
    ydoc,
    raw,
    binding,
    logs,
    text: () => normalizeEol(raw.getText()),
    ytext: () => ydoc.getText('content').toString(),
  };
}

export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Runs network, editors and microtasks until everything is quiescent. */
export async function settle(peers: readonly Peer[], link?: Link): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    link?.deliver();
    for (const p of peers) p.raw.releaseAll();
    await tick();
    const busy =
      (link?.queued ?? 0) > 0 || peers.some((p) => p.raw.pendingApplies > 0 || !p.binding.isIdle);
    if (!busy) return;
  }
  throw new Error('did not settle');
}

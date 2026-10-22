import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { diffText, toEdits } from './delta';
import { normalizeEol, type Disposable } from './document';

/** Name of the shared Y.Text inside each file's Y.Doc. */
export const TEXT_KEY = 'content';

/** Transaction origin for content loaded from or detected on disk. */
export const DISK_ORIGIN = Symbol('lanpair-disk');

export interface DocEntry {
  readonly path: string;
  readonly doc: Y.Doc;
  readonly text: Y.Text;
}

interface Slot extends DocEntry {
  refs: number;
}

type Listener = (entry: DocEntry) => void;

/** Normalizes a workspace-relative path to `a/b/c` form; used as the docId. */
export function normalizeDocPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').replace(/\/{2,}/g, '/');
}

/**
 * Owns one Y.Doc per shared file (loaded on demand, reference counted) plus a
 * single session-wide Awareness for presence (name, color, file, selections).
 */
export class DocRegistry implements Disposable {
  /** Y.Doc that only exists to give the session Awareness a client id. */
  readonly presenceDoc = new Y.Doc();
  readonly awareness = new Awareness(this.presenceDoc);

  private readonly slots = new Map<string, Slot>();
  private readonly addListeners = new Set<Listener>();
  private readonly removeListeners = new Set<Listener>();

  /**
   * Returns the entry for `path`, creating it if needed. `initialText` is only
   * called on creation; the host passes the unsaved TextDocument text if the
   * file is open, otherwise the disk contents. Guests pass nothing and receive
   * the content through Yjs sync.
   */
  acquire(path: string, initialText?: () => string): DocEntry {
    const key = normalizeDocPath(path);
    let slot = this.slots.get(key);
    if (!slot) {
      const doc = new Y.Doc();
      const text = doc.getText(TEXT_KEY);
      const initial = initialText?.();
      if (initial) doc.transact(() => text.insert(0, normalizeEol(initial)), DISK_ORIGIN);
      slot = { path: key, doc, text, refs: 0 };
      this.slots.set(key, slot);
      for (const l of this.addListeners) l(slot);
    }
    slot.refs++;
    return slot;
  }

  /** Drops one reference; the Y.Doc is destroyed when none remain. */
  release(path: string): void {
    const key = normalizeDocPath(path);
    const slot = this.slots.get(key);
    if (!slot || --slot.refs > 0) return;
    this.slots.delete(key);
    for (const l of this.removeListeners) l(slot);
    slot.doc.destroy();
  }

  get(path: string): DocEntry | undefined {
    return this.slots.get(normalizeDocPath(path));
  }

  paths(): string[] {
    return [...this.slots.keys()];
  }

  /**
   * Applies text that changed outside the session (git checkout, external
   * formatter) as a minimal diff, so remote cursors outside the changed region
   * survive. Returns false if the content was already identical.
   */
  applyExternalText(path: string, newText: string): boolean {
    const slot = this.slots.get(normalizeDocPath(path));
    if (!slot) return false;
    const current = slot.text.toString();
    const target = normalizeEol(newText);
    const edits = toEdits(diffText(current, target));
    if (edits.length === 0) return false;
    slot.doc.transact(() => {
      for (const e of edits.reverse()) {
        if (e.length > 0) slot.text.delete(e.offset, e.length);
        if (e.text.length > 0) slot.text.insert(e.offset, e.text);
      }
    }, DISK_ORIGIN);
    return true;
  }

  onDidAdd(listener: Listener): Disposable {
    this.addListeners.add(listener);
    return { dispose: () => this.addListeners.delete(listener) };
  }

  onDidRemove(listener: Listener): Disposable {
    this.removeListeners.add(listener);
    return { dispose: () => this.removeListeners.delete(listener) };
  }

  dispose(): void {
    for (const slot of this.slots.values()) {
      for (const l of this.removeListeners) l(slot);
      slot.doc.destroy();
    }
    this.slots.clear();
    this.awareness.destroy();
    this.presenceDoc.destroy();
    this.addListeners.clear();
    this.removeListeners.clear();
  }
}

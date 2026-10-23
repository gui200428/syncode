import * as Y from 'yjs';
import {
  applyDelta,
  compose,
  type Delta,
  diffText,
  fromEdits,
  fromYDelta,
  isIdentity,
  toEdits,
  transform,
} from './delta';
import type { BindableDocument, Disposable } from './document';

/** Transaction origin for edits made in this editor. Remote/disk edits use other origins. */
export const LOCAL_ORIGIN = Symbol('lanpair-local');

interface InFlight {
  /** Delta sent to the editor, in coordinates of the document at send time. */
  readonly delta: Delta;
  /** Normalized document text if the edit applies cleanly. */
  readonly expected: string;
  echoSeen: boolean;
  /** A local edit reached the document first, so this edit is going to be rejected. */
  superseded: boolean;
  resolved: boolean;
}

export interface EditorBindingOptions {
  log?: (message: string) => void;
}

/**
 * Two-way binding between an editor document and a Y.Text.
 *
 * Invariant: `ytext === applyDelta(document.getText(), pending)` (with any
 * in-flight edit composed in front of `pending` until its echo is seen).
 *
 * - Remote Y.Text changes are composed into `pending` and flushed to the editor
 *   as one edit at a time (the editor's applyEdit is asynchronous).
 * - Local editor changes are pushed to the Y.Text immediately, transformed
 *   through `pending` so they land at the right place even while remote
 *   changes have not reached the editor yet. `pending` is transformed the
 *   other way, so no change is ever lost or duplicated.
 * - The echo of our own applyEdit is recognized by comparing the document text
 *   with the text we expect after the edit. If a local change arrives first,
 *   the editor rejects our edit (version check) and it is folded back into
 *   `pending` and retried.
 */
export class EditorBinding implements Disposable {
  private pending: Delta = [];
  private inFlight: InFlight | undefined;
  private scheduled = false;
  private disposed = false;
  private failures = 0;
  private readonly subscriptions: Disposable[] = [];
  private readonly log: (message: string) => void;

  constructor(
    readonly ytext: Y.Text,
    private readonly document: BindableDocument,
    options: EditorBindingOptions = {},
  ) {
    this.log = options.log ?? (() => {});
    this.pending = diffText(document.getText(), ytext.toString());

    const observer = (event: Y.YTextEvent, tr: Y.Transaction) => this.onRemote(event, tr);
    ytext.observe(observer);
    this.subscriptions.push({ dispose: () => ytext.unobserve(observer) });
    this.subscriptions.push(
      document.onDidChange((changes) => {
        try {
          this.onLocal(changes);
        } catch (err) {
          this.log(`local change handler threw: ${err instanceof Error ? err.stack : String(err)} changes=${JSON.stringify(changes)}`);
          this.recover('local change could not be processed');
          this.schedule();
        }
      }),
    );
    this.schedule();
  }

  /** True when the editor and the Y.Text are known to hold the same text. */
  get isIdle(): boolean {
    return !this.inFlight && !this.scheduled && isIdentity(this.pending);
  }

  /** Verifies the invariant; used by tests and as a safety net. */
  isConsistent(): boolean {
    const f = this.inFlight;
    const mapping = f && !f.echoSeen && !f.superseded ? compose(f.delta, this.pending) : this.pending;
    return applyDelta(this.document.getText(), mapping) === this.ytext.toString();
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.subscriptions.splice(0)) s.dispose();
  }

  private onRemote(event: Y.YTextEvent, tr: Y.Transaction): void {
    if (tr.origin === LOCAL_ORIGIN || this.disposed) return;
    this.pending = compose(this.pending, fromYDelta(event.delta));
    this.schedule();
  }

  private onLocal(changes: readonly { offset: number; length: number; text: string }[]): void {
    if (this.disposed || changes.length === 0) return;

    const f = this.inFlight;
    if (f && !f.echoSeen && !f.superseded) {
      if (this.document.getText() === f.expected) {
        // Echo of our own applyEdit.
        f.echoSeen = true;
        if (f.resolved) this.settle();
        return;
      }
      // The user edited before our edit was applied; it will be rejected.
      f.superseded = true;
      this.pending = compose(f.delta, this.pending);
    }

    const local = fromEdits(changes);
    const toY = transform(this.pending, local, true);
    this.pending = transform(local, this.pending, false);
    if (isIdentity(toY)) return;
    // Descending order keeps every offset valid inside the single transaction.
    const edits = toEdits(toY).reverse();
    this.ytext.doc!.transact(() => {
      for (const e of edits) {
        if (e.length > 0) this.ytext.delete(e.offset, e.length);
        if (e.text.length > 0) this.ytext.insert(e.offset, e.text);
      }
    }, LOCAL_ORIGIN);
  }

  private schedule(): void {
    if (this.scheduled || this.inFlight || this.disposed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    if (this.inFlight || this.disposed) return;
    if (isIdentity(this.pending)) {
      // Idle: cheap safety net against any unforeseen editor behavior.
      if (this.document.getText() !== this.ytext.toString()) {
        this.recover('editor text differs from Y.Text while idle');
        this.schedule();
      }
      return;
    }
    const delta = this.pending;
    const text = this.document.getText();
    const f: InFlight = {
      delta,
      expected: applyDelta(text, delta),
      echoSeen: false,
      superseded: false,
      resolved: false,
    };
    this.pending = [];
    this.inFlight = f;
    this.document.applyEdits(toEdits(delta)).then(
      (ok) => this.onApplied(f, ok),
      (err: unknown) => {
        this.log(`applyEdit threw: ${String(err)}`);
        this.onApplied(f, false);
      },
    );
  }

  private onApplied(f: InFlight, ok: boolean): void {
    if (this.inFlight !== f || this.disposed) return;
    f.resolved = true;

    if (f.superseded) {
      if (ok) this.recover('edit applied although a local change came first');
      else this.log('remote edit superseded by a local change; retrying');
      this.settle();
      return;
    }
    if (!ok) {
      this.pending = compose(f.delta, this.pending);
      this.inFlight = undefined;
      this.failures++;
      // Rejections without a concurrent local edit are unexpected; back off.
      setTimeout(() => this.schedule(), Math.min(1000, 10 * 2 ** this.failures));
      return;
    }
    if (!f.echoSeen) {
      if (this.document.getText() !== f.expected) {
        this.log('applyEdit resolved before its change event; waiting for it');
        return;
      }
      f.echoSeen = true; // no-op edit: no change event will come
    }
    this.settle();
  }

  private settle(): void {
    this.inFlight = undefined;
    this.failures = 0;
    this.schedule();
  }

  /** Last resort: trust the Y.Text and recompute the mapping from scratch. */
  private recover(reason: string): void {
    this.log(`binding out of sync (${reason}); resynchronizing from Y.Text`);
    this.inFlight = undefined;
    this.pending = diffText(this.document.getText(), this.ytext.toString());
  }
}

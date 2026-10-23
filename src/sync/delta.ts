/**
 * Minimal plain-text delta (retain/insert/delete) with compose and transform,
 * following the semantics of quill-delta without attributes. Offsets are
 * UTF-16 code units, which matches both Y.Text and VS Code offsets.
 */

export type Op = { retain: number } | { insert: string } | { delete: number };
export type Delta = Op[];

/** A replace operation in the coordinates of the text *before* the delta. */
export interface OffsetEdit {
  offset: number;
  length: number;
  text: string;
}

function opLength(op: Op): number {
  if ('retain' in op) return op.retain;
  if ('delete' in op) return op.delete;
  return op.insert.length;
}

class Builder {
  readonly ops: Op[] = [];

  retain(n: number): this {
    if (n <= 0) return this;
    const last = this.ops[this.ops.length - 1];
    if (last && 'retain' in last) last.retain += n;
    else this.ops.push({ retain: n });
    return this;
  }

  insert(s: string): this {
    if (s.length === 0) return this;
    // Canonical form: an insert never directly follows a delete.
    let i = this.ops.length;
    if (i > 0 && 'delete' in this.ops[i - 1]!) i--;
    const prev = this.ops[i - 1];
    if (prev && 'insert' in prev) prev.insert += s;
    else this.ops.splice(i, 0, { insert: s });
    return this;
  }

  delete(n: number): this {
    if (n <= 0) return this;
    const last = this.ops[this.ops.length - 1];
    if (last && 'delete' in last) last.delete += n;
    else this.ops.push({ delete: n });
    return this;
  }

  push(op: Op): this {
    if ('retain' in op) return this.retain(op.retain);
    if ('delete' in op) return this.delete(op.delete);
    return this.insert(op.insert);
  }

  /** Drops the trailing retain, which carries no information. */
  done(): Delta {
    const last = this.ops[this.ops.length - 1];
    if (last && 'retain' in last) this.ops.pop();
    return this.ops;
  }
}

class OpIterator {
  private index = 0;
  private offset = 0;

  constructor(private readonly ops: Delta) {}

  hasNext(): boolean {
    return this.peekLength() < Infinity;
  }

  peekLength(): number {
    const op = this.ops[this.index];
    return op ? opLength(op) - this.offset : Infinity;
  }

  peekType(): 'retain' | 'insert' | 'delete' {
    const op = this.ops[this.index];
    if (!op || 'retain' in op) return 'retain';
    return 'delete' in op ? 'delete' : 'insert';
  }

  next(length = Infinity): Op {
    const op = this.ops[this.index];
    if (!op) return { retain: length };
    const remaining = opLength(op) - this.offset;
    const n = Math.min(length, remaining);
    const start = this.offset;
    if (n === remaining) {
      this.index++;
      this.offset = 0;
    } else {
      this.offset += n;
    }
    if ('retain' in op) return { retain: n };
    if ('delete' in op) return { delete: n };
    return { insert: op.insert.slice(start, start + n) };
  }
}

export function isIdentity(delta: Delta): boolean {
  return delta.every((op) => 'retain' in op);
}

/** Returns a delta equivalent to applying `a` and then `b`. */
export function compose(a: Delta, b: Delta): Delta {
  const ai = new OpIterator(a);
  const bi = new OpIterator(b);
  const out = new Builder();
  while (ai.hasNext() || bi.hasNext()) {
    if (bi.peekType() === 'insert') {
      out.push(bi.next());
    } else if (ai.peekType() === 'delete') {
      out.push(ai.next());
    } else {
      const n = Math.min(ai.peekLength(), bi.peekLength());
      const aOp = ai.next(n);
      const bOp = bi.next(n);
      if ('retain' in bOp) out.push(aOp);
      else if ('delete' in bOp && 'retain' in aOp) out.push(bOp);
      // else: b deletes text that a inserted; both cancel out.
    }
  }
  return out.done();
}

/**
 * Transforms `b` so it applies after `a`, where `a` and `b` were made
 * concurrently against the same text. When both insert at the same position,
 * `aFirst` decides whose insert ends up first. The pair
 * `transform(a, b, p)` / `transform(b, a, !p)` always converges.
 */
export function transform(a: Delta, b: Delta, aFirst: boolean): Delta {
  const ai = new OpIterator(a);
  const bi = new OpIterator(b);
  const out = new Builder();
  while (ai.hasNext() || bi.hasNext()) {
    if (ai.peekType() === 'insert' && (aFirst || bi.peekType() !== 'insert')) {
      out.retain(opLength(ai.next()));
    } else if (bi.peekType() === 'insert') {
      out.push(bi.next());
    } else {
      const n = Math.min(ai.peekLength(), bi.peekLength());
      const aOp = ai.next(n);
      const bOp = bi.next(n);
      if ('delete' in aOp) continue; // a already removed this range
      if ('delete' in bOp) out.push(bOp);
      else out.retain(n);
    }
  }
  return out.done();
}

export function applyDelta(text: string, delta: Delta): string {
  let result = '';
  let index = 0;
  for (const op of delta) {
    if ('retain' in op) {
      result += text.slice(index, index + op.retain);
      index += op.retain;
    } else if ('delete' in op) {
      index += op.delete;
    } else {
      result += op.insert;
    }
  }
  if (index > text.length) throw new RangeError(`delta is longer than text (${index} > ${text.length})`);
  return result + text.slice(index);
}

/**
 * Builds a delta from non-overlapping replace edits whose offsets all refer to
 * the same original text (as in a multi-cursor TextDocumentChangeEvent).
 */
export function fromEdits(edits: readonly OffsetEdit[]): Delta {
  // At equal offsets an insertion goes before a removed range (editors can
  // report both in one event); either order yields the same text.
  const sorted = [...edits].sort((x, y) => x.offset - y.offset || x.length - y.length);
  const out = new Builder();
  let cursor = 0;
  for (const e of sorted) {
    if (e.offset < cursor) throw new RangeError('overlapping edits');
    out.retain(e.offset - cursor).delete(e.length).insert(e.text);
    cursor = e.offset + e.length;
  }
  return out.done();
}

/** Converts a delta into replace edits, ascending, in original-text coordinates. */
export function toEdits(delta: Delta): OffsetEdit[] {
  const edits: OffsetEdit[] = [];
  let index = 0;
  let current: OffsetEdit | undefined;
  for (const op of delta) {
    if ('retain' in op) {
      current = undefined;
      index += op.retain;
      continue;
    }
    if (!current) {
      current = { offset: index, length: 0, text: '' };
      edits.push(current);
    }
    if ('delete' in op) {
      current.length += op.delete;
      index += op.delete;
    } else {
      current.text += op.insert;
    }
  }
  return edits;
}

/** Converts a Y.YTextEvent delta (attributes and embeds are not supported). */
export function fromYDelta(ydelta: ReadonlyArray<{ insert?: unknown; retain?: number; delete?: number }>): Delta {
  const out = new Builder();
  for (const op of ydelta) {
    if (op.retain !== undefined) out.retain(op.retain);
    else if (op.delete !== undefined) out.delete(op.delete);
    else if (typeof op.insert === 'string') out.insert(op.insert);
    else throw new TypeError('non-text content in Y.Text is not supported');
  }
  return out.done();
}

/** Minimal single-replace diff via common prefix and suffix. */
export function diffText(oldText: string, newText: string): Delta {
  const max = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
  // Do not split a surrogate pair.
  if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (suffix > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suffix))) suffix--;
  return new Builder()
    .retain(prefix)
    .delete(oldText.length - prefix - suffix)
    .insert(newText.slice(prefix, newText.length - suffix))
    .done();
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** Maps an index in the text before `delta` to the text after it. */
export function transformIndex(delta: Delta, index: number): number {
  let oldPos = 0;
  let newPos = 0;
  for (const op of delta) {
    if ('retain' in op) {
      if (index < oldPos + op.retain) return newPos + (index - oldPos);
      oldPos += op.retain;
      newPos += op.retain;
    } else if ('insert' in op) {
      newPos += op.insert.length;
    } else {
      if (index < oldPos + op.delete) return newPos;
      oldPos += op.delete;
    }
  }
  return newPos + (index - oldPos);
}

/** Maps an index in the text after `delta` back to the text before it. */
export function transformIndexBack(delta: Delta, index: number): number {
  let oldPos = 0;
  let newPos = 0;
  for (const op of delta) {
    if ('retain' in op) {
      if (index < newPos + op.retain) return oldPos + (index - newPos);
      oldPos += op.retain;
      newPos += op.retain;
    } else if ('insert' in op) {
      if (index < newPos + op.insert.length) return oldPos;
      newPos += op.insert.length;
    } else {
      oldPos += op.delete;
    }
  }
  return oldPos + (index - newPos);
}

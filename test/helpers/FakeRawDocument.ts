import type { Disposable, Eol, PositionEdit, RawChange, RawTextDocument } from '../../src/sync/document';
import { toEol } from '../../src/sync/document';

interface RawEdit {
  offset: number;
  length: number;
  text: string;
}

interface Job {
  edits: readonly PositionEdit[];
  version: number;
  resolve: (ok: boolean) => void;
}

/**
 * Simulates a vscode.TextDocument as seen from the extension host:
 * - the model enforces one EOL, inserted text is converted to it;
 * - change events fire synchronously with raw, pre-event offsets;
 * - applyEdits is asynchronous and is rejected if the document version
 *   changed after the call (as VS Code does for WorkspaceEdit);
 * - the change event of an applied edit fires before the promise resolves.
 *
 * With `manual: true`, queued applyEdits only run on releaseNext/releaseAll.
 */
export class FakeRawDocument implements RawTextDocument {
  version = 0;
  /** Number of applyEdits rejected because the document changed first. */
  rejected = 0;
  private text: string;
  private readonly listeners = new Set<(changes: readonly RawChange[]) => void>();
  private readonly queue: Job[] = [];

  constructor(
    text: string,
    readonly eol: Eol = '\n',
    private readonly options: { manual?: boolean } = {},
  ) {
    this.text = toEol(text, eol);
  }

  getText(): string {
    return this.text;
  }

  get pendingApplies(): number {
    return this.queue.length;
  }

  applyEdits(edits: readonly PositionEdit[]): Promise<boolean> {
    return new Promise((resolve) => {
      const job: Job = { edits, version: this.version, resolve };
      if (this.options.manual) this.queue.push(job);
      else queueMicrotask(() => this.run(job));
    });
  }

  /** Runs the oldest queued applyEdit; `between` runs after its echo and before it resolves. */
  releaseNext(between?: () => void): boolean {
    const job = this.queue.shift();
    if (!job) return false;
    this.run(job, between);
    return true;
  }

  releaseAll(): void {
    while (this.releaseNext());
  }

  onDidChange(listener: (changes: readonly RawChange[]) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** User edit in raw offsets (several entries = multi-cursor, all relative to the current text). */
  userEdit(edits: readonly RawEdit[]): void {
    this.mutate(edits.map((e) => ({ ...e, text: toEol(e.text, this.eol) })));
  }

  /** User edit in LF-normalized offsets, converted like the editor would. */
  userEditNormalized(edits: readonly RawEdit[]): void {
    this.userEdit(
      edits.map((e) => {
        const start = this.rawOffset(e.offset);
        const end = this.rawOffset(e.offset + e.length);
        return { offset: start, length: end - start, text: e.text };
      }),
    );
  }

  private rawOffset(normalized: number): number {
    if (this.eol === '\n') return normalized;
    let raw = 0;
    let n = 0;
    while (n < normalized) {
      raw += this.text.startsWith('\r\n', raw) ? 2 : 1;
      n++;
    }
    return raw;
  }

  private run(job: Job, between?: () => void): void {
    if (job.version !== this.version) {
      this.rejected++;
      job.resolve(false);
      return;
    }
    const starts = this.lineStarts();
    this.mutate(
      job.edits.map((e) => {
        const start = starts[e.startLine]! + e.startCharacter;
        const end = starts[e.endLine]! + e.endCharacter;
        return { offset: start, length: end - start, text: toEol(e.text, this.eol) };
      }),
    );
    between?.();
    job.resolve(true);
  }

  private lineStarts(): number[] {
    const starts = [0];
    for (let i = this.text.indexOf('\n'); i !== -1; i = this.text.indexOf('\n', i + 1)) starts.push(i + 1);
    return starts;
  }

  private mutate(edits: readonly RawEdit[]): void {
    const before = this.text;
    const lineOf = (offset: number) => countNewlines(before, offset);
    const sorted = [...edits].sort((a, b) => b.offset - a.offset);
    const changes: RawChange[] = sorted.map((e) => ({
      rangeOffset: e.offset,
      rangeLength: e.length,
      startLine: lineOf(e.offset),
      endLine: lineOf(e.offset + e.length),
      text: e.text,
    }));
    let text = before;
    for (const e of sorted) text = text.slice(0, e.offset) + e.text + text.slice(e.offset + e.length);
    this.text = text;
    this.version++;
    for (const l of this.listeners) l(changes);
  }
}

function countNewlines(text: string, end: number): number {
  let n = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < end; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/**
 * Editor-agnostic document abstractions. EditorBinding only sees a
 * BindableDocument, whose text and offsets are always LF-normalized.
 * NormalizedDocument adapts a RawTextDocument (the shape of a vscode
 * TextDocument, possibly CRLF) to it, so the EOL logic is unit-testable.
 */

export interface Disposable {
  dispose(): void;
}

export type Eol = '\n' | '\r\n';

/** Same meaning as vscode.TextDocumentContentChangeEvent (raw offsets, pre-event). */
export interface RawChange {
  rangeOffset: number;
  rangeLength: number;
  startLine: number;
  endLine: number;
  text: string;
}

export interface PositionEdit {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  text: string;
}

/** Thin view of an editor document; implemented over vscode.TextDocument. */
export interface RawTextDocument {
  readonly eol: Eol;
  getText(): string;
  /**
   * Applies all edits atomically. Positions refer to the current text.
   * Resolves false if the document changed before the edit could be applied.
   */
  applyEdits(edits: readonly PositionEdit[]): Promise<boolean>;
  onDidChange(listener: (changes: readonly RawChange[]) => void): Disposable;
}

/** A change in LF-normalized coordinates, relative to the text before the event. */
export interface DocChange {
  offset: number;
  length: number;
  text: string;
}

export interface BindableDocument {
  /** LF-normalized full text. */
  getText(): string;
  /** Non-overlapping edits in LF-normalized offsets of the current text. */
  applyEdits(edits: readonly DocChange[]): Promise<boolean>;
  onDidChange(listener: (changes: readonly DocChange[]) => void): Disposable;
}

export function normalizeEol(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n/g, '\n') : text;
}

export function toEol(text: string, eol: Eol): string {
  return eol === '\n' ? normalizeEol(text) : normalizeEol(text).replace(/\n/g, '\r\n');
}

/**
 * Converts a raw change to normalized coordinates. In a CRLF document every
 * line break before the change counts as two raw characters, so the
 * normalized offset is the raw offset minus the line number.
 */
export function normalizeChange(change: RawChange, eol: Eol): DocChange {
  if (eol === '\n') {
    return { offset: change.rangeOffset, length: change.rangeLength, text: normalizeEol(change.text) };
  }
  return {
    offset: change.rangeOffset - change.startLine,
    length: change.rangeLength - (change.endLine - change.startLine),
    text: normalizeEol(change.text),
  };
}

/** Maps LF-normalized offsets to line/character positions. */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(normalizedText: string) {
    for (let i = normalizedText.indexOf('\n'); i !== -1; i = normalizedText.indexOf('\n', i + 1)) {
      this.starts.push(i + 1);
    }
  }

  positionAt(offset: number): { line: number; character: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - this.starts[lo]! };
  }
}

export class NormalizedDocument implements BindableDocument {
  constructor(private readonly raw: RawTextDocument) {}

  getText(): string {
    return normalizeEol(this.raw.getText());
  }

  applyEdits(edits: readonly DocChange[]): Promise<boolean> {
    const index = new LineIndex(this.getText());
    const eol = this.raw.eol;
    return this.raw.applyEdits(
      edits.map((e) => {
        const start = index.positionAt(e.offset);
        const end = index.positionAt(e.offset + e.length);
        return {
          startLine: start.line,
          startCharacter: start.character,
          endLine: end.line,
          endCharacter: end.character,
          text: toEol(e.text, eol),
        };
      }),
    );
  }

  onDidChange(listener: (changes: readonly DocChange[]) => void): Disposable {
    return this.raw.onDidChange((changes) => {
      const eol = this.raw.eol;
      listener(changes.map((c) => normalizeChange(c, eol)));
    });
  }
}

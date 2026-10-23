import * as vscode from 'vscode';
import { NormalizedDocument, type Disposable, type Eol, type PositionEdit, type RawChange, type RawTextDocument } from './document';

/** RawTextDocument over a live vscode.TextDocument. */
export class VscodeRawDocument implements RawTextDocument {
  constructor(private readonly document: vscode.TextDocument) {}

  get eol(): Eol {
    return this.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  }

  getText(): string {
    return this.document.getText();
  }

  applyEdits(edits: readonly PositionEdit[]): Promise<boolean> {
    const ranges = edits.map((e) => ({
      range: new vscode.Range(e.startLine, e.startCharacter, e.endLine, e.endCharacter),
      text: e.text,
    }));
    // Prefer TextEditor.edit: it is applied atomically in the renderer, in
    // order with the user's typing, and rejected if the document version
    // changed. workspace.applyEdit goes through the async bulk-edit service and
    // can be applied at stale positions after newer typing (see NOTES.md).
    // Without a visible editor the user cannot type, so applyEdit is safe.
    const editor = vscode.window.visibleTextEditors.find((e) => e.document === this.document);
    if (editor) {
      return Promise.resolve(
        editor.edit((builder) => {
          for (const r of ranges) builder.replace(r.range, r.text);
        }),
      );
    }
    const edit = new vscode.WorkspaceEdit();
    for (const r of ranges) edit.replace(this.document.uri, r.range, r.text);
    return Promise.resolve(vscode.workspace.applyEdit(edit));
  }

  onDidChange(listener: (changes: readonly RawChange[]) => void): Disposable {
    return vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document !== this.document || e.contentChanges.length === 0) return;
      listener(
        e.contentChanges.map((c) => ({
          rangeOffset: c.rangeOffset,
          rangeLength: c.rangeLength,
          startLine: c.range.start.line,
          endLine: c.range.end.line,
          text: c.text,
        })),
      );
    });
  }
}

export function bindableDocument(document: vscode.TextDocument): NormalizedDocument {
  return new NormalizedDocument(new VscodeRawDocument(document));
}

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
    const edit = new vscode.WorkspaceEdit();
    for (const e of edits) {
      edit.replace(
        this.document.uri,
        new vscode.Range(e.startLine, e.startCharacter, e.endLine, e.endCharacter),
        e.text,
      );
    }
    // The extension host attaches the document version, so the edit is
    // rejected (resolves false) if the user typed in the meantime.
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

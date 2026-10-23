import * as vscode from 'vscode';
import * as Y from 'yjs';
import { LineIndex, normalizeEol } from './document';
import type { EditorBinding } from './EditorBinding';
import type { DocLocator } from './RemoteCursors';

const CONTEXT_KEY = 'syncode.sharedEditor';

interface SelectionRel {
  anchor: Y.RelativePosition;
  head: Y.RelativePosition;
}

interface Tracked {
  manager: Y.UndoManager;
  /** Selections just before the latest local edit (relative, so they survive edits). */
  lastSelections: SelectionRel[];
}

/**
 * Undo/redo of this participant's own edits in shared documents, using
 * Y.UndoManager restricted to the binding's transaction origin. The native
 * editor undo would also revert other people's edits. Bound to Ctrl+Z /
 * Ctrl+Shift+Z / Ctrl+Y through the `syncode.sharedEditor` context key.
 */
export class LocalUndo implements vscode.Disposable {
  private readonly tracked = new Map<EditorBinding, Tracked>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly locator: DocLocator,
    private enabled: boolean,
  ) {
    this.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection((e) => this.remember(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
    );
    this.refresh();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.refresh();
  }

  /** Call when documents start or stop being shared. */
  refresh(): void {
    for (const [binding, t] of this.tracked) {
      if (binding.isDisposed) {
        t.manager.destroy();
        this.tracked.delete(binding);
      }
    }
    for (const editor of vscode.window.visibleTextEditors) {
      const binding = this.locator.bindingFor(editor.document);
      if (binding) this.trackedFor(binding, editor);
    }
    const active = vscode.window.activeTextEditor;
    const shared = this.enabled && !!active && !!this.locator.bindingFor(active.document);
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, shared);
  }

  async undo(): Promise<void> {
    await this.step('undo');
  }

  async redo(): Promise<void> {
    await this.step('redo');
  }

  dispose(): void {
    for (const s of this.subscriptions.splice(0)) s.dispose();
    for (const t of this.tracked.values()) t.manager.destroy();
    this.tracked.clear();
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, false);
  }

  private async step(kind: 'undo' | 'redo'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const binding = editor && this.locator.bindingFor(editor.document);
    if (!editor || !binding) {
      await vscode.commands.executeCommand(kind); // not shared: native behavior
      return;
    }
    const { manager } = this.trackedFor(binding, editor);
    const item = kind === 'undo' ? manager.undo() : manager.redo();
    if (!item) return;
    // The binding applies the change to the editor asynchronously.
    await binding.whenIdle();
    const selections = item.meta.get('selections') as SelectionRel[] | undefined;
    if (selections && !editor.document.isClosed) {
      const restored = selections
        .map((s) => {
          const anchor = this.toPosition(editor, binding, s.anchor);
          const head = this.toPosition(editor, binding, s.head);
          return anchor && head ? new vscode.Selection(anchor, head) : undefined;
        })
        .filter((s): s is vscode.Selection => !!s);
      if (restored.length > 0) {
        editor.selections = restored;
        editor.revealRange(restored[0]!, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    }
  }

  private trackedFor(binding: EditorBinding, editor: vscode.TextEditor): Tracked {
    let t = this.tracked.get(binding);
    if (!t) {
      const manager = new Y.UndoManager(binding.ytext, { trackedOrigins: new Set([binding]), captureTimeout: 500 });
      const tracked: Tracked = { manager, lastSelections: [] };
      // Remember where the cursor was before the edit, like the native undo.
      manager.on('stack-item-added', (event: { stackItem: { meta: Map<string, unknown> }; type: 'undo' | 'redo' }) => {
        if (!event.stackItem.meta.has('selections')) event.stackItem.meta.set('selections', tracked.lastSelections);
      });
      t = tracked;
      this.tracked.set(binding, t);
      this.remember(editor);
    }
    return t;
  }

  private remember(editor: vscode.TextEditor): void {
    const binding = this.locator.bindingFor(editor.document);
    const t = binding && this.tracked.get(binding);
    if (!binding || !t) return;
    const toRel = (pos: vscode.Position) => {
      const raw = editor.document.offsetAt(pos);
      const normalized = editor.document.eol === vscode.EndOfLine.CRLF ? raw - pos.line : raw;
      return Y.createRelativePositionFromTypeIndex(binding.ytext, binding.toYIndex(normalized));
    };
    t.lastSelections = editor.selections.map((s) => ({ anchor: toRel(s.anchor), head: toRel(s.active) }));
  }

  private toPosition(editor: vscode.TextEditor, binding: EditorBinding, rel: Y.RelativePosition): vscode.Position | undefined {
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, binding.ytext.doc!);
    if (!abs || abs.type !== binding.ytext) return undefined;
    const p = new LineIndex(normalizeEol(editor.document.getText())).positionAt(binding.toDocOffset(abs.index));
    return editor.document.validatePosition(new vscode.Position(p.line, p.character));
  }
}

import * as vscode from 'vscode';
import * as Y from 'yjs';
import { DocRegistry } from './DocRegistry';
import { EditorBinding } from './EditorBinding';
import type { Logger } from '../log';
import { bindableDocument } from './VscodeDocument';

const NET = Symbol('debug-net');

/**
 * Forwards Y updates between two docs in order, each after a random delay,
 * to reproduce network latency and the applyEdit/typing race locally.
 */
function laggyLink(from: Y.Doc, to: Y.Doc, minMs: number, maxMs: number): vscode.Disposable {
  // Each update gets its own random latency, but never overtakes the previous one.
  let lastDelivery = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === NET) return;
    const at = Math.max(lastDelivery, Date.now() + minMs + Math.random() * (maxMs - minMs));
    lastDelivery = at;
    const timer = setTimeout(() => {
      timers.delete(timer);
      Y.applyUpdate(to, update, NET);
    }, at - Date.now());
    timers.add(timer);
  };
  from.on('update', onUpdate);
  return new vscode.Disposable(() => {
    from.off('update', onUpdate);
    for (const t of timers) clearTimeout(t);
  });
}

/**
 * Developer aid for Phase 1: mirrors the active editor into a new untitled
 * editor through two Y.Docs joined by a laggy in-memory link. Typing in either
 * editor must show up in the other and they must never diverge.
 */
export async function startDebugMirror(output: Logger): Promise<vscode.Disposable | undefined> {
  const source = vscode.window.activeTextEditor?.document;
  if (!source) {
    void vscode.window.showWarningMessage('SynCode: open a text editor first.');
    return undefined;
  }
  const log = (side: string) => (m: string) => output.appendLine(`[mirror ${side}] ${m}`);

  const hostRegistry = new DocRegistry();
  const guestRegistry = new DocRegistry();
  const hostEntry = hostRegistry.acquire('mirror', () => source.getText());
  const guestEntry = guestRegistry.acquire('mirror');
  Y.applyUpdate(guestEntry.doc, Y.encodeStateAsUpdate(hostEntry.doc), NET);

  const target = await vscode.workspace.openTextDocument({ language: source.languageId, content: '' });
  const disposables: vscode.Disposable[] = [
    laggyLink(hostEntry.doc, guestEntry.doc, 20, 250),
    laggyLink(guestEntry.doc, hostEntry.doc, 20, 250),
    new EditorBinding(hostEntry.text, bindableDocument(source), { log: log('A') }),
    new EditorBinding(guestEntry.text, bindableDocument(target), { log: log('B') }),
  ];
  await vscode.window.showTextDocument(target, { viewColumn: vscode.ViewColumn.Beside, preview: false });

  const stop = new vscode.Disposable(() => {
    for (const d of disposables.splice(0)) d.dispose();
    hostRegistry.dispose();
    guestRegistry.dispose();
    output.appendLine('[mirror] stopped');
  });
  disposables.push(
    vscode.workspace.onDidCloseTextDocument((d) => {
      if (d === source || d === target) stop.dispose();
    }),
  );
  output.appendLine(`[mirror] mirroring ${source.uri.toString()} (eol=${source.eol === vscode.EndOfLine.CRLF ? 'CRLF' : 'LF'})`);
  return stop;
}

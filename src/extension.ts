import * as vscode from 'vscode';
import { Logger } from './log';
import { startDebugMirror } from './sync/debugMirror';

let mirror: vscode.Disposable | undefined;

/** Returned from activate(); used by the integration tests. */
export interface LanPairApi {
  recentLogLines(): readonly string[];
}

export function activate(context: vscode.ExtensionContext): LanPairApi {
  const output = new Logger();
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('lanpair.hello', () => {
      void vscode.window.showInformationMessage(`LanPair is alive (vscode API ${vscode.version}).`);
    }),
    vscode.commands.registerCommand('lanpair.debugMirror', async () => {
      if (mirror) {
        mirror.dispose();
        mirror = undefined;
        void vscode.window.showInformationMessage('LanPair: mirror stopped.');
        return;
      }
      mirror = await startDebugMirror(output);
    }),
    new vscode.Disposable(() => mirror?.dispose()),
  );
  return { recentLogLines: () => output.recentLines() };
}

export function deactivate(): void {}

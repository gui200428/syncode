import * as vscode from 'vscode';
import { startDebugMirror } from './sync/debugMirror';

let mirror: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('LanPair');
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
}

export function deactivate(): void {}

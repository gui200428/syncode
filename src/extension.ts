import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('lanpair.hello', () => {
      void vscode.window.showInformationMessage(`LanPair is alive (vscode API ${vscode.version}).`);
    }),
  );
}

export function deactivate(): void {}

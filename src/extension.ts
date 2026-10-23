import * as vscode from 'vscode';
import { LanPairFs, SCHEME } from './guest/LanPairFs';
import { Logger } from './log';
import { SessionManager, type HostingInfo } from './session/SessionManager';
import { startDebugMirror } from './sync/debugMirror';
import { StatusBar } from './ui/StatusBar';

let mirror: vscode.Disposable | undefined;

/** Returned from activate(); used by the integration tests. */
export interface LanPairApi {
  recentLogLines(): readonly string[];
  startHosting(pin: string): Promise<HostingInfo | undefined>;
  join(host: string, port: number, pin: string): Promise<boolean>;
  openRemoteFile(path: string): Promise<vscode.TextEditor | undefined>;
  stop(): void;
}

export function activate(context: vscode.ExtensionContext): LanPairApi {
  const output = new Logger();
  const fs = new LanPairFs((m) => output.appendLine(`[guest] ${m}`));
  const status = new StatusBar();
  const sessions = new SessionManager(context, fs, status, output);
  const command = (id: string, fn: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, fn);

  context.subscriptions.push(
    output,
    fs,
    status,
    sessions,
    vscode.workspace.registerFileSystemProvider(SCHEME, fs, { isCaseSensitive: true }),
    command('lanpair.startHosting', () => sessions.startHosting()),
    command('lanpair.stopSession', () => sessions.stop()),
    command('lanpair.joinSession', () => sessions.join()),
    command('lanpair.copyJoinInfo', () => sessions.copyJoinInfo()),
    command('lanpair.openRemoteFile', () => sessions.openRemoteFile()),
    command('lanpair.showMenu', () => sessions.showMenu()),
    command('lanpair.hello', () => {
      void vscode.window.showInformationMessage(`LanPair is alive (vscode API ${vscode.version}).`);
    }),
    command('lanpair.debugMirror', async () => {
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

  return {
    recentLogLines: () => output.recentLines(),
    startHosting: (pin) => sessions.startHosting({ pin }),
    join: (host, port, pin) => sessions.join({ host, port, pin }),
    openRemoteFile: (path) => sessions.openRemoteFile(path),
    stop: () => sessions.stop(),
  };
}

export function deactivate(): void {}

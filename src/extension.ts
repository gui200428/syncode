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
  /** Joins without reopening the window on the host's folder. */
  join(host: string, port: number, pin: string): Promise<boolean>;
  openRemoteFile(path: string): Promise<vscode.TextEditor | undefined>;
  participants(): Array<{ clientId: number; name: string; file: string | null }>;
  follow(clientId: number | undefined): void;
  remoteHeads(): Array<{ name: string; uri: string; line: number; character: number }>;
  sessionKind(): string;
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
    command('lanpair.stopSession', () => sessions.leave()),
    command('lanpair.followParticipant', () => sessions.followParticipant()),
    command('lanpair.setIdentity', () => sessions.setIdentity()),
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

  void sessions.resumeFromWorkspace();

  return {
    recentLogLines: () => output.recentLines(),
    startHosting: (pin) => sessions.startHosting({ pin }),
    join: (host, port, pin) => sessions.join({ host, port, pin }, { inPlace: true }),
    openRemoteFile: (path) => sessions.openRemoteFile(path),
    participants: () =>
      (sessions.cursors?.participants() ?? []).map((p) => ({ clientId: p.clientId, name: p.user.name, file: p.file })),
    follow: (clientId) => sessions.cursors?.follow(clientId),
    remoteHeads: () => sessions.cursors?.remoteHeads() ?? [],
    sessionKind: () => sessions.kind,
    stop: () => sessions.stop(),
  };
}

export function deactivate(): void {}

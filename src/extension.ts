import * as vscode from 'vscode';
import { browse, type DiscoveredSession } from './discovery/mdns';
import { SynCodeFs, SCHEME } from './guest/SynCodeFs';
import { Logger } from './log';
import { SessionManager, type HostingInfo } from './session/SessionManager';
import { startDebugMirror } from './sync/debugMirror';
import { StatusBar } from './ui/StatusBar';

let mirror: vscode.Disposable | undefined;

/** Returned from activate(); used by the integration tests. */
export interface SynCodeApi {
  recentLogLines(): readonly string[];
  startHosting(pin: string): Promise<HostingInfo | undefined>;
  /** Joins without reopening the window on the host's folder. */
  join(host: string, port: number, pin: string): Promise<boolean>;
  /** Joins in mirror mode into `folder` (this window's workspace folder). */
  joinMirror(host: string, port: number, pin: string, folder: string): Promise<{ written: number; deleted: number; kept: number } | undefined>;
  openRemoteFile(path: string): Promise<vscode.TextEditor | undefined>;
  participants(): Array<{ clientId: number; name: string; file: string | null }>;
  follow(clientId: number | undefined): void;
  remoteHeads(): Array<{ name: string; uri: string; line: number; character: number }>;
  sessionKind(): string;
  /** Sessions announced on the LAN within `ms`. */
  discoverSessions(ms: number): Promise<DiscoveredSession[]>;
  simulateNetworkDrop(): void;
  guestConnected(): boolean | undefined;
  stop(): void;
}

export function activate(context: vscode.ExtensionContext): SynCodeApi {
  const output = new Logger();
  const fs = new SynCodeFs((m) => output.appendLine(`[guest] ${m}`));
  const status = new StatusBar();
  const sessions = new SessionManager(context, fs, status, output);
  const command = (id: string, fn: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, fn);

  context.subscriptions.push(
    output,
    fs,
    status,
    sessions,
    vscode.workspace.registerFileSystemProvider(SCHEME, fs, { isCaseSensitive: true }),
    command('syncode.startHosting', () => sessions.startHosting()),
    command('syncode.stopSession', () => sessions.leave()),
    command('syncode.followParticipant', () => sessions.followParticipant()),
    command('syncode.setIdentity', () => sessions.setIdentity()),
    command('syncode.undo', () => sessions.undo('undo')),
    command('syncode.redo', () => sessions.undo('redo')),
    command('syncode.joinSession', () => sessions.join()),
    command('syncode.reconnectMirror', () => sessions.reconnectMirrorCommand()),
    command('syncode.copyJoinInfo', () => sessions.copyJoinInfo()),
    command('syncode.openRemoteFile', () => sessions.openRemoteFile()),
    command('syncode.showMenu', () => sessions.showMenu()),
    command('syncode.hello', () => {
      void vscode.window.showInformationMessage(`SynCode is alive (vscode API ${vscode.version}).`);
    }),
    command('syncode.debugMirror', async () => {
      if (mirror) {
        mirror.dispose();
        mirror = undefined;
        void vscode.window.showInformationMessage('SynCode: mirror stopped.');
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
    joinMirror: (host, port, pin, folder) => sessions.joinMirrorInPlace({ host, port, pin }, vscode.Uri.file(folder)),
    openRemoteFile: (path) => sessions.openRemoteFile(path),
    participants: () =>
      (sessions.cursors?.participants() ?? []).map((p) => ({ clientId: p.clientId, name: p.user.name, file: p.file })),
    follow: (clientId) => sessions.cursors?.follow(clientId),
    remoteHeads: () => sessions.cursors?.remoteHeads() ?? [],
    sessionKind: () => sessions.kind,
    discoverSessions: (ms) =>
      new Promise((resolve) => {
        let latest: DiscoveredSession[] = [];
        const browser = browse((s) => (latest = s), (m) => output.appendLine(`[mdns] ${m}`));
        setTimeout(() => {
          browser.dispose();
          resolve(latest);
        }, ms);
      }),
    simulateNetworkDrop: () => sessions.simulateNetworkDrop(),
    guestConnected: () => sessions.guestConnected,
    stop: () => sessions.stop(),
  };
}

export function deactivate(): void {}

import { randomBytes, randomInt } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { lanAddresses, readConfig } from '../config';
import { remoteUri, type LanPairFs } from '../guest/LanPairFs';
import { JoinError, SessionClient } from '../guest/SessionClient';
import { HostDocuments } from '../host/HostDocuments';
import { SessionServer } from '../host/SessionServer';
import { WorkspaceIndex } from '../host/WorkspaceIndex';
import type { Logger } from '../log';
import type { StatusBar } from '../ui/StatusBar';

export interface HostingInfo {
  port: number;
  pin: string;
  addresses: string[];
  sessionId: string;
}

type State =
  | { kind: 'idle' }
  | { kind: 'hosting'; server: SessionServer; docs: HostDocuments; info: HostingInfo; disposables: vscode.Disposable[] }
  | { kind: 'guest'; client: SessionClient; disposables: vscode.Disposable[] };

const LAST_ADDRESS_KEY = 'lanpair.lastAddress';

export function parseAddress(input: string): { host: string; port: number } | undefined {
  const m = /^\s*\[?([^\]\s]+?)\]?:(\d{1,5})\s*$/.exec(input);
  if (!m) return undefined;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1]!, port } : undefined;
}

/** Owns the current session (host or guest) and implements the commands. */
export class SessionManager implements vscode.Disposable {
  private state: State = { kind: 'idle' };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly fs: LanPairFs,
    private readonly status: StatusBar,
    private readonly log: Logger,
  ) {}

  get kind(): State['kind'] {
    return this.state.kind;
  }

  get hostingInfo(): HostingInfo | undefined {
    return this.state.kind === 'hosting' ? this.state.info : undefined;
  }

  get guestClient(): SessionClient | undefined {
    return this.state.kind === 'guest' ? this.state.client : undefined;
  }

  async startHosting(options: { pin?: string } = {}): Promise<HostingInfo | undefined> {
    if (this.state.kind !== 'idle') {
      void vscode.window.showWarningMessage('LanPair: a session is already running. Stop it first.');
      return undefined;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') {
      void vscode.window.showErrorMessage('LanPair: open a local folder to share it.');
      return undefined;
    }
    const config = readConfig();
    const pin = options.pin ?? randomInt(0, 1_000_000).toString().padStart(6, '0');
    const sessionId = randomBytes(4).toString('hex');
    const docs = new HostDocuments(new WorkspaceIndex(folder.uri.fsPath, { maxFileBytes: config.maxFileBytes }), (m) =>
      this.log.appendLine(`[host] ${m}`),
    );
    let server: SessionServer;
    try {
      server = await SessionServer.start({
        port: config.port,
        pin,
        sessionId,
        hostName: config.displayName,
        rootName: path.basename(folder.uri.fsPath),
        docs,
        log: (m) => this.log.appendLine(`[server] ${m}`),
      });
    } catch (err) {
      docs.dispose();
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`LanPair: could not open port ${config.port}: ${message}`);
      return undefined;
    }
    const info: HostingInfo = { port: server.port, pin, addresses: lanAddresses(), sessionId };
    const updateStatus = () => this.status.update({ kind: 'hosting', pin, guests: server.guests.length });
    const guestsChanged = server.onDidChangeGuests(updateStatus);
    this.state = {
      kind: 'hosting',
      server,
      docs,
      info,
      disposables: [new vscode.Disposable(() => guestsChanged.dispose())],
    };
    updateStatus();
    this.log.appendLine(`[host] sharing ${folder.uri.fsPath} on port ${info.port} (session ${sessionId})`);

    if (!options.pin) {
      const action = await vscode.window.showInformationMessage(
        `LanPair: hosting on ${this.joinAddress(info)} — PIN ${pin}`,
        'Copy Join Info',
      );
      if (action) await this.copyJoinInfo();
      if (process.platform === 'win32') {
        void vscode.window.showInformationMessage(
          'LanPair: if Windows asks about the firewall, allow access on private networks so guests can connect. ' +
            'Set "lanpair.port" to keep the same port (and firewall rule) across sessions.',
        );
      }
    }
    return info;
  }

  async join(target?: { host: string; port: number; pin: string }): Promise<boolean> {
    if (this.state.kind !== 'idle') {
      void vscode.window.showWarningMessage('LanPair: a session is already running. Stop it first.');
      return false;
    }
    const address = target ? { host: target.host, port: target.port } : await this.askAddress();
    if (!address) return false;
    const config = readConfig();
    let pin = target?.pin;
    for (;;) {
      pin ??= await vscode.window.showInputBox({
        title: 'LanPair: Join Session',
        prompt: `PIN shown by the host (${address.host}:${address.port})`,
        placeHolder: '6 digits',
        ignoreFocusOut: true,
        validateInput: (v) => (/^\d{6}$/.test(v.trim()) ? undefined : 'Enter the 6-digit PIN'),
      });
      if (!pin) return false;
      try {
        const client = await SessionClient.connect({
          host: address.host,
          port: address.port,
          pin: pin.trim(),
          name: config.displayName,
          color: config.color,
          log: (m) => this.log.appendLine(`[guest] ${m}`),
        });
        this.becomeGuest(client);
        await this.context.globalState.update(LAST_ADDRESS_KEY, `${address.host}:${address.port}`);
        return true;
      } catch (err) {
        if (err instanceof JoinError && err.code === 'pin' && !target) {
          void vscode.window.showWarningMessage(`LanPair: wrong PIN (${err.attemptsLeft} attempts left).`);
          pin = undefined;
          continue;
        }
        void vscode.window.showErrorMessage(`LanPair: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    }
  }

  /** Phase 2: open a host file by its workspace-relative path. */
  async openRemoteFile(relPath?: string): Promise<vscode.TextEditor | undefined> {
    const client = this.guestClient;
    if (!client) {
      void vscode.window.showWarningMessage('LanPair: join a session first.');
      return undefined;
    }
    relPath ??= await vscode.window.showInputBox({
      title: `LanPair: Open file from ${client.welcome.rootName}`,
      prompt: 'Path relative to the shared folder',
      placeHolder: 'src/index.ts',
      ignoreFocusOut: true,
    });
    if (!relPath) return undefined;
    const uri = remoteUri(client.welcome.sessionId, relPath.trim().replace(/\\/g, '/').replace(/^\/+/, ''));
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      return await vscode.window.showTextDocument(document, { preview: false });
    } catch (err) {
      void vscode.window.showErrorMessage(`LanPair: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  async copyJoinInfo(): Promise<void> {
    const info = this.hostingInfo;
    if (!info) {
      void vscode.window.showWarningMessage('LanPair: not hosting a session.');
      return;
    }
    await vscode.env.clipboard.writeText(`LanPair session: ${this.joinAddress(info)}  PIN: ${info.pin}`);
    void vscode.window.showInformationMessage('LanPair: join info copied.');
  }

  async showMenu(): Promise<void> {
    type Item = vscode.QuickPickItem & { command: string };
    const items: Item[] =
      this.state.kind === 'idle'
        ? [
            { label: '$(broadcast) Start Hosting', command: 'lanpair.startHosting' },
            { label: '$(plug) Join Session…', command: 'lanpair.joinSession' },
          ]
        : this.state.kind === 'hosting'
          ? [
              { label: '$(copy) Copy Join Info', command: 'lanpair.copyJoinInfo', description: this.joinAddress(this.state.info) },
              { label: '$(debug-stop) Stop Session', command: 'lanpair.stopSession' },
            ]
          : [
              { label: '$(go-to-file) Open Remote File…', command: 'lanpair.openRemoteFile' },
              { label: '$(debug-disconnect) Leave Session', command: 'lanpair.stopSession' },
            ];
    const pick = await vscode.window.showQuickPick(items, { title: 'LanPair' });
    if (pick) await vscode.commands.executeCommand(pick.command);
  }

  stop(reason?: string): void {
    const state = this.state;
    this.state = { kind: 'idle' };
    this.status.update({ kind: 'idle' });
    if (state.kind === 'hosting') {
      for (const d of state.disposables) d.dispose();
      state.server.dispose();
      state.docs.dispose();
      this.log.appendLine('[host] session stopped');
    } else if (state.kind === 'guest') {
      for (const d of state.disposables) d.dispose();
      this.fs.setSession(undefined);
      state.client.dispose();
      state.client.registry.dispose();
      this.log.appendLine(`[guest] left session${reason ? ` (${reason})` : ''}`);
    }
  }

  dispose(): void {
    this.stop();
  }

  private becomeGuest(client: SessionClient): void {
    const closed = client.onDidClose((reason) => {
      if (this.state.kind === 'guest' && this.state.client === client) {
        this.stop(reason);
        void vscode.window.showWarningMessage(`LanPair: disconnected from host (${reason}).`);
      }
    });
    this.state = { kind: 'guest', client, disposables: [new vscode.Disposable(() => closed.dispose())] };
    this.fs.setSession(client);
    this.status.update({ kind: 'guest', hostName: client.welcome.hostName, rootName: client.welcome.rootName });
    this.log.appendLine(`[guest] joined ${client.welcome.hostName}'s "${client.welcome.rootName}"`);
  }

  private async askAddress(): Promise<{ host: string; port: number } | undefined> {
    const input = await vscode.window.showInputBox({
      title: 'LanPair: Join Session',
      prompt: "Host address shown in the host's notification",
      placeHolder: '192.168.0.10:45123',
      value: this.context.globalState.get<string>(LAST_ADDRESS_KEY),
      ignoreFocusOut: true,
      validateInput: (v) => (parseAddress(v) ? undefined : 'Use IP:port, for example 192.168.0.10:45123'),
    });
    return input ? parseAddress(input) : undefined;
  }

  private joinAddress(info: HostingInfo): string {
    return `${info.addresses[0] ?? '127.0.0.1'}:${info.port}`;
  }
}

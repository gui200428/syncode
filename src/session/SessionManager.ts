import { createHash, randomBytes, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { askIdentity, lanAddresses, readConfig } from '../config';
import { advertise, browse, type DiscoveredSession } from '../discovery/mdns';
import { remoteUri, SCHEME, type LanPairFs } from '../guest/LanPairFs';
import { MirrorDisk, type SyncResult } from '../guest/MirrorDisk';
import { isOpenInEditor, MirrorWorkspace } from '../guest/MirrorWorkspace';
import { JoinError, SessionClient } from '../guest/SessionClient';
import { HostDocuments } from '../host/HostDocuments';
import { SessionServer } from '../host/SessionServer';
import { WorkspaceIndex } from '../host/WorkspaceIndex';
import type { Logger } from '../log';
import { PROTOCOL_VERSION, type FsChange } from '../protocol';
import { normalizeDocPath } from '../sync/DocRegistry';
import { LocalUndo } from '../sync/LocalUndo';
import { RemoteCursors, safeColor, type DocLocator } from '../sync/RemoteCursors';
import type { StatusBar } from '../ui/StatusBar';

export interface HostingInfo {
  port: number;
  pin: string;
  addresses: string[];
  sessionId: string;
}

interface JoinTarget {
  host: string;
  port: number;
  pin: string;
}

type State =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | {
      kind: 'hosting';
      server: SessionServer;
      docs: HostDocuments;
      info: HostingInfo;
      cursors: RemoteCursors;
      undo: LocalUndo;
      disposables: vscode.Disposable[];
    }
  | {
      kind: 'guest';
      client: SessionClient;
      cursors: RemoteCursors;
      undo: LocalUndo;
      /** Set in mirror mode; otherwise the session is shown through LanPairFs. */
      mirror?: MirrorWorkspace;
      disposables: vscode.Disposable[];
    };

/** Join info kept for a mirror folder, so the window reconnects when it opens. */
interface MirrorTarget extends JoinTarget {
  sessionId: string;
}

type GuestMode = 'virtual' | 'mirror';

const LAST_ADDRESS_KEY = 'lanpair.lastAddress';
const GUEST_MODE_KEY = 'lanpair.lastGuestMode';
const secretKey = (sessionId: string) => `lanpair.join.${sessionId}`;
const mirrorKey = (folder: string) => `lanpair.mirror.${folder}`;

export function parseAddress(input: string): { host: string; port: number } | undefined {
  const m = /^\s*\[?([^\]\s]+?)\]?:(\d{1,5})\s*$/.exec(input);
  if (!m) return undefined;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1]!, port } : undefined;
}

/** ufw keeps its on/off switch in a world-readable file; no root needed. */
function ufwEnabled(): boolean {
  try {
    return /^ENABLED=yes/m.test(readFileSync('/etc/ufw/ufw.conf', 'utf8'));
  } catch {
    return false;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Owns the current session (host or guest) and implements the commands. */
export class SessionManager implements vscode.Disposable {
  private state: State = { kind: 'idle' };

  private readonly configListener: vscode.Disposable;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly fs: LanPairFs,
    private readonly status: StatusBar,
    private readonly log: Logger,
  ) {
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('lanpair')) return;
      const config = readConfig();
      this.cursors?.setUser({ name: config.displayName, color: safeColor(config.color) });
      this.cursors?.setNameLabels(config.nameLabels);
      if (this.state.kind === 'hosting' || this.state.kind === 'guest') this.state.undo.setEnabled(config.localUndo);
    });
  }

  /** Command: change the name/color shown to others (also during a session). */
  async setIdentity(): Promise<void> {
    await askIdentity({ forceColor: true });
  }

  get kind(): State['kind'] {
    return this.state.kind;
  }

  get hostingInfo(): HostingInfo | undefined {
    return this.state.kind === 'hosting' ? this.state.info : undefined;
  }

  get cursors(): RemoteCursors | undefined {
    return this.state.kind === 'hosting' || this.state.kind === 'guest' ? this.state.cursors : undefined;
  }

  /** Test hook: cuts the network connection(s) of the current session. */
  simulateNetworkDrop(): void {
    if (this.state.kind === 'hosting') this.state.server.simulateNetworkDrop();
    if (this.state.kind === 'guest') this.state.client.simulateNetworkDrop();
  }

  get guestConnected(): boolean | undefined {
    return this.state.kind === 'guest' ? this.state.client.isConnected : undefined;
  }

  /** Undo/redo own edits in shared editors; native undo elsewhere. */
  async undo(kind: 'undo' | 'redo'): Promise<void> {
    if (this.state.kind === 'hosting' || this.state.kind === 'guest') {
      await (kind === 'undo' ? this.state.undo.undo() : this.state.undo.redo());
    } else {
      await vscode.commands.executeCommand(kind);
    }
  }

  // Hosting

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
    if (!options.pin && !(await askIdentity())) return undefined;
    const config = readConfig();
    const pin = options.pin ?? randomInt(0, 1_000_000).toString().padStart(6, '0');
    const sessionId = randomBytes(4).toString('hex');
    const index = new WorkspaceIndex(folder.uri.fsPath, {
      maxFileBytes: config.maxFileBytes,
      exclude: config.exclude,
      respectGitignore: config.respectGitignore,
    });
    const docs = new HostDocuments(index, (m) => this.log.appendLine(`[host] ${m}`));
    let server: SessionServer;
    try {
      server = await SessionServer.start({
        port: config.port,
        pin,
        sessionId,
        hostName: config.displayName,
        rootName: path.basename(folder.uri.fsPath),
        docs,
        awareness: docs.registry.awareness,
        log: (m) => this.log.appendLine(`[server] ${m}`),
      });
    } catch (err) {
      docs.dispose();
      void vscode.window.showErrorMessage(`LanPair: could not open port ${config.port}: ${message(err)}`);
      return undefined;
    }

    const root = folder.uri.fsPath;
    const locator: DocLocator = {
      docIdFor: (document) => {
        if (document.uri.scheme !== 'file') return undefined;
        const bound = docs.bindingFor(document);
        if (bound) return bound.path;
        const rel = path.relative(root, document.uri.fsPath);
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? normalizeDocPath(rel) : undefined;
      },
      bindingFor: (document) => docs.bindingFor(document)?.binding,
      uriFor: (docId) => vscode.Uri.joinPath(folder.uri, docId),
    };
    const cursors = new RemoteCursors(
      docs.registry.awareness,
      locator,
      { name: config.displayName, color: safeColor(config.color) },
      config.nameLabels,
    );
    const undo = new LocalUndo(locator, config.localUndo);
    const info: HostingInfo = { port: server.port, pin, addresses: lanAddresses(), sessionId };
    const updateStatus = () =>
      this.status.update({ kind: 'hosting', pin, guests: server.guests.length, following: cursors.followed?.user.name });
    const guestsChanged = server.onDidChangeGuests(updateStatus);
    this.state = {
      kind: 'hosting',
      server,
      docs,
      info,
      cursors,
      undo,
      disposables: [
        new vscode.Disposable(() => guestsChanged.dispose()),
        docs.onDidChangeBindings(() => {
          cursors.refresh();
          undo.refresh();
        }),
        cursors.onDidChangeFollow(updateStatus),
        this.watchFolder(folder, index, server),
      ],
    };
    if (config.advertise) {
      const ad = advertise(
        { sessionId, hostName: config.displayName, rootName: path.basename(root), port: server.port },
        (m) => this.log.appendLine(`[mdns] ${m}`),
      );
      this.state.disposables.push(new vscode.Disposable(() => ad.dispose()));
    }
    updateStatus();
    this.log.appendLine(`[host] sharing ${root} on port ${info.port} (session ${sessionId})`);

    if (!options.pin) {
      void vscode.window
        .showInformationMessage(`LanPair: hosting on ${this.joinAddress(info)} — PIN ${pin}`, 'Copy Join Info')
        .then((action) => (action ? this.copyJoinInfo() : undefined));
      if (process.platform === 'win32') {
        void vscode.window.showInformationMessage(
          'LanPair: if Windows asks about the firewall, allow access on private networks so guests can connect. ' +
            'Set "lanpair.port" to keep the same port (and firewall rule) across sessions.',
        );
      } else if (process.platform === 'linux' && ufwEnabled()) {
        void this.showUfwHint(info, config.port === 0);
      }
    }
    return info;
  }

  private async showUfwHint(info: HostingInfo, randomPort: boolean): Promise<void> {
    const subnet = info.addresses[0] ? `${info.addresses[0].split('.').slice(0, 3).join('.')}.0/24` : 'any';
    const command = `sudo ufw allow from ${subnet} to any port ${info.port} proto tcp comment LanPair`;
    const action = await vscode.window.showWarningMessage(
      `LanPair: the ufw firewall is enabled and blocks incoming connections by default, so guests may get "No answer". ` +
        `Allow the port with: ${command}` +
        (randomPort ? ' — set "lanpair.port" to a fixed port first so the rule keeps working.' : ''),
      'Copy Command',
      ...(randomPort ? ['Open Settings'] : []),
    );
    if (action === 'Copy Command') await vscode.env.clipboard.writeText(command);
    if (action === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'lanpair.port');
  }

  /** Tells guests about files created, changed or deleted on the host (batched). */
  private watchFolder(folder: vscode.WorkspaceFolder, index: WorkspaceIndex, server: SessionServer): vscode.Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
    let batch = new Map<string, FsChange['type']>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const add = (uri: vscode.Uri, type: FsChange['type']) => {
      const rel = path.relative(folder.uri.fsPath, uri.fsPath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
      const docId = normalizeDocPath(rel);
      if (docId === '.gitignore' || docId.endsWith('/.gitignore')) index.invalidateGitignore();
      void index.isHidden(docId).then((hidden) => {
        if (!hidden) queue(docId, type);
      });
    };
    const queue = (docId: string, type: FsChange['type']) => {
      batch.set(docId, type);
      timer ??= setTimeout(() => {
        timer = undefined;
        const changes = [...batch].map(([p, t]) => ({ path: p, type: t }));
        batch = new Map();
        server.notifyAll({ event: 'fs', changes });
      }, 150);
    };
    return vscode.Disposable.from(
      watcher,
      watcher.onDidCreate((u) => add(u, 'created')),
      watcher.onDidChange((u) => add(u, 'changed')),
      watcher.onDidDelete((u) => add(u, 'deleted')),
      new vscode.Disposable(() => timer && clearTimeout(timer)),
    );
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

  // Joining

  /**
   * Connects to a host. Unless `inPlace`, the host's folder is then opened as
   * this window's workspace (or in a new window if this one has a folder);
   * the extension reconnects there using the join info kept in SecretStorage.
   */
  async join(target?: JoinTarget, options: { inPlace?: boolean } = {}): Promise<boolean> {
    if (this.state.kind !== 'idle') {
      void vscode.window.showWarningMessage('LanPair: a session is already running. Stop it first.');
      return false;
    }
    if (!target && !(await askIdentity())) return false;
    const address = target ? { host: target.host, port: target.port } : await this.askAddress();
    if (!address) return false;
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
      const joinTarget = { ...address, pin: pin.trim() };
      let client: SessionClient;
      try {
        client = await this.connect(joinTarget);
      } catch (err) {
        if (err instanceof JoinError && err.code === 'pin' && !target) {
          void vscode.window.showWarningMessage(`LanPair: wrong PIN (${err.attemptsLeft} attempts left).`);
          pin = undefined;
          continue;
        }
        void vscode.window.showErrorMessage(`LanPair: ${message(err)}`);
        return false;
      }
      await this.context.globalState.update(LAST_ADDRESS_KEY, `${address.host}:${address.port}`);
      const sessionId = client.welcome.sessionId;
      const folderUri = remoteUri(sessionId, '');
      const alreadyOpen = vscode.workspace.workspaceFolders?.some(
        (f) => f.uri.scheme === SCHEME && f.uri.authority === sessionId,
      );
      if (options.inPlace || alreadyOpen) {
        this.becomeGuest(client);
        return true;
      }
      const mode = await this.askGuestMode(client.welcome.rootName);
      if (mode === 'mirror') return this.joinMirror(client, joinTarget);
      if (!mode) {
        client.dispose();
        return false;
      }
      await this.context.secrets.store(secretKey(sessionId), JSON.stringify(joinTarget));
      client.dispose();
      const hasFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0 || !!vscode.workspace.workspaceFile;
      await vscode.commands.executeCommand('vscode.openFolder', folderUri, { forceNewWindow: hasFolder });
      return true;
    }
  }

  /** On activation: reconnect if this window's workspace is a LanPair folder or a mirror. */
  resumeFromWorkspace(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === SCHEME);
    if (!folder) return this.resumeMirror();
    if (this.state.kind !== 'idle') return Promise.resolve();
    const sessionId = folder.uri.authority;
    // Registered synchronously, so the workbench's first reads wait for us.
    let settle!: (client: SessionClient | undefined) => void;
    this.fs.setConnecting(sessionId, new Promise((r) => (settle = r)));
    this.state = { kind: 'connecting' };
    return this.resume(sessionId).then(settle, () => settle(undefined));
  }

  private async resume(sessionId: string): Promise<SessionClient | undefined> {
    const stored = (await this.context.secrets.get(secretKey(sessionId))) ?? process.env.LANPAIR_TEST_JOIN;
    if (!stored) {
      this.state = { kind: 'idle' };
      void vscode.window
        .showErrorMessage('LanPair: this window shows a LanPair session but the join info is missing.', 'Join Session…', 'Close Folder')
        .then((a) => this.onResumeFailed(a));
      return undefined;
    }
    const target = JSON.parse(stored) as JoinTarget;
    this.status.update({ kind: 'connecting', address: `${target.host}:${target.port}` });
    let client: SessionClient;
    try {
      client = await this.connect(target);
    } catch (err) {
      this.state = { kind: 'idle' };
      this.status.update({ kind: 'idle' });
      void vscode.window
        .showErrorMessage(`LanPair: could not reconnect: ${message(err)}`, 'Join Session…', 'Close Folder')
        .then((a) => this.onResumeFailed(a));
      return undefined;
    }
    this.state = { kind: 'idle' };
    if (client.welcome.sessionId !== sessionId) {
      // The host restarted its session: offer to open the new one.
      await this.context.secrets.delete(secretKey(sessionId));
      await this.context.secrets.store(secretKey(client.welcome.sessionId), stored);
      client.dispose();
      this.status.update({ kind: 'idle' });
      void vscode.window
        .showWarningMessage(`LanPair: ${client.welcome.hostName} started a new session.`, 'Open New Session')
        .then((action) =>
          action
            ? vscode.commands.executeCommand('vscode.openFolder', remoteUri(client.welcome.sessionId, ''), { forceNewWindow: false })
            : undefined,
        );
      return undefined;
    }
    this.becomeGuest(client);
    return client;
  }

  private async onResumeFailed(action: string | undefined): Promise<void> {
    if (action === 'Join Session…') await this.join();
    if (action === 'Close Folder') await vscode.commands.executeCommand('workbench.action.closeFolder');
  }

  // Mirror mode

  private async askGuestMode(rootName: string): Promise<GuestMode | undefined> {
    type Item = vscode.QuickPickItem & { mode: GuestMode };
    const items: Item[] = [
      {
        label: '$(remote-explorer) Open the shared folder',
        description: 'nothing is written to this machine',
        detail: 'Files are read from the host. Language features that need files on disk do not work.',
        mode: 'virtual',
      },
      {
        label: '$(folder-opened) Mirror into a local folder',
        description: 'IntelliSense, terminals and tools work',
        detail: "The host's files are copied to a folder you pick and kept in sync while you are connected.",
        mode: 'mirror',
      },
    ];
    if (this.context.globalState.get<GuestMode>(GUEST_MODE_KEY) === 'mirror') items.reverse();
    const pick = await vscode.window.showQuickPick(items, {
      title: `LanPair: Join "${rootName}"`,
      placeHolder: 'How do you want to open the shared folder?',
      ignoreFocusOut: true,
    });
    if (pick) await this.context.globalState.update(GUEST_MODE_KEY, pick.mode);
    return pick?.mode;
  }

  private async pickMirrorFolder(rootName: string): Promise<vscode.Uri | undefined> {
    const current = vscode.workspace.workspaceFolders?.[0]?.uri;
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Mirror Here',
      title: `LanPair: folder for "${rootName}" (empty, or a clone of the same project)`,
      defaultUri: current?.scheme === 'file' ? current : undefined,
    });
    const folder = picked?.[0];
    if (!folder) return undefined;
    if (folder.fsPath === os.homedir() || path.parse(folder.fsPath).root === folder.fsPath) {
      void vscode.window.showErrorMessage('LanPair: pick a project folder, not your home or root folder.');
      return undefined;
    }
    return folder;
  }

  private async joinMirror(client: SessionClient, target: JoinTarget): Promise<boolean> {
    const folder = await this.pickMirrorFolder(client.welcome.rootName);
    if (!folder) {
      client.dispose();
      return false;
    }
    const record: MirrorTarget = { ...target, sessionId: client.welcome.sessionId };
    await this.context.secrets.store(mirrorKey(folder.fsPath), JSON.stringify(record));
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 1 && folders[0]!.uri.scheme === 'file' && folders[0]!.uri.fsPath === folder.fsPath) {
      await this.startMirror(client, folder);
      return true;
    }
    // The window opened on the folder reconnects with the stored join info.
    client.dispose();
    const hasFolder = folders.length > 0 || !!vscode.workspace.workspaceFile;
    await vscode.commands.executeCommand('vscode.openFolder', folder, { forceNewWindow: hasFolder });
    return true;
  }

  /** The single local folder of this window, if it is (or was) a mirror. */
  private async mirrorFolder(): Promise<{ root: vscode.Uri; target: MirrorTarget } | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length !== 1 || folders[0]!.uri.scheme !== 'file') return undefined;
    const root = folders[0]!.uri;
    const stored = (await this.context.secrets.get(mirrorKey(root.fsPath))) ?? process.env.LANPAIR_TEST_MIRROR;
    return stored ? { root, target: JSON.parse(stored) as MirrorTarget } : undefined;
  }

  private async resumeMirror(): Promise<void> {
    if (this.state.kind !== 'idle') return;
    const mirror = await this.mirrorFolder();
    if (mirror) await this.reconnectMirror(mirror.root, mirror.target);
  }

  /** Command: reconnect this mirror folder after it went offline. */
  async reconnectMirrorCommand(): Promise<void> {
    const mirror = this.state.kind === 'idle' ? await this.mirrorFolder() : undefined;
    if (!mirror) {
      void vscode.window.showWarningMessage('LanPair: this window is not a mirror folder (or a session is running).');
      return;
    }
    await this.reconnectMirror(mirror.root, mirror.target);
  }

  private async reconnectMirror(root: vscode.Uri, target: MirrorTarget): Promise<void> {
    const key = mirrorKey(root.fsPath);
    let client: SessionClient;
    for (;;) {
      if (this.state.kind !== 'idle') return;
      this.state = { kind: 'connecting' };
      this.status.update({ kind: 'connecting', address: `${target.host}:${target.port}` });
      try {
        client = await this.connect(target);
        this.state = { kind: 'idle' };
        break;
      } catch (err) {
        this.state = { kind: 'idle' };
        this.status.update({ kind: 'idle' });
        const wrongPin = err instanceof JoinError && err.code === 'pin';
        const action = await vscode.window.showWarningMessage(
          `LanPair: could not reconnect this mirror to ${target.host}:${target.port}: ` +
            (wrongPin ? 'wrong PIN (the host may have started a new session).' : `${message(err)} The folder stays a local copy.`),
          wrongPin ? 'Enter PIN…' : 'Retry',
          'Stop Mirroring',
        );
        if (action === 'Stop Mirroring') {
          await this.context.secrets.delete(key);
          return;
        }
        if (action === 'Enter PIN…') {
          const pin = await vscode.window.showInputBox({
            title: 'LanPair: Reconnect Mirror',
            prompt: `PIN shown by the host (${target.host}:${target.port})`,
            placeHolder: '6 digits',
            ignoreFocusOut: true,
            validateInput: (v) => (/^\d{6}$/.test(v.trim()) ? undefined : 'Enter the 6-digit PIN'),
          });
          if (!pin) return;
          target = { ...target, pin: pin.trim() };
        } else if (action !== 'Retry') {
          return;
        }
      }
    }
    if (client.welcome.sessionId !== target.sessionId) {
      this.log.appendLine(`[mirror] ${client.welcome.hostName} started a new session; syncing the folder with it`);
    }
    await this.context.secrets.store(key, JSON.stringify({ ...target, sessionId: client.welcome.sessionId }));
    await this.startMirror(client, root);
  }

  private async confirmReplace(hostName: string, paths: string[]): Promise<boolean> {
    const shown = paths.slice(0, 8).join(', ') + (paths.length > 8 ? ` and ${paths.length - 8} more` : '');
    const pick = await vscode.window.showWarningMessage(
      `LanPair: ${paths.length === 1 ? '1 file' : `${paths.length} files`} in this folder differ from ${hostName}'s version.`,
      {
        modal: true,
        detail: `${shown}\n\nReplace them with the host's files, or keep yours for now (the host's next change to a kept file replaces it).`,
      },
      'Replace',
      'Keep Mine',
    );
    return pick === 'Replace';
  }

  /** Becomes a mirror guest of `client` in the local folder `root` and syncs it. */
  async startMirror(client: SessionClient, root: vscode.Uri): Promise<SyncResult | undefined> {
    const log = (m: string) => this.log.appendLine(`[mirror] ${m}`);
    const manifest = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      'mirrors',
      `${createHash('sha1').update(root.fsPath).digest('hex')}.json`,
    ).fsPath;
    const disk = new MirrorDisk(root.fsPath, client, manifest, {
      isLive: (rel) => isOpenInEditor(root, rel),
      confirmReplace: (paths) => this.confirmReplace(client.welcome.hostName, paths),
      log,
    });
    const mirror = new MirrorWorkspace(client, root, disk, log);
    this.becomeGuest(client, mirror);
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `LanPair: mirroring "${client.welcome.rootName}"…` },
        () => mirror.start(),
      );
      log(`folder in sync (${result.written} written, ${result.deleted} deleted, ${result.kept} kept)`);
      return result;
    } catch (err) {
      if (this.state.kind === 'guest' && this.state.client === client) this.stop();
      void vscode.window.showErrorMessage(`LanPair: could not mirror the shared folder: ${message(err)}`);
      return undefined;
    }
  }

  /** Test hook: joins and mirrors into `folder` (this window's workspace folder). */
  async joinMirrorInPlace(target: JoinTarget, folder: vscode.Uri): Promise<SyncResult | undefined> {
    if (this.state.kind !== 'idle') return undefined;
    return this.startMirror(await this.connect(target), folder);
  }

  private connect(target: JoinTarget): Promise<SessionClient> {
    const config = readConfig();
    return SessionClient.connect({
      host: target.host,
      port: target.port,
      pin: target.pin,
      name: config.displayName,
      color: safeColor(config.color),
      log: (m) => this.log.appendLine(`[guest] ${m}`),
    });
  }

  private becomeGuest(client: SessionClient, mirror?: MirrorWorkspace): void {
    const config = readConfig();
    const view = mirror ?? this.fs;
    const cursors = new RemoteCursors(
      client.registry.awareness,
      view,
      { name: config.displayName, color: safeColor(config.color) },
      config.nameLabels,
    );
    const updateStatus = () =>
      this.status.update({
        kind: 'guest',
        hostName: client.welcome.hostName,
        rootName: client.welcome.rootName,
        following: cursors.followed?.user.name,
        reconnecting: !client.isConnected,
        mirror: !!mirror,
      });
    const stateChanged = client.onDidChangeState((state) => {
      this.log.appendLine(`[guest] ${state === 'connected' ? 'reconnected' : 'connection lost, reconnecting…'}`);
      updateStatus();
    });
    const closed = client.onDidClose((reason) => {
      if (this.state.kind === 'guest' && this.state.client === client) {
        this.stop(reason);
        void vscode.window.showWarningMessage(`LanPair: session ended (${reason}).`);
      }
    });
    const undo = new LocalUndo(view, config.localUndo);
    this.state = {
      kind: 'guest',
      client,
      cursors,
      undo,
      mirror,
      disposables: [
        new vscode.Disposable(() => closed.dispose()),
        new vscode.Disposable(() => stateChanged.dispose()),
        view.onDidChangeBindings(() => {
          cursors.refresh();
          undo.refresh();
        }),
        cursors.onDidChangeFollow(updateStatus),
      ],
    };
    if (!mirror) this.fs.setSession(client);
    updateStatus();
    this.log.appendLine(
      `[guest] joined ${client.welcome.hostName}'s "${client.welcome.rootName}"${mirror ? ` (mirror in ${mirror.root.fsPath})` : ''}`,
    );
  }

  // Shared commands

  /** Opens a host file by path (also reachable through the Explorer). */
  async openRemoteFile(relPath?: string): Promise<vscode.TextEditor | undefined> {
    if (this.state.kind !== 'guest') {
      void vscode.window.showWarningMessage('LanPair: join a session first.');
      return undefined;
    }
    const client = this.state.client;
    relPath ??= await vscode.window.showInputBox({
      title: `LanPair: Open file from ${client.welcome.rootName}`,
      prompt: 'Path relative to the shared folder',
      placeHolder: 'src/index.ts',
      ignoreFocusOut: true,
    });
    if (!relPath) return undefined;
    const rel = normalizeDocPath(relPath.trim());
    const uri = this.state.mirror ? this.state.mirror.uriFor(rel) : remoteUri(client.welcome.sessionId, rel);
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      return await vscode.window.showTextDocument(document, { preview: false });
    } catch (err) {
      void vscode.window.showErrorMessage(`LanPair: ${message(err)}`);
      return undefined;
    }
  }

  async followParticipant(): Promise<void> {
    const cursors = this.cursors;
    if (!cursors) {
      void vscode.window.showWarningMessage('LanPair: no session is running.');
      return;
    }
    type Item = vscode.QuickPickItem & { clientId?: number };
    const items: Item[] = cursors.participants().map((p) => ({
      label: `$(person) ${p.user.name}`,
      description: p.file ?? 'no file open',
      clientId: p.clientId,
    }));
    if (cursors.followed) items.unshift({ label: '$(circle-slash) Stop Following' });
    if (items.length === 0) {
      void vscode.window.showInformationMessage('LanPair: nobody else is in the session yet.');
      return;
    }
    const pick = await vscode.window.showQuickPick(items, { title: 'LanPair: Follow Participant' });
    if (pick) cursors.follow(pick.clientId);
  }

  async showMenu(): Promise<void> {
    type Item = vscode.QuickPickItem & { command: string };
    const follow: Item = { label: '$(eye) Follow Participant…', command: 'lanpair.followParticipant' };
    const identity: Item = { label: '$(account) Set Name and Color…', command: 'lanpair.setIdentity', description: readConfig().displayName };
    const items: Item[] =
      this.state.kind === 'hosting'
        ? [
            { label: '$(copy) Copy Join Info', command: 'lanpair.copyJoinInfo', description: this.joinAddress(this.state.info) },
            follow,
            identity,
            { label: '$(debug-stop) Stop Session', command: 'lanpair.stopSession' },
          ]
        : this.state.kind === 'guest'
          ? [
              follow,
              { label: '$(go-to-file) Open Remote File…', command: 'lanpair.openRemoteFile' },
              identity,
              {
                label: '$(debug-disconnect) Leave Session',
                command: 'lanpair.stopSession',
                description: this.state.mirror ? 'the folder keeps the files' : undefined,
              },
            ]
          : [
              { label: '$(broadcast) Start Hosting', command: 'lanpair.startHosting' },
              { label: '$(plug) Join Session…', command: 'lanpair.joinSession' },
              ...((await this.mirrorFolder()) ? [{ label: '$(sync) Reconnect Mirror', command: 'lanpair.reconnectMirror' }] : []),
              identity,
            ];
    const pick = await vscode.window.showQuickPick(items, { title: 'LanPair' });
    if (pick) await vscode.commands.executeCommand(pick.command);
  }

  /**
   * Stop Session command: also forgets the guest's join info and closes the
   * LanPair folder. A mirror folder stays open as a plain local copy.
   */
  async leave(): Promise<void> {
    const state = this.state;
    this.stop();
    if (state.kind === 'guest' && state.mirror) {
      await this.context.secrets.delete(mirrorKey(state.mirror.root.fsPath));
      void vscode.window.showInformationMessage('LanPair: left the session. This folder keeps the files as a local copy.');
    } else if (state.kind === 'guest') {
      const sessionId = state.client.welcome.sessionId;
      await this.context.secrets.delete(secretKey(sessionId));
      if (vscode.workspace.workspaceFolders?.some((f) => f.uri.scheme === SCHEME && f.uri.authority === sessionId)) {
        await vscode.commands.executeCommand('workbench.action.closeFolder');
      }
    }
  }

  stop(reason?: string): void {
    const state = this.state;
    this.state = { kind: 'idle' };
    this.status.update({ kind: 'idle' });
    if (state.kind === 'hosting') {
      for (const d of state.disposables) d.dispose();
      state.cursors.dispose();
      state.undo.dispose();
      state.server.dispose();
      state.docs.dispose();
      this.log.appendLine('[host] session stopped');
    } else if (state.kind === 'guest') {
      for (const d of state.disposables) d.dispose();
      state.cursors.dispose();
      state.undo.dispose();
      if (state.mirror) state.mirror.dispose();
      else this.fs.setSession(undefined);
      state.client.dispose();
      state.client.registry.dispose();
      this.log.appendLine(`[guest] left session${reason ? ` (${reason})` : ''}`);
    }
  }

  dispose(): void {
    this.configListener.dispose();
    this.stop();
  }

  /** QuickPick with sessions found on the LAN (live) plus manual entry. */
  private askAddress(): Promise<{ host: string; port: number } | undefined> {
    type Item = vscode.QuickPickItem & { session?: DiscoveredSession; manual?: boolean };
    const manual: Item = {
      label: '$(edit) Enter address manually…',
      description: this.context.globalState.get<string>(LAST_ADDRESS_KEY),
      manual: true,
      alwaysShow: true,
    };
    const pick = vscode.window.createQuickPick<Item>();
    pick.title = 'LanPair: Join Session';
    pick.placeholder = 'Looking for sessions on your network…';
    pick.busy = true;
    pick.ignoreFocusOut = true;
    pick.items = [manual];
    const browser = browse(
      (sessions) => {
        const found: Item[] = sessions.map((s) => ({
          label: `$(broadcast) ${s.hostName}`,
          description: `${s.rootName} — ${s.address}:${s.port}`,
          detail: s.protocol === PROTOCOL_VERSION ? undefined : '$(warning) Different LanPair version: update both machines',
          session: s,
        }));
        pick.items = [...found, manual];
        pick.placeholder = found.length > 0 ? 'Pick a session or enter an address' : 'Looking for sessions on your network…';
      },
      (m) => this.log.appendLine(`[mdns] ${m}`),
    );
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: { host: string; port: number } | undefined) => {
        if (done) return;
        done = true;
        browser.dispose();
        pick.dispose();
        resolve(value);
      };
      pick.onDidAccept(async () => {
        const item = pick.selectedItems[0];
        if (item?.session) {
          finish({ host: item.session.address, port: item.session.port });
        } else if (item?.manual) {
          pick.hide();
        }
      });
      pick.onDidHide(async () => {
        if (done) return;
        const item = pick.selectedItems[0];
        if (!item?.manual) return finish(undefined);
        browser.dispose();
        const input = await vscode.window.showInputBox({
          title: 'LanPair: Join Session',
          prompt: "Host address shown in the host's notification",
          placeHolder: '192.168.0.10:45123',
          value: this.context.globalState.get<string>(LAST_ADDRESS_KEY),
          ignoreFocusOut: true,
          validateInput: (v) => (parseAddress(v) ? undefined : 'Use IP:port, for example 192.168.0.10:45123'),
        });
        finish(input ? parseAddress(input) : undefined);
      });
      pick.show();
    });
  }

  private joinAddress(info: HostingInfo): string {
    return `${info.addresses[0] ?? '127.0.0.1'}:${info.port}`;
  }
}

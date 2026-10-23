/**
 * Mirror mode with two editor instances. The guest window is opened on an
 * empty local folder and reconnects on activation (SYNCODE_TEST_MIRROR), like
 * after "Join Session" → "Mirror into a local folder". Covers the initial
 * copy, host file events, the guest's own language server on the mirror,
 * live editing of open files, saves in both directions, a network drop and
 * simultaneous typing. Coordinates through files in SYNCODE_PAIR_DIR.
 */
import * as assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SynCodeApi } from '../../src/extension';

const role = process.env.SYNCODE_ROLE as 'host' | 'guest';
const dir = process.env.SYNCODE_PAIR_DIR!;
const seconds = Number(process.env.SYNCODE_PAIR_SECONDS ?? '120');
const PIN = '424242';
const FILE = 'shared.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lf = (s: string) => s.replace(/\r\n/g, '\n');
const signal = (name: string, content = '') => writeFileSync(path.join(dir, name), content);
const read = (name: string) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), 'utf8') : undefined);
const readText = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);

async function waitFor<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`[${role}] timeout waiting for ${what}`);
    await sleep(100);
  }
}

let logOf: SynCodeApi | undefined;

function step(name: string): void {
  // The log line count shows which step a logged problem belongs to.
  console.log(`[${role}] ${new Date().toISOString().slice(11, 23)} ${name}${logOf ? ` (log line ${logOf.recentLogLines().length})` : ''}`);
}

async function api(): Promise<SynCodeApi> {
  const ext = vscode.extensions.getExtension<SynCodeApi>('syncode.syncode');
  assert.ok(ext);
  return ext.activate();
}

/** Random typing for `ms` milliseconds in the given editor. */
async function typeFor(editor: vscode.TextEditor, ms: number, seed: number): Promise<number> {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const int = (n: number) => Math.floor(rand() * n);
  const words = ['const ', 'x', ' = ', '1;', '\n', 'foo(', ')', '{', '}', role === 'host' ? 'H' : 'G', 'é', '😀', '  '];
  const end = Date.now() + ms;
  let ops = 0;
  while (Date.now() < end) {
    const doc = editor.document;
    const op = rand();
    if (op < 0.6) {
      await vscode.commands.executeCommand('type', { text: words[int(words.length)] });
    } else if (op < 0.72) {
      await vscode.commands.executeCommand('deleteLeft');
    } else if (op < 0.85) {
      const p = doc.positionAt(int(doc.getText().length + 1));
      editor.selection = new vscode.Selection(p, p);
    } else if (op < 0.95) {
      await vscode.commands.executeCommand('type', { text: `// ${role} block ${ops}\nlet v${ops} = ${ops};\n` });
    } else {
      await sleep(int(40));
    }
    ops++;
    await sleep(5 + int(25));
  }
  return ops;
}

async function converge(document: vscode.TextDocument): Promise<void> {
  const other = role === 'host' ? 'guest' : 'host';
  let stableSince: number | undefined;
  await waitFor('convergence', () => {
    const mine = lf(document.getText());
    signal(`${role}-text.txt`, mine);
    if (read(`${other}-text.txt`) === mine) {
      stableSince ??= Date.now();
      return Date.now() - stableSince > 2000;
    }
    stableSince = undefined;
    return false;
  });
}

function assertNoProblems(syncode: SynCodeApi): void {
  const lines = syncode.recentLogLines();
  const problems = lines.filter((l) => /out of sync|threw|resolved before|error|could not/i.test(l));
  if (problems.length > 0) console.log(`[${role}] log:\n${lines.join('\n')}`);
  assert.deepEqual(problems, []);
}

/** Saves of shared files run the other side's save participants too; keep the random text unformatted. */
async function disableFormatOnSave(): Promise<void> {
  await vscode.workspace
    .getConfiguration('editor', { languageId: 'typescript' })
    .update('formatOnSave', false, vscode.ConfigurationTarget.Global, true);
}

async function host(syncode: SynCodeApi): Promise<void> {
  const folder = vscode.workspace.workspaceFolders![0]!.uri;
  const sharedUri = vscode.Uri.joinPath(folder, FILE);
  const info = await syncode.startHosting(PIN);
  assert.ok(info, 'hosting failed');
  signal('host.json', JSON.stringify({ port: info.port, sessionId: info.sessionId }));

  step('waiting for the guest');
  await waitFor('guest connected', () => syncode.participants().length === 1);
  await waitFor('guest mirrored the folder', () => read('guest-mirrored'));

  step('host file events');
  writeFileSync(path.join(folder.fsPath, 'created-by-host.txt'), 'hi');
  const util = path.join(folder.fsPath, 'src/util.ts');
  writeFileSync(util, readFileSync(util, 'utf8').replace('n * 2', 'n + n'));
  signal('host-files-changed');
  await waitFor('guest saw the file events', () => read('guest-files-ok'), 30_000);
  await waitFor('guest language server', () => read('guest-lsp-ok'), 120_000);
  assert.ok(!existsSync(path.join(folder.fsPath, 'local-use.ts')), 'a guest-only file reached the host');

  step('live editing');
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sharedUri));
  assert.equal(await editor.edit((b) => b.insert(new vscode.Position(0, 0), '// HOSTLIVE\n')), true);
  signal('host-live');
  await waitFor('guest edit', () => editor.document.getText().includes('GUESTLIVE'));

  step('guest save');
  await waitFor('guest saved', () => read('guest-saved-1'));
  await waitFor('host document saved by the guest', () => !editor.document.isDirty, 10_000);
  const disk1 = readFileSync(sharedUri.fsPath, 'utf8');
  assert.ok(disk1.includes('HOSTLIVE') && disk1.includes('GUESTLIVE'));
  signal('host-saw-guest-save');

  step('host save');
  const hostEd = await vscode.window.showTextDocument(editor.document);
  assert.equal(await hostEd.edit((b) => b.insert(new vscode.Position(0, 0), '// HOSTSAVE\n')), true);
  await sleep(300);
  assert.equal(await hostEd.document.save(), true);
  signal('host-saved', readFileSync(sharedUri.fsPath, 'utf8'));
  await waitFor('guest saved its copy', () => read('guest-host-save-ok'), 15_000);

  step('network drop');
  await waitFor('guest ready', () => read('guest-ready-drop'));
  syncode.simulateNetworkDrop();
  writeFileSync(path.join(folder.fsPath, 'while-offline.txt'), 'offline');
  assert.equal(await hostEd.edit((b) => b.insert(new vscode.Position(0, 0), '// HOSTOFFLINE\n')), true);
  signal('host-dropped');
  await waitFor('offline edits merged', () => editor.document.getText().includes('GUESTOFFLINE'), 30_000);
  await waitFor('guest resynced', () => read('guest-merged'), 30_000);

  step('host deletes a file');
  rmSync(path.join(folder.fsPath, 'created-by-host.txt'));
  signal('host-deleted');
  await waitFor('guest deleted it', () => read('guest-delete-ok'), 15_000);

  step(`typing for ${seconds}s`);
  signal('host-typing');
  await waitFor('guest typing', () => read('guest-typing'));
  const typing = await vscode.window.showTextDocument(editor.document);
  const ops = await typeFor(typing, seconds * 1000, 1);
  step(`${ops} operations`);
  await converge(editor.document);
  step(`converged at ${editor.document.getText().length} chars`);
  signal('host-converged');

  await waitFor('guest saved', () => read('guest-saved-2'));
  await waitFor('host document saved', () => !editor.document.isDirty, 10_000);
  const disk = readFileSync(sharedUri.fsPath, 'utf8');
  assert.equal(lf(disk), lf(editor.document.getText()));
  signal('host-final.txt', disk);
  assertNoProblems(syncode);
  signal('host-done');
  await waitFor('guest done', () => read('guest-done'));
  syncode.stop();
}

async function guest(syncode: SynCodeApi): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root && root.scheme === 'file', 'guest window should be on a local folder');
  const local = (rel: string) => path.join(root.fsPath, rel);
  const sharedUri = vscode.Uri.joinPath(root, FILE);

  step('initial mirror');
  await waitFor('session resumed', () => syncode.sessionKind() === 'guest', 30_000);
  await waitFor('folder in sync', () => syncode.recentLogLines().some((l) => l.includes('folder in sync')), 30_000);
  const hostShared = readText(local(FILE));
  assert.ok(hostShared?.includes('export function add'), 'shared.ts was not mirrored');
  assert.ok(readText(local('src/util.ts'))?.includes('twice'));
  assert.deepEqual([...readFileSync(local('image.png'))], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  assert.ok(!existsSync(local('node_modules')), 'excluded folder was mirrored');
  signal('guest-mirrored');

  step('host file events');
  await waitFor('host changed files', () => read('host-files-changed'));
  await waitFor('created file mirrored', () => readText(local('created-by-host.txt')) === 'hi', 15_000);
  await waitFor('changed file mirrored', () => readText(local('src/util.ts'))?.includes('n + n'), 15_000);
  signal('guest-files-ok');

  step('language server on the mirror');
  // A file that exists only here, using a mirrored one: the guest's own
  // TypeScript server resolves it on disk.
  writeFileSync(local('local-use.ts'), "import { twice } from './src/util';\nexport const eight = twice(4);\n");
  const use = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'local-use.ts'));
  await vscode.window.showTextDocument(use);
  const at = new vscode.Position(1, use.lineAt(1).text.indexOf('twice') + 1);
  const target = await waitFor(
    'go to definition',
    async () => {
      const defs = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>('vscode.executeDefinitionProvider', use.uri, at);
      const uris = (defs ?? []).map((d) => ('targetUri' in d ? d.targetUri : d.uri));
      return uris.find((u) => u.fsPath === local('src/util.ts'));
    },
    90_000,
  );
  assert.equal(target.fsPath, local('src/util.ts'));
  signal('guest-lsp-ok');

  await disableFormatOnSave();

  step('live editing');
  await waitFor('host edited', () => read('host-live'));
  const editor = await vscode.window.showTextDocument(sharedUri, { preview: false });
  // The local file is the saved version; the binding brings in the host's unsaved edit.
  await waitFor('unsaved host edit', () => editor.document.getText().includes('HOSTLIVE'), 15_000);
  assert.equal(editor.document.isDirty, true);
  assert.ok(!readText(local(FILE))!.includes('HOSTLIVE'), 'unsaved host edit written to the mirror');
  await waitFor('host cursor', () => syncode.remoteHeads().some((h) => h.uri === sharedUri.toString()), 15_000);
  editor.selection = new vscode.Selection(1, 0, 1, 0);
  await vscode.commands.executeCommand('type', { text: '// GUESTLIVE\n' });

  step('guest save');
  await waitFor('own edit in Y', () => editor.document.getText().includes('GUESTLIVE'));
  assert.equal(await editor.document.save(), true);
  assert.ok(readText(local(FILE))!.includes('GUESTLIVE'));
  signal('guest-saved-1');
  await waitFor('host checked', () => read('host-saw-guest-save'));

  step('host save');
  const hostDisk = await waitFor('host saved', () => read('host-saved'));
  await waitFor('local copy saved', () => editor.document.getText().includes('HOSTSAVE') && !editor.document.isDirty, 15_000);
  assert.equal(lf(readText(local(FILE))!), lf(hostDisk));
  signal('guest-host-save-ok');

  step('network drop');
  signal('guest-ready-drop');
  await waitFor('host dropped us', () => read('host-dropped'));
  await waitFor('reconnecting', () => syncode.guestConnected() === false || syncode.guestConnected() === true, 15_000);
  const ed = await vscode.window.showTextDocument(editor.document);
  assert.equal(await ed.edit((b) => b.insert(new vscode.Position(0, 0), '// GUESTOFFLINE\n')), true);
  await waitFor('reconnected', () => syncode.guestConnected() === true, 30_000);
  await waitFor('offline host edit', () => ed.document.getText().includes('HOSTOFFLINE'), 30_000);
  // Missed while disconnected: picked up by the resync after reconnecting.
  await waitFor('file created while offline', () => readText(local('while-offline.txt')) === 'offline', 30_000);
  signal('guest-merged');

  step('host deletes a file');
  await waitFor('host deleted', () => read('host-deleted'));
  await waitFor('deleted here', () => !existsSync(local('created-by-host.txt')), 15_000);
  signal('guest-delete-ok');

  step(`typing for ${seconds}s`);
  await waitFor('host typing', () => read('host-typing'));
  const typing = await vscode.window.showTextDocument(editor.document);
  signal('guest-typing');
  const ops = await typeFor(typing, seconds * 1000, 2);
  step(`${ops} operations`);
  await converge(typing.document);
  await waitFor('host converged', () => read('host-converged'));
  assert.equal(await typing.document.save(), true, 'guest save failed');
  signal('guest-saved-2');
  const final = await waitFor('host final text', () => read('host-final.txt'), 15_000);
  await waitFor('local copy clean', () => !typing.document.isDirty, 10_000);
  assert.equal(lf(readText(local(FILE))!), lf(final));
  assertNoProblems(syncode);
  signal('guest-done');
  await waitFor('host done', () => read('host-done'));
}

export async function run(): Promise<void> {
  await vscode.workspace.getConfiguration('syncode').update('displayName', role === 'host' ? 'Ana (host)' : 'Bia (guest)', vscode.ConfigurationTarget.Global);
  if (role === 'host') await disableFormatOnSave();
  const syncode = await api();
  logOf = syncode;
  step(`${vscode.env.appName} ${vscode.version}`);
  if (role === 'host') await host(syncode);
  else await guest(syncode);
  step('OK');
}

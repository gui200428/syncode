/**
 * Two editor instances (host and guest) on one machine. The guest window is
 * opened directly on lanpair://<sessionId>/, as after "Join Session", and
 * reconnects on activation. Covers the file tree, read-only binaries, host
 * file events, remote cursors, Follow Participant, simultaneous typing and
 * saving from the guest. LANPAIR_ROLE selects the side; the two instances
 * coordinate through small files in LANPAIR_PAIR_DIR.
 */
import * as assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LanPairApi } from '../../src/extension';

const role = process.env.LANPAIR_ROLE as 'host' | 'guest';
const dir = process.env.LANPAIR_PAIR_DIR!;
const seconds = Number(process.env.LANPAIR_PAIR_SECONDS ?? '120');
const PIN = '424242';
const FILE = 'shared.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lf = (s: string) => s.replace(/\r\n/g, '\n');
const signal = (name: string, content = '') => writeFileSync(path.join(dir, name), content);
const read = (name: string) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), 'utf8') : undefined);

async function waitFor<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`[${role}] timeout waiting for ${what}`);
    await sleep(100);
  }
}

function step(name: string): void {
  console.log(`[${role}] ${name}`);
}

async function api(): Promise<LanPairApi> {
  const ext = vscode.extensions.getExtension<LanPairApi>('lanpair.lanpair');
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
    } else if (op < 0.82) {
      const p = doc.positionAt(int(doc.getText().length + 1));
      editor.selection = new vscode.Selection(p, p);
    } else if (op < 0.9) {
      const len = doc.getText().length;
      const a = doc.positionAt(int(len + 1));
      const b = doc.positionAt(int(len + 1));
      await editor.edit((e) => {
        e.insert(a, '<');
        if (!a.isEqual(b)) e.insert(b, '>');
      });
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

function assertNoProblems(lanpair: LanPairApi): void {
  const problems = lanpair.recentLogLines().filter((l) => /out of sync|threw|resolved before|error/i.test(l));
  assert.deepEqual(problems, []);
}

async function host(lanpair: LanPairApi): Promise<void> {
  const folder = vscode.workspace.workspaceFolders![0]!.uri;
  const info = await lanpair.startHosting(PIN);
  assert.ok(info, 'hosting failed');
  signal('host.json', JSON.stringify({ port: info.port, sessionId: info.sessionId }));

  step('waiting for the guest');
  await waitFor('guest connected', () => lanpair.participants().length === 1);
  const sharedUri = vscode.Uri.joinPath(folder, FILE);
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sharedUri));

  // A file created on the host must show up in the guest's tree.
  await waitFor('guest watching', () => read('guest-watching'));
  writeFileSync(path.join(folder.fsPath, 'created-by-host.txt'), 'hi');

  step('cursors');
  await waitFor('guest has the file open', () => lanpair.participants().some((p) => p.file === FILE));
  editor.selection = new vscode.Selection(1, 4, 1, 4); // "  re|turn a + b;"
  // The guest put its cursor at the start of line 3.
  await waitFor('guest cursor at 3:0', () =>
    lanpair.remoteHeads().some((h) => h.uri === sharedUri.toString() && h.line === 3 && h.character === 0),
  );
  signal('host-cursor-set');

  step('follow');
  await waitFor('guest following', () => read('guest-following'));
  const util = await vscode.window.showTextDocument(vscode.Uri.joinPath(folder, 'src/util.ts'));
  util.selection = new vscode.Selection(2, 1, 2, 1);
  await waitFor('guest followed into src/util.ts', () => read('guest-followed'));
  const typingEditor = await vscode.window.showTextDocument(editor.document);

  step('guest save with format on save');
  await waitFor('guest formatted save', () => read('guest-formatted'));
  await waitFor('formatted text on disk', () => readFileSync(sharedUri.fsPath, 'utf8').includes('export const tidy = { a: 1 };\r\n'), 10_000);
  assert.ok(lf(editor.document.getText()).includes('export const tidy = { a: 1 };'));
  signal('host-format-ok');
  // Guest saves run the host's save participants too; the formatter breaks on
  // the random text below, so turn it off on this side as well.
  await vscode.workspace
    .getConfiguration('editor', { languageId: 'typescript' })
    .update('formatOnSave', false, vscode.ConfigurationTarget.Global, true);

  step(`typing for ${seconds}s`);
  signal('host-typing');
  await waitFor('guest typing', () => read('guest-typing'));
  const ops = await typeFor(typingEditor, seconds * 1000, 1);
  step(`${ops} operations`);
  await converge(editor.document);
  step(`converged at ${editor.document.getText().length} chars`);

  signal('host-converged');
  await waitFor('guest saved', () => read('guest-saved'));
  await waitFor('host document saved', () => !editor.document.isDirty, 10_000);
  const disk = readFileSync(sharedUri.fsPath, 'utf8');
  assert.equal(lf(disk), lf(editor.document.getText()));
  assert.ok(disk.includes('\r\n') && !/[^\r]\n/.test(disk), 'disk file lost its CRLF line endings');
  assertNoProblems(lanpair);
  signal('host-done');
  await waitFor('guest done', () => read('guest-done'));
  lanpair.stop();
}

async function guest(lanpair: LanPairApi): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root && root.scheme === 'lanpair', 'guest window should be on a lanpair:// folder');
  step('reconnecting from the workspace folder');
  await waitFor('session resumed', () => lanpair.sessionKind() === 'guest', 30_000);

  step('file tree');
  const entries = new Map(await vscode.workspace.fs.readDirectory(root));
  assert.equal(entries.get(FILE), vscode.FileType.File);
  assert.equal(entries.get('src'), vscode.FileType.Directory);
  assert.equal(entries.get('image.png'), vscode.FileType.File);
  assert.ok(!entries.has('node_modules'), 'excluded folder is visible');
  const srcEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, 'src'));
  assert.deepEqual(srcEntries, [['util.ts', vscode.FileType.File]]);
  await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.joinPath(root, 'node_modules/dep.js'))));

  step('read-only binary');
  const png = vscode.Uri.joinPath(root, 'image.png');
  assert.equal((await vscode.workspace.fs.stat(png)).permissions, vscode.FilePermission.Readonly);
  assert.deepEqual([...(await vscode.workspace.fs.readFile(png))], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);

  step('host file events');
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
  let created = false;
  watcher.onDidCreate((u) => (created ||= u.path.endsWith('/created-by-host.txt')));
  signal('guest-watching');
  await waitFor('created event', () => created, 15_000);
  watcher.dispose();

  step('cursors');
  const sharedUri = vscode.Uri.joinPath(root, FILE);
  const editor = await vscode.window.showTextDocument(sharedUri, { preview: false });
  editor.selection = new vscode.Selection(3, 0, 3, 0);
  await waitFor('host cursor set', () => read('host-cursor-set'));
  await waitFor('host cursor at 1:4', () =>
    lanpair.remoteHeads().some((h) => h.uri === sharedUri.toString() && h.line === 1 && h.character === 4),
  );

  step('follow');
  const hostId = lanpair.participants()[0]!.clientId;
  lanpair.follow(hostId);
  signal('guest-following');
  const followed = await waitFor('followed editor', () => {
    const e = vscode.window.activeTextEditor;
    return e?.document.uri.path.endsWith('/src/util.ts') ? e : undefined;
  });
  assert.equal(followed.document.uri.scheme, 'lanpair');
  lanpair.follow(undefined);
  signal('guest-followed');

  step('save with format on save');
  const formatted = await vscode.window.showTextDocument(editor.document);
  const end = formatted.document.lineAt(formatted.document.lineCount - 1).range.end;
  await formatted.edit((b) => b.insert(end, '\nexport   const   tidy={a:1};\n'));
  assert.equal(vscode.workspace.getConfiguration('editor', formatted.document).get('formatOnSave'), true);
  assert.equal(await formatted.document.save(), true, 'guest save (with formatter) failed');
  signal('guest-formatted');
  await waitFor('host checked format', () => read('host-format-ok'));
  // The random text below breaks the TypeScript formatter, so turn it off.
  // (Antigravity enables it per language, so override it for TypeScript.)
  await vscode.workspace
    .getConfiguration('editor', { languageId: 'typescript' })
    .update('formatOnSave', false, vscode.ConfigurationTarget.Global, true);
  assert.equal(vscode.workspace.getConfiguration('editor', formatted.document).get('formatOnSave'), false);

  step(`typing for ${seconds}s`);
  await waitFor('host typing', () => read('host-typing'));
  const shared = await vscode.window.showTextDocument(editor.document);
  signal('guest-typing');
  const ops = await typeFor(shared, seconds * 1000, 2);
  step(`${ops} operations`);
  await converge(shared.document);
  await waitFor('host converged', () => read('host-converged'));
  await vscode.window.showTextDocument(shared.document);
  const changes: string[] = [];
  const sub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document === shared.document && e.contentChanges.length) changes.push(JSON.stringify(e.contentChanges.map((c) => [c.rangeOffset, c.rangeLength, c.text.slice(0, 10)])).slice(0, 200));
  });
  const saved = await shared.document.save();
  sub.dispose();
  if (!saved) console.log(`[guest] save failed; dirty=${shared.document.isDirty}; changes during save: ${changes.join(' | ') || 'none'}`);
  assert.equal(saved, true, 'guest save failed');
  signal('guest-saved');
  assertNoProblems(lanpair);
  signal('guest-done');
  await waitFor('host done', () => read('host-done'));
}

export async function run(): Promise<void> {
  const lanpair = await api();
  step(`${vscode.env.appName} ${vscode.version}`);
  if (role === 'host') await host(lanpair);
  else await guest(lanpair);
  step('OK');
}

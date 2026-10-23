/**
 * Phase 2 acceptance test: two editor instances (host and guest) type into the
 * same file at the same time, then must converge, and a guest save must land
 * on the host's disk with the original CRLF line endings.
 * Both instances run this suite; LANPAIR_ROLE selects the side and
 * LANPAIR_PAIR_DIR is used to coordinate through small files.
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

async function waitFor<T>(what: string, fn: () => T | undefined, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
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
    } else if (op < 0.95 && doc.getText().length > 0) {
      // Paste a block.
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
  await waitFor(
    'convergence',
    () => {
      const mine = lf(document.getText());
      signal(`${role}-text.txt`, mine);
      if (read(`${other}-text.txt`) === mine) {
        stableSince ??= Date.now();
        return Date.now() - stableSince > 2000;
      }
      stableSince = undefined;
      return false;
    },
    60_000,
  );
}

function assertNoProblems(lanpair: LanPairApi): void {
  const problems = lanpair.recentLogLines().filter((l) => /out of sync|threw|resolved before|error/i.test(l));
  assert.deepEqual(problems, []);
}

export async function run(): Promise<void> {
  const lanpair = await api();
  console.log(`[${role}] ${vscode.env.appName} ${vscode.version}, typing for ${seconds}s`);

  if (role === 'host') {
    const info = await lanpair.startHosting(PIN);
    assert.ok(info, 'hosting failed');
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, FILE);
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    signal('host.json', JSON.stringify({ port: info.port }));
    await waitFor('guest ready', () => read('guest-ready'));
    const ops = await typeFor(editor, seconds * 1000, 1);
    console.log(`[host] ${ops} operations`);
    await converge(editor.document);
    console.log(`[host] converged at ${editor.document.getText().length} chars`);

    // Guest saves; the host's file on disk must match, with CRLF preserved.
    signal('host-converged');
    await waitFor('guest saved', () => read('guest-saved'));
    await waitFor('host document saved', () => !editor.document.isDirty, 10_000);
    const disk = readFileSync(uri.fsPath, 'utf8');
    assert.equal(lf(disk), lf(editor.document.getText()));
    assert.ok(disk.includes('\r\n') && !/[^\r]\n/.test(disk), 'disk file lost its CRLF line endings');
    assertNoProblems(lanpair);
    signal('host-done');
    await waitFor('guest done', () => read('guest-done'));
    lanpair.stop();
  } else {
    const { port } = JSON.parse(await waitFor('host', () => read('host.json'))) as { port: number };
    assert.equal(await lanpair.join('127.0.0.1', port, PIN), true, 'join failed');
    const editor = await lanpair.openRemoteFile(FILE);
    assert.ok(editor, 'could not open remote file');
    assert.equal(editor.document.uri.scheme, 'lanpair');
    signal('guest-ready');
    const ops = await typeFor(editor, seconds * 1000, 2);
    console.log(`[guest] ${ops} operations`);
    await converge(editor.document);
    await waitFor('host converged', () => read('host-converged'));
    await vscode.window.showTextDocument(editor.document);
    assert.equal(await editor.document.save(), true, 'guest save failed');
    signal('guest-saved');
    assertNoProblems(lanpair);
    signal('guest-done');
    await waitFor('host done', () => read('host-done'));
    lanpair.stop();
  }
  console.log(`[${role}] OK`);
}

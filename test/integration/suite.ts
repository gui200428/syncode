/**
 * Integration tests that run inside the real editor (Antigravity / Code OSS)
 * through @vscode/test-electron. Bundled to out-test/suite.js by runTest.mjs.
 */
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { SynCodeApi } from '../../src/extension';

type Test = { name: string; fn: () => Promise<void> };
const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push({ name, fn });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lf = (s: string) => s.replace(/\r\n/g, '\n');

function fixture(name: string): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root, 'tests need a workspace folder');
  return vscode.Uri.joinPath(root, name);
}

async function api(): Promise<SynCodeApi> {
  const ext = vscode.extensions.getExtension<SynCodeApi>('syncode.syncode');
  assert.ok(ext, 'extension not found');
  return ext.activate();
}

async function waitFor(cond: () => boolean, timeoutMs: number, stableMs = 0): Promise<void> {
  const start = Date.now();
  let since: number | undefined;
  while (Date.now() - start < timeoutMs) {
    if (cond()) {
      since ??= Date.now();
      if (Date.now() - since >= stableMs) return;
    } else {
      since = undefined;
    }
    await sleep(50);
  }
  throw new Error('timeout waiting for condition');
}

// The binding relies on these editor behaviors; see NOTES.md.
test('API: the change event of TextEditor.edit fires before the promise resolves', async () => {
  const doc = await vscode.workspace.openTextDocument({ content: 'abc' });
  const editor = await vscode.window.showTextDocument(doc);
  let resolved = false;
  let eventBeforeResolve: boolean | undefined;
  const sub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document === doc && e.contentChanges.length > 0) eventBeforeResolve ??= !resolved;
  });
  const ok = await editor.edit((b) => b.insert(new vscode.Position(0, 3), 'd'));
  resolved = true;
  sub.dispose();
  assert.equal(ok, true);
  assert.equal(eventBeforeResolve, true);
  assert.equal(doc.getText(), 'abcd');
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
});

test('API: TextEditor.edit is rejected when the user typed first', async () => {
  for (let i = 0; i < 5; i++) {
    const doc = await vscode.workspace.openTextDocument({ content: 'hello' });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const typed = vscode.commands.executeCommand('type', { text: 'E' });
    const ok = await editor.edit((b) => b.insert(new vscode.Position(0, 2), 'W'));
    await typed;
    assert.equal(ok, false);
    assert.equal(doc.getText(), 'Ehello');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
});

test('API: TextEditor.edit sent before typing is applied atomically', async () => {
  for (let i = 0; i < 5; i++) {
    const doc = await vscode.workspace.openTextDocument({ content: 'hello' });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const edited = editor.edit((b) => b.insert(new vscode.Position(0, 2), 'W'));
    await vscode.commands.executeCommand('type', { text: 'E' });
    assert.equal(await edited, true);
    assert.equal(doc.getText(), 'EheWllo');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
});

async function stressMirror(file: string, iterations: number, seed: number): Promise<void> {
  const logs = await api();
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const int = (n: number) => Math.floor(rand() * n);
  const words = ['x', 'foo', ' ', '\n', '{\n  }', 'é', '😀', 'lan\npair\n'];

  const source = await vscode.workspace.openTextDocument(fixture(file));
  await vscode.window.showTextDocument(source, vscode.ViewColumn.One);
  const logStart = logs.recentLogLines().length;
  await vscode.commands.executeCommand('syncode.debugMirror');
  const target = vscode.window.activeTextEditor!.document;
  assert.notEqual(target, source, 'mirror did not open a new editor');
  try {
    await waitFor(() => lf(target.getText()) === lf(source.getText()), 5000);
    await stress();
  } finally {
    await vscode.commands.executeCommand('syncode.debugMirror'); // stop
    for (const d of [target, source]) {
      await vscode.window.showTextDocument(d);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  }

  async function stress(): Promise<void> {

  const editors = () => [
    vscode.window.visibleTextEditors.find((e) => e.document === source)!,
    vscode.window.visibleTextEditors.find((e) => e.document === target)!,
  ];
  const pending: Thenable<unknown>[] = [];
  for (let i = 0; i < iterations; i++) {
    const op = rand();
    if (op < 0.35) {
      // Real typing in the focused editor (goes through the renderer like keystrokes).
      pending.push(vscode.commands.executeCommand('type', { text: words[int(words.length)]! }));
    } else if (op < 0.4) {
      pending.push(vscode.commands.executeCommand(rand() < 0.5 ? 'deleteLeft' : 'deleteRight'));
    } else if (op < 0.45) {
      const editor = editors()[int(2)]!;
      await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
      const len = editor.document.getText().length;
      const p = editor.document.positionAt(int(len + 1));
      editor.selection = new vscode.Selection(p, p);
    } else {
      const editor = editors()[int(2)]!;
      const doc = editor.document;
      const len = doc.getText().length;
      const at = (o: number) => doc.positionAt(o);
      const offset = int(len + 1);
      const kind = rand();
      pending.push(
        editor.edit((b) => {
          if (kind < 0.55) {
            b.insert(at(offset), words[int(words.length)]!);
          } else if (kind < 0.8) {
            b.delete(new vscode.Range(at(offset), at(Math.min(len, offset + 1 + int(6)))));
          } else {
            // Multi-cursor style: two disjoint inserts in one edit.
            const second = int(len + 1);
            b.insert(at(Math.min(offset, second)), 'A');
            if (second !== offset) b.insert(at(Math.max(offset, second)), 'B');
          }
        }),
      );
    }
    if (rand() < 0.5) await sleep(int(15));
  }
  await Promise.allSettled(pending);
  try {
    await waitFor(() => lf(target.getText()) === lf(source.getText()), 20000, 1500);
  } catch (err) {
    console.log('    source:', JSON.stringify(lf(source.getText())));
    console.log('    target:', JSON.stringify(lf(target.getText())));
    for (const l of logs.recentLogLines().slice(logStart).slice(-15)) console.log('    log:', l);
    throw err;
  }

  const problems = logs
    .recentLogLines()
    .slice(logStart)
    .filter((l) => /out of sync|threw|resolved before/.test(l));
  assert.deepEqual(problems, []);
  const superseded = logs.recentLogLines().slice(logStart).filter((l) => l.includes('superseded')).length;
  console.log(`    ${file}: converged at ${lf(source.getText()).length} chars, ${superseded} remote edits retried after local typing`);
  }
}

test('mirror converges under concurrent edits (LF)', () => stressMirror('lf.js', 400, 7));
test('mirror converges under concurrent edits (CRLF source)', async () => {
  const doc = await vscode.workspace.openTextDocument(fixture('crlf.txt'));
  assert.equal(doc.eol, vscode.EndOfLine.CRLF);
  await stressMirror('crlf.txt', 400, 11);
});

export async function run(): Promise<void> {
  console.log(`SynCode integration tests on ${vscode.env.appName} ${vscode.version}`);
  const failures: string[] = [];
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failures.push(t.name);
      console.log(`  ✗ ${t.name}\n    ${err instanceof Error ? err.stack : String(err)}`);
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} integration test(s) failed`);
}


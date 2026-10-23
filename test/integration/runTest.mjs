// Runs test/integration/suite.ts inside an editor via @vscode/test-electron.
// Uses the locally installed Antigravity by default; override with LANPAIR_EDITOR.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { runTests } from '@vscode/test-electron';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const editor = process.env.LANPAIR_EDITOR ?? '/opt/antigravity-ide/antigravity-ide';

await esbuild.build({
  entryPoints: [join(root, 'test/integration/suite.ts')],
  bundle: true,
  outfile: join(root, 'out-test/suite.js'),
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  logLevel: 'warning',
});

// Fresh profile and a scratch copy of the fixtures, so nothing touches the user's setup.
const scratch = mkdtempSync(join(process.env.LANPAIR_TMP ?? tmpdir(), 'lanpair-it-'));
const workspace = join(scratch, 'workspace');
cpSync(join(root, 'test/integration/fixtures'), workspace, { recursive: true });

try {
  await runTests({
    vscodeExecutablePath: editor,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'out-test/suite.js'),
    launchArgs: [
      workspace,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--user-data-dir',
      join(scratch, 'user-data'),
      '--extensions-dir',
      join(scratch, 'extensions'),
    ],
  });
} catch (err) {
  console.error('Integration tests failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

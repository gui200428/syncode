// Runs pairSuite in two editor instances at once (host + guest on localhost).
// LANPAIR_PAIR_SECONDS controls the typing duration (default 120).
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { runTests } from '@vscode/test-electron';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const editor = process.env.LANPAIR_EDITOR ?? '/opt/antigravity-ide/antigravity-ide';

await esbuild.build({
  entryPoints: [join(root, 'test/integration/pairSuite.ts')],
  bundle: true,
  outfile: join(root, 'out-test/pairSuite.js'),
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  logLevel: 'warning',
});

const scratch = mkdtempSync(join(process.env.LANPAIR_TMP ?? tmpdir(), 'lanpair-pair-'));
const pairDir = join(scratch, 'signals');
mkdirSync(pairDir);
const hostWorkspace = join(scratch, 'host-workspace');
cpSync(join(root, 'test/integration/pair-fixture'), hostWorkspace, { recursive: true });

function launch(role, workspace) {
  const args = [
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--user-data-dir',
    join(scratch, `${role}-user-data`),
    '--extensions-dir',
    join(scratch, `${role}-extensions`),
  ];
  return runTests({
    vscodeExecutablePath: editor,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'out-test/pairSuite.js'),
    launchArgs: workspace ? [workspace, ...args] : args,
    extensionTestsEnv: {
      LANPAIR_ROLE: role,
      LANPAIR_PAIR_DIR: pairDir,
      LANPAIR_PAIR_SECONDS: process.env.LANPAIR_PAIR_SECONDS ?? '120',
    },
  });
}

try {
  const results = await Promise.allSettled([launch('host', hostWorkspace), launch('guest')]);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    console.error('Pair test failed:', failed.map((r) => String(r.reason)).join('; '));
    process.exitCode = 1;
  } else {
    console.log('Pair test passed.');
  }
} finally {
  if (!process.env.LANPAIR_KEEP) rmSync(scratch, { recursive: true, force: true });
}

// Runs pairSuite in two editor instances at once (host + guest on localhost).
// With the argument `mirror`, runs mirrorSuite instead: the guest window is
// opened on an empty local folder that it mirrors the host's folder into.
// SYNCODE_PAIR_SECONDS controls the typing duration (default 120).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { runTests } from '@vscode/test-electron';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const editor = process.env.SYNCODE_EDITOR ?? '/opt/antigravity-ide/antigravity-ide';
const mirror = process.argv[2] === 'mirror';
const suite = mirror ? 'mirrorSuite' : 'pairSuite';

await esbuild.build({
  entryPoints: [join(root, `test/integration/${suite}.ts`)],
  bundle: true,
  outfile: join(root, `out-test/${suite}.js`),
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  logLevel: 'warning',
});

const scratch = mkdtempSync(join(process.env.SYNCODE_TMP ?? tmpdir(), 'syncode-pair-'));
const pairDir = join(scratch, 'signals');
mkdirSync(pairDir);
const hostWorkspace = join(scratch, 'host-workspace');
cpSync(join(root, 'test/integration/pair-fixture'), hostWorkspace, { recursive: true });
// Created here because the repository's .gitignore would drop them from the fixture.
mkdirSync(join(hostWorkspace, 'node_modules'));
writeFileSync(join(hostWorkspace, 'node_modules', 'dep.js'), 'module.exports = 1;\n');
writeFileSync(join(hostWorkspace, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));

function launch(role, workspace, extraEnv = {}) {
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
    extensionTestsPath: join(root, `out-test/${suite}.js`),
    launchArgs: [...workspace, ...args],
    extensionTestsEnv: {
      ...extraEnv,
      SYNCODE_ROLE: role,
      SYNCODE_PAIR_DIR: pairDir,
      SYNCODE_PAIR_SECONDS: process.env.SYNCODE_PAIR_SECONDS ?? '120',
    },
  });
}

try {
  const host = launch('host', [hostWorkspace]);
  // The guest opens the host's folder directly, like after "Join Session".
  const signal = join(pairDir, 'host.json');
  const guest = (async () => {
    const start = Date.now();
    while (!existsSync(signal)) {
      if (Date.now() - start > 120_000) throw new Error('host did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
    const { port, sessionId } = JSON.parse(readFileSync(signal, 'utf8'));
    if (mirror) {
      const mirrorDir = join(scratch, 'guest-mirror');
      mkdirSync(mirrorDir);
      return launch('guest', [mirrorDir], {
        SYNCODE_TEST_MIRROR: JSON.stringify({ host: '127.0.0.1', port, pin: '424242', sessionId }),
      });
    }
    return launch('guest', ['--folder-uri', `syncode://${sessionId}/`], {
      SYNCODE_TEST_JOIN: JSON.stringify({ host: '127.0.0.1', port, pin: '424242' }),
    });
  })();
  const results = await Promise.allSettled([host, guest]);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    console.error(`${mirror ? 'Mirror pair' : 'Pair'} test failed:`, failed.map((r) => String(r.reason)).join('; '));
    process.exitCode = 1;
  } else {
    console.log(`${mirror ? 'Mirror pair' : 'Pair'} test passed.`);
  }
} finally {
  if (!process.env.SYNCODE_KEEP) rmSync(scratch, { recursive: true, force: true });
}

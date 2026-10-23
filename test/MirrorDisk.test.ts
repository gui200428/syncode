import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MirrorDisk, safeRelativePath, type MirrorRemote } from '../src/guest/MirrorDisk';
import { WorkspaceIndex } from '../src/host/WorkspaceIndex';
import type { TreeResult } from '../src/protocol';

describe('safeRelativePath', () => {
  it.each(['../x', 'a/../../x', '/etc/passwd', 'C:\\x', '.git/hooks/pre-commit', 'sub/.GIT/config', 'a\0b', '', '.'])(
    'rejects %j',
    (p) => expect(safeRelativePath(p)).toBeUndefined(),
  );
  it('normalizes normal paths', () => {
    expect(safeRelativePath('./src//a.ts')).toBe('src/a.ts');
    expect(safeRelativePath('.gitignore')).toBe('.gitignore');
  });
});

describe('MirrorDisk', () => {
  let base: string;
  let hostRoot: string;
  let local: string;
  let manifest: string;
  let reads: string[];
  let remote: MirrorRemote;
  const live = new Set<string>();
  const logs: string[] = [];

  const host = (rel: string, content: string | Buffer) => {
    mkdirSync(join(hostRoot, rel, '..'), { recursive: true });
    writeFileSync(join(hostRoot, rel), content);
  };
  const localText = (rel: string) => readFileSync(join(local, rel), 'utf8');

  function mirror(confirm?: (paths: string[]) => Promise<boolean>) {
    return new MirrorDisk(local, remote, manifest, {
      isLive: (p) => live.has(p),
      confirmReplace: confirm,
      log: (m) => logs.push(m),
    });
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'lanpair-mirror-'));
    hostRoot = join(base, 'host');
    local = join(base, 'local');
    manifest = join(base, 'state', 'manifest.json');
    mkdirSync(hostRoot);
    mkdirSync(local);
    live.clear();
    logs.length = 0;
    reads = [];
    host('src/a.ts', 'export const a = 1;\n');
    host('README.md', '# hi\r\n');
    host('img.png', Buffer.from([0x89, 0, 1, 2, 255]));
    host('node_modules/dep.js', 'x');
    mkdirSync(join(hostRoot, 'empty'));
    const index = new WorkspaceIndex(hostRoot, { maxFileBytes: 1024, exclude: ['**/node_modules/**'] });
    remote = {
      tree: (p) => index.tree(p),
      read: async (p) => {
        reads.push(p);
        return index.readRaw(p);
      },
    };
  });

  it('copies the shared files, keeping bytes and line endings', async () => {
    const m = mirror();
    expect(await m.sync()).toEqual({ written: 3, deleted: 0, kept: 0 });
    expect(localText('src/a.ts')).toBe('export const a = 1;\n');
    expect(localText('README.md')).toBe('# hi\r\n');
    expect([...readFileSync(join(local, 'img.png'))]).toEqual([0x89, 0, 1, 2, 255]);
    expect(existsSync(join(local, 'empty'))).toBe(true);
    expect(existsSync(join(local, 'node_modules'))).toBe(false);
    expect(m.knows('src/a.ts')).toBe(true);
    expect(m.knows('node_modules/dep.js')).toBe(false);
  });

  it('downloads only what changed on a later sync, also after reloading the manifest', async () => {
    await mirror().sync();
    reads = [];
    const again = mirror();
    await again.load();
    expect(await again.sync()).toEqual({ written: 0, deleted: 0, kept: 0 });
    expect(reads).toEqual([]);
    host('src/a.ts', 'export const a = 2;\n');
    utimesSync(join(hostRoot, 'src/a.ts'), new Date(), new Date(Date.now() + 5000));
    expect(await again.sync()).toMatchObject({ written: 1 });
    expect(reads).toEqual(['src/a.ts']);
    expect(localText('src/a.ts')).toBe('export const a = 2;\n');
  });

  it('asks before replacing files changed here, and can keep them', async () => {
    writeFileSync(join(local, 'README.md'), 'my own readme\n'); // existed before the first mirror
    let asked: string[] = [];
    await mirror(async (paths) => ((asked = paths), false)).sync();
    expect(asked).toEqual(['README.md']);
    expect(localText('README.md')).toBe('my own readme\n');

    // Identical content is not a conflict.
    writeFileSync(join(local, 'src/a.ts'), 'export const a = 1;\n');
    asked = [];
    const m = mirror(async (paths) => ((asked = paths), true));
    await m.load();
    // Kept files are replaced without asking once the host changes them.
    host('README.md', '# changed\n');
    utimesSync(join(hostRoot, 'README.md'), new Date(), new Date(Date.now() + 5000));
    await m.sync();
    expect(asked).toEqual([]);
    expect(localText('README.md')).toBe('# changed\n');

    writeFileSync(join(local, 'src/a.ts'), 'edited here\n');
    host('src/a.ts', 'edited on host\n');
    utimesSync(join(hostRoot, 'src/a.ts'), new Date(), new Date(Date.now() + 9000));
    await m.sync();
    expect(asked).toEqual(['src/a.ts']);
    expect(localText('src/a.ts')).toBe('edited on host\n');
  });

  it('never writes live files', async () => {
    live.add('src/a.ts');
    const m = mirror();
    expect(await m.sync()).toMatchObject({ written: 2 });
    expect(existsSync(join(local, 'src/a.ts'))).toBe(false);
    expect(m.knows('src/a.ts')).toBe(true);
  });

  it('applies host events: created folders, changes and deletions', async () => {
    const m = mirror();
    await m.sync();
    host('lib/x/y.ts', 'y');
    host('lib/z.ts', 'z');
    await m.applyHostChanges([{ path: 'lib', type: 'created' }]);
    expect(localText('lib/x/y.ts')).toBe('y');
    expect(localText('lib/z.ts')).toBe('z');

    writeFileSync(join(local, 'lib/z.ts'), 'changed here');
    rmSync(join(hostRoot, 'lib'), { recursive: true });
    await m.applyHostChanges([{ path: 'lib', type: 'deleted' }]);
    expect(existsSync(join(local, 'lib/x'))).toBe(false);
    expect(localText('lib/z.ts')).toBe('changed here'); // kept: changed locally
    expect(logs.some((l) => l.includes('keeping lib/z.ts'))).toBe(true);

    rmSync(join(hostRoot, 'src/a.ts'));
    await m.applyHostChanges([{ path: 'src/a.ts', type: 'deleted' }]);
    expect(existsSync(join(local, 'src/a.ts'))).toBe(false);
    expect(m.knows('src/a.ts')).toBe(false);

    host('new.txt', 'n');
    await m.applyHostChanges([{ path: 'new.txt', type: 'created' }, { path: 'gone.txt', type: 'created' }]);
    expect(localText('new.txt')).toBe('n');
  });

  it('a file saved here is replaced by the host version without asking', async () => {
    const m = mirror(async () => {
      throw new Error('should not ask');
    });
    await m.sync();
    writeFileSync(join(local, 'src/a.ts'), 'saved by the editor\n');
    await m.markSaved('src/a.ts');
    host('src/a.ts', 'formatted by the host\n');
    await m.sync();
    expect(localText('src/a.ts')).toBe('formatted by the host\n');
  });

  it('ignores unsafe paths and links that leave the folder', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(local, 'src'));
    const evil: TreeResult = {
      dirs: ['.git', 'src'],
      files: [
        { path: '../escape.txt', size: 1, mtime: 1 },
        { path: '.git/hooks/pre-commit', size: 1, mtime: 1 },
        { path: 'src/a.ts', size: 1, mtime: 1 },
        { path: 'ok.txt', size: 1, mtime: 1 },
      ],
    };
    const m = new MirrorDisk(local, { tree: async () => evil, read: async () => Buffer.from('!') }, manifest, {
      isLive: () => false,
      log: (l) => logs.push(l),
    });
    expect(await m.sync()).toMatchObject({ written: 1 });
    expect(localText('ok.txt')).toBe('!');
    expect(existsSync(join(base, 'escape.txt'))).toBe(false);
    expect(existsSync(join(local, '.git'))).toBe(false);
    expect(existsSync(join(outside, 'a.ts'))).toBe(false);
    expect(logs.some((l) => l.includes('links outside'))).toBe(true);
  });
});

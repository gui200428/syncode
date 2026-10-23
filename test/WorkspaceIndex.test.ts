import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceIndex } from '../src/host/WorkspaceIndex';

describe('WorkspaceIndex', () => {
  let base: string;
  let root: string;
  let index: WorkspaceIndex;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'lanpair-wi-'));
    root = join(base, 'root');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export {};\n');
    writeFileSync(join(root, '..config'), 'ok');
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(2048));
    writeFileSync(join(root, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    writeFileSync(join(base, 'secret.txt'), 'top secret');
    symlinkSync(join(base, 'secret.txt'), join(root, 'link-out.txt'));
    symlinkSync(join(root, 'src', 'a.ts'), join(root, 'link-in.ts'));
    symlinkSync(base, join(root, 'dir-out'));
    index = new WorkspaceIndex(root, { maxFileBytes: 1024 });
  });

  it('hides files ignored by .gitignore files (root and nested) and lanpair.exclude', async () => {
    const r = join(base, 'git');
    mkdirSync(join(r, 'dist'), { recursive: true });
    mkdirSync(join(r, 'pkg', 'gen'), { recursive: true });
    writeFileSync(join(r, '.gitignore'), 'dist/\n*.log\n!keep.log\n');
    writeFileSync(join(r, 'pkg', '.gitignore'), 'gen/\n');
    for (const f of ['dist/out.js', 'a.log', 'keep.log', 'pkg/gen/x.ts', 'pkg/src.ts', 'notes.tmp']) writeFileSync(join(r, f), 'x');
    const gi = new WorkspaceIndex(r, { maxFileBytes: 1024, exclude: ['*.tmp'] });
    expect((await gi.list('')).map((e) => e[0]).sort()).toEqual(['.gitignore', 'keep.log', 'pkg']);
    expect((await gi.list('pkg')).map((e) => e[0]).sort()).toEqual(['.gitignore', 'src.ts']);
    for (const hidden of ['dist/out.js', 'a.log', 'pkg/gen/x.ts', 'notes.tmp']) {
      await expect(gi.resolve(hidden)).rejects.toMatchObject({ code: 'not-found' });
    }
    // Disabled: only lanpair.exclude applies.
    const plain = new WorkspaceIndex(r, { maxFileBytes: 1024, exclude: ['*.tmp'], respectGitignore: false });
    expect((await plain.list('')).map((e) => e[0])).toContain('dist');
    // Edits to .gitignore apply after invalidation.
    writeFileSync(join(r, '.gitignore'), '*.log\n');
    gi.invalidateGitignore();
    expect((await gi.list('')).map((e) => e[0])).toContain('dist');
  });

  it('resolves normal paths', async () => {
    expect(await index.resolve('src/a.ts')).toMatch(/src[\\/]a\.ts$/);
    expect(await index.resolve('./src//a.ts')).toMatch(/src[\\/]a\.ts$/);
    expect(await index.resolve('..config')).toMatch(/\.\.config$/);
  });

  it.each([
    ['../secret.txt', 'outside-root'],
    ['src/../../secret.txt', 'outside-root'],
    ['/etc/passwd', 'invalid-path'],
    ['C:\\Windows\\win.ini', 'invalid-path'],
    ['..\\secret.txt', 'outside-root'],
    ['link-out.txt', 'outside-root'],
    ['dir-out/secret.txt', 'outside-root'],
    ['src/a.ts\0.png', 'invalid-path'],
    ['missing.txt', 'not-found'],
  ])('rejects %j', async (p, code) => {
    await expect(index.resolve(p)).rejects.toMatchObject({ code });
  });

  it('follows symbolic links that stay inside the root and reports the canonical path', async () => {
    const real = await index.resolve('link-in.ts');
    expect(await index.relative(real)).toBe('src/a.ts');
  });

  it('refuses binary, oversized files and directories as text', async () => {
    await expect(index.resolveTextFile('image.bin')).rejects.toMatchObject({ code: 'binary' });
    await expect(index.resolveTextFile('big.txt')).rejects.toMatchObject({ code: 'too-large' });
    await expect(index.resolveTextFile('src')).rejects.toMatchObject({ code: 'not-a-file' });
    await expect(index.resolveTextFile('src/a.ts')).resolves.toBeTruthy();
  });

  it('lists the whole tree without links that leave the root or duplicate folders', async () => {
    const t = await index.tree('');
    expect(t.files.map((f) => f.path).sort()).toEqual(['..config', 'big.txt', 'image.bin', 'link-in.ts', 'src/a.ts']);
    expect(t.dirs).toEqual(['src']);
    expect(t.files.find((f) => f.path === 'big.txt')).toMatchObject({ size: 2048 });
    expect((await index.tree('src')).files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(await index.tree('src/a.ts')).toMatchObject({ files: [{ path: 'src/a.ts' }], dirs: [] });
    await expect(index.tree('../')).rejects.toMatchObject({ code: 'outside-root' });
  });
});

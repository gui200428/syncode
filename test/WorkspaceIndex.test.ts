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
});

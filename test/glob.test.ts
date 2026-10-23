import { describe, expect, it } from 'vitest';
import { GlobSet, globToRegExp } from '../src/glob';

describe('glob', () => {
  it.each([
    ['**/node_modules/**', 'node_modules/a/b.js', true],
    ['**/node_modules/**', 'pkg/node_modules/x', true],
    ['**/node_modules/**', 'src/node_modulesX/x', false],
    ['*.log', 'debug.log', true],
    ['*.log', 'logs/debug.log', false],
    ['**/*.log', 'logs/debug.log', true],
    ['dist/**', 'dist/a/b', true],
    ['**/*.{png,jpg}', 'img/a.jpg', true],
    ['**/*.{png,jpg}', 'img/a.gif', false],
    ['src/?.ts', 'src/a.ts', true],
    ['a.b', 'axb', false],
  ])('%s vs %s → %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });

  it('excludes directories whose contents are excluded', () => {
    const set = new GlobSet(['**/node_modules/**', '**/.git/**']);
    expect(set.matches('node_modules', true)).toBe(true);
    expect(set.matches('a/.git', true)).toBe(true);
    expect(set.matches('src', true)).toBe(false);
    expect(set.matches('node_modules', false)).toBe(false);
  });
});

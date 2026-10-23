import { describe, expect, it } from 'vitest';
import { isIgnored, parseGitignore } from '../src/gitignore';

describe('gitignore', () => {
  const root = parseGitignore(
    ['# comment', '', 'node_modules/', '*.log', '!keep.log', '/build', 'docs/*.pdf', '.env*', 'tmp/**', '\\#notacomment'].join('\n'),
  );

  it.each([
    ['node_modules', true, true],
    ['pkg/node_modules', true, true],
    ['node_modules', false, false], // dir-only pattern does not match a file
    ['debug.log', false, true],
    ['logs/debug.log', false, true],
    ['keep.log', false, false],
    ['build', true, true],
    ['src/build', true, false], // anchored to the root
    ['docs/a.pdf', false, true],
    ['docs/sub/a.pdf', false, false],
    ['.env.local', false, true],
    ['tmp/a/b', false, true],
    ['#notacomment', false, true],
    ['src/main.ts', false, false],
  ])('%s (dir=%s) → %s', (path, isDir, expected) => {
    expect(isIgnored(root, path, isDir)).toBe(expected);
  });

  it('applies nested .gitignore files relative to their folder, last match wins', () => {
    const rules = [...root, ...parseGitignore('*.gen.ts\n!debug.log\n/local', 'pkg')];
    expect(isIgnored(rules, 'pkg/a.gen.ts', false)).toBe(true);
    expect(isIgnored(rules, 'a.gen.ts', false)).toBe(false);
    expect(isIgnored(rules, 'pkg/debug.log', false)).toBe(false);
    expect(isIgnored(rules, 'other/debug.log', false)).toBe(true);
    expect(isIgnored(rules, 'pkg/local', false)).toBe(true);
    expect(isIgnored(rules, 'pkg/sub/local', false)).toBe(false);
  });
});

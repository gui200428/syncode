/**
 * Minimal glob matching for `syncode.exclude` (no dependency): `**` matches any
 * number of path segments, `*` and `?` stay within a segment, `{a,b}` is an
 * alternation. Paths use `/` and are relative to the shared folder.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  let braces = 0;
  const g = glob.replace(/\\/g, '/').replace(/^\.?\//, '');
  while (i < g.length) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slashAfter = g[i + 2] === '/';
        const atSegmentStart = i === 0 || g[i - 1] === '/';
        if (atSegmentStart && slashAfter) {
          re += '(?:.*/)?'; // "**/" : zero or more directories
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      re += '(?:';
      braces++;
    } else if (c === '}' && braces > 0) {
      re += ')';
      braces--;
    } else if (c === ',' && braces > 0) {
      re += '|';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    i++;
  }
  return new RegExp(`^${re}$`);
}

export class GlobSet {
  private readonly patterns: RegExp[];

  constructor(globs: readonly string[]) {
    this.patterns = globs.filter((g) => g.trim()).map((g) => globToRegExp(g.trim()));
  }

  /** True if the path, or (for directories) anything inside it, is excluded. */
  matches(relPath: string, isDirectory = false): boolean {
    const candidates = isDirectory ? [relPath, `${relPath}/`, `${relPath}/x`] : [relPath];
    return candidates.some((c) => this.patterns.some((p) => p.test(c)));
  }
}

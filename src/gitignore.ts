import { globToRegExp } from './glob';

export interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
  /** Directory of the .gitignore, relative to the root ('' for the root). */
  base: string;
}

/** Parses one .gitignore file located in `base` (gitignore(5) semantics, minus character classes). */
export function parseGitignore(content: string, base = ''): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (let line of content.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    line = line.replace(/(?<!\\)\s+$/, '');
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) continue;
    // A slash at the start or middle anchors the pattern to the .gitignore's folder.
    const anchored = line.includes('/');
    line = line.replace(/^\//, '');
    const glob = anchored || line.startsWith('**/') ? line : `**/${line}`;
    rules.push({ re: globToRegExp(glob.replace(/\\(.)/g, '$1')), negate, dirOnly, base });
  }
  return rules;
}

/**
 * Decides whether `relPath` itself is ignored by `rules` (ordered from the
 * root .gitignore to the deepest one; the last matching rule wins).
 * Callers check parent folders separately: inside an ignored folder
 * everything is ignored, as in git.
 */
export function isIgnored(rules: readonly IgnoreRule[], relPath: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDirectory) continue;
    let rel = relPath;
    if (rule.base) {
      if (!relPath.startsWith(`${rule.base}/`)) continue;
      rel = relPath.slice(rule.base.length + 1);
    }
    if (rule.re.test(rel)) ignored = !rule.negate;
  }
  return ignored;
}

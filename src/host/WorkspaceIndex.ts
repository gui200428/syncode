import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isIgnored, parseGitignore, type IgnoreRule } from '../gitignore';
import { GlobSet } from '../glob';
import { RemoteError, type FileStatResult, type FileKind, type TreeResult } from '../protocol';
import { normalizeDocPath } from '../sync/DocRegistry';

const BINARY_SNIFF_BYTES = 8000;
/** Upper bound for tree(); a mirror of more files than this is not useful over a LAN session. */
export const MAX_TREE_FILES = 50_000;
/** Largest file a guest can read raw (binary or oversized files, read-only). */
export const MAX_RAW_READ_BYTES = 16 * 1024 * 1024;

export interface WorkspaceIndexOptions {
  maxFileBytes: number;
  exclude?: readonly string[];
  /** Also hide what .gitignore files ignore (default true). */
  respectGitignore?: boolean;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Host-side view of the shared folder. Every path received from a guest goes
 * through resolve(), which rejects anything that escapes the root, either
 * lexically (`..`, absolute paths) or through symbolic links.
 */
export class WorkspaceIndex {
  private realRoot: Promise<string>;
  private readonly excluded: GlobSet;
  /** Parsed .gitignore per folder ('' = root), loaded lazily. */
  private readonly gitignores = new Map<string, Promise<IgnoreRule[]>>();

  constructor(
    readonly root: string,
    private readonly options: WorkspaceIndexOptions,
  ) {
    this.realRoot = fs.realpath(root);
    this.excluded = new GlobSet(options.exclude ?? []);
  }

  /** Call when a .gitignore file was created, changed or deleted. */
  invalidateGitignore(): void {
    this.gitignores.clear();
  }

  /** True if this exact path is excluded (by lanpair.exclude or .gitignore); parents are not checked. */
  async isExcluded(relPath: string, isDirectory = false): Promise<boolean> {
    const rel = normalizeDocPath(relPath);
    if (rel === '') return false;
    if (this.excluded.matches(rel, isDirectory)) return true;
    if (this.options.respectGitignore === false) return false;
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    return isIgnored(await this.rulesFor(parent), rel, isDirectory);
  }

  /** True if the path or any of its parent folders is excluded. */
  async isHidden(relPath: string): Promise<boolean> {
    const segments = normalizeDocPath(relPath).split('/').filter(Boolean);
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      const leaf = i === segments.length;
      // The leaf may be a file or a folder; parents are folders.
      if ((await this.isExcluded(prefix, true)) || (leaf && (await this.isExcluded(prefix, false)))) return true;
    }
    return false;
  }

  /** Rules of every .gitignore from the root down to `dir`, in order. */
  private async rulesFor(dir: string): Promise<IgnoreRule[]> {
    const dirs = [''];
    const parts = dir ? dir.split('/') : [];
    for (let i = 1; i <= parts.length; i++) dirs.push(parts.slice(0, i).join('/'));
    const lists = await Promise.all(dirs.map((d) => this.gitignoreIn(d)));
    return lists.flat();
  }

  private gitignoreIn(dir: string): Promise<IgnoreRule[]> {
    let rules = this.gitignores.get(dir);
    if (!rules) {
      rules = fs.readFile(path.join(this.root, dir, '.gitignore'), 'utf8').then(
        (content) => parseGitignore(content, dir),
        () => [],
      );
      this.gitignores.set(dir, rules);
    }
    return rules;
  }

  /** Validates a guest-supplied relative path and returns its real absolute path. */
  async resolve(relPath: string): Promise<string> {
    if (typeof relPath !== 'string' || relPath.includes('\0')) {
      throw new RemoteError('invalid-path', 'invalid path');
    }
    if (path.isAbsolute(relPath) || path.win32.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
      throw new RemoteError('invalid-path', 'absolute paths are not allowed');
    }
    const normalized = normalizeDocPath(relPath);
    if (normalized.split('/').includes('..')) {
      throw new RemoteError('outside-root', 'path escapes the shared folder');
    }
    // Excluded paths (lanpair.exclude, .gitignore) do not exist for guests.
    if (await this.isHidden(normalized)) throw new RemoteError('not-found', `not found: ${normalized}`);
    const lexical = path.resolve(this.root, normalized);
    if (!isInside(path.resolve(this.root), lexical)) {
      throw new RemoteError('outside-root', 'path escapes the shared folder');
    }
    let real: string;
    try {
      real = await fs.realpath(lexical);
    } catch {
      throw new RemoteError('not-found', `not found: ${normalized}`);
    }
    if (!isInside(await this.realRoot, real)) {
      throw new RemoteError('outside-root', 'path escapes the shared folder (symbolic link)');
    }
    return real;
  }

  /**
   * Resolves a path that may be synced as text: a regular file within the size
   * limit that does not look binary. Returns the real absolute path.
   */
  async resolveTextFile(relPath: string): Promise<string> {
    const real = await this.resolve(relPath);
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new RemoteError('not-a-file', `not a file: ${relPath}`);
    if (stat.size > this.options.maxFileBytes) {
      throw new RemoteError(
        'too-large',
        `file is larger than ${Math.round(this.options.maxFileBytes / 1024)} KB`,
      );
    }
    if (await looksBinary(real)) throw new RemoteError('binary', 'binary files are not synced');
    return real;
  }

  async stat(relPath: string): Promise<FileStatResult> {
    const real = await this.resolve(relPath);
    const st = await fs.stat(real);
    const kind: FileKind = st.isDirectory() ? 'directory' : 'file';
    const syncable =
      kind === 'file' && st.size <= this.options.maxFileBytes && !(await looksBinary(real).catch(() => true));
    return { kind, size: st.size, mtime: Math.round(st.mtimeMs), ctime: Math.round(st.ctimeMs), syncable };
  }

  /** Directory entries, without excluded entries and links that leave the root. */
  async list(relPath: string): Promise<Array<[string, FileKind]>> {
    const real = await this.resolve(relPath);
    const base = normalizeDocPath(relPath);
    const realRoot = await this.realRoot;
    const entries = await fs.readdir(real, { withFileTypes: true });
    const result: Array<[string, FileKind]> = [];
    for (const e of entries) {
      const child = base ? `${base}/${e.name}` : e.name;
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          const target = await fs.realpath(path.join(real, e.name));
          if (!isInside(realRoot, target)) continue;
          isDir = (await fs.stat(target)).isDirectory();
        } catch {
          continue; // dangling link
        }
      } else if (!e.isFile() && !isDir) {
        continue; // sockets, fifos...
      }
      if (await this.isExcluded(child, isDir)) continue;
      result.push([e.name, isDir ? 'directory' : 'file']);
    }
    return result;
  }

  /** Every visible file and folder below `relPath`, depth first (or just the file, for a file path). */
  async tree(relPath: string): Promise<TreeResult> {
    const result: TreeResult = { files: [], dirs: [] };
    const realRoot = await this.realRoot;
    const visit = async (dir: string): Promise<void> => {
      for (const [name, kind] of await this.list(dir)) {
        const child = dir ? `${dir}/${name}` : name;
        if (kind === 'directory') {
          // Links to folders inside the root would list the same files twice.
          const real = await fs.realpath(path.join(this.root, child)).catch(() => undefined);
          if (!real || normalizeDocPath(path.relative(realRoot, real)) !== child) continue;
          result.dirs.push(child);
          await visit(child);
        } else {
          const st = await fs.stat(path.join(this.root, child)).catch(() => undefined);
          if (!st?.isFile()) continue;
          if (result.files.length >= MAX_TREE_FILES) {
            throw new RemoteError('too-many-files', `more than ${MAX_TREE_FILES} shared files`);
          }
          result.files.push({ path: child, size: st.size, mtime: Math.round(st.mtimeMs) });
        }
      }
    };
    const base = normalizeDocPath(relPath);
    const st = await fs.stat(await this.resolve(base));
    if (st.isFile()) {
      result.files.push({ path: base, size: st.size, mtime: Math.round(st.mtimeMs) });
      return result;
    }
    await visit(base);
    return result;
  }

  /** Raw bytes of a file as saved on disk (read-only display, mirrors). */
  async readRaw(relPath: string): Promise<Uint8Array> {
    const real = await this.resolve(relPath);
    const st = await fs.stat(real);
    if (!st.isFile()) throw new RemoteError('not-a-file', `not a file: ${relPath}`);
    if (st.size > MAX_RAW_READ_BYTES) throw new RemoteError('too-large', 'file is too large to open remotely');
    return fs.readFile(real);
  }

  /** Workspace-relative docId for a real (symlink-free) path inside the root, or undefined. */
  async relative(realPath: string): Promise<string | undefined> {
    const root = await this.realRoot;
    if (!isInside(root, realPath)) return undefined;
    return normalizeDocPath(path.relative(root, realPath));
  }
}

async function looksBinary(file: string): Promise<boolean> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

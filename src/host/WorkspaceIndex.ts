import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { GlobSet } from '../glob';
import { RemoteError, type FileStatResult, type FileKind } from '../protocol';
import { normalizeDocPath } from '../sync/DocRegistry';

const BINARY_SNIFF_BYTES = 8000;
/** Largest file a guest can read raw (binary or oversized files, read-only). */
export const MAX_RAW_READ_BYTES = 16 * 1024 * 1024;

export interface WorkspaceIndexOptions {
  maxFileBytes: number;
  exclude?: readonly string[];
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

  constructor(
    readonly root: string,
    private readonly options: WorkspaceIndexOptions,
  ) {
    this.realRoot = fs.realpath(root);
    this.excluded = new GlobSet(options.exclude ?? []);
  }

  isExcluded(relPath: string, isDirectory = false): boolean {
    return relPath !== '' && this.excluded.matches(normalizeDocPath(relPath), isDirectory);
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
    // Excluded if the path itself or any parent folder matches lanpair.exclude.
    const segments = normalized.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      const leaf = i === segments.length;
      if (this.isExcluded(prefix, true) || (leaf && this.isExcluded(prefix, false))) {
        throw new RemoteError('not-found', `not found: ${normalized}`);
      }
    }
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
      if (this.isExcluded(child, isDir)) continue;
      result.push([e.name, isDir ? 'directory' : 'file']);
    }
    return result;
  }

  /** Raw bytes for read-only display of files that are not synced as text. */
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

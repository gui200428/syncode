import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { RemoteError } from '../protocol';
import { normalizeDocPath } from '../sync/DocRegistry';

const BINARY_SNIFF_BYTES = 8000;

export interface WorkspaceIndexOptions {
  maxFileBytes: number;
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

  constructor(
    readonly root: string,
    private readonly options: WorkspaceIndexOptions,
  ) {
    this.realRoot = fs.realpath(root);
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

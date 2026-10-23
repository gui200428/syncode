import { createHash } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import type { FsChange, TreeFile, TreeResult } from '../protocol';
import { normalizeDocPath } from '../sync/DocRegistry';

/** What the mirror needs from the session (SessionClient implements it). */
export interface MirrorRemote {
  tree(path: string): Promise<TreeResult>;
  read(path: string): Promise<Uint8Array>;
}

interface ManifestEntry {
  /** Host mtime and size of the version on disk here; -1 when unknown (saved locally). */
  hostMtime: number;
  hostSize: number;
  /** sha1 of the content the mirror wrote (or saw saved), and the local stat after it. */
  hash: string;
  localMtime: number;
  localSize: number;
}

interface Manifest {
  version: 1;
  files: Record<string, ManifestEntry>;
}

export interface MirrorDiskOptions {
  /**
   * Files open in an editor follow the live Y.Text instead; the mirror never
   * writes them, or the editor would reload them and send the reload as an edit.
   */
  isLive(path: string): boolean;
  /**
   * Asked once per sync with the local files that differ from the host and
   * were not written by the mirror. True replaces them, false keeps them
   * (until the host changes them again).
   */
  confirmReplace?(paths: string[]): Promise<boolean>;
  log?(message: string): void;
  concurrency?: number;
}

export interface SyncResult {
  written: number;
  deleted: number;
  /** Local files kept although they differ from the host. */
  kept: number;
}

const sha1 = (bytes: Uint8Array) => createHash('sha1').update(bytes).digest('hex');

function isUnder(p: string, prefix: string): boolean {
  return prefix === '' || p === prefix || p.startsWith(`${prefix}/`);
}

function errorCode(err: unknown): string | undefined {
  return (err as { code?: string } | undefined)?.code;
}

/**
 * Checks a host-supplied path before it touches the guest's disk: relative,
 * no `..`, no NUL, and never inside a `.git` folder (a host could otherwise
 * plant hooks that run on the guest's next commit).
 */
export function safeRelativePath(rel: string): string | undefined {
  if (typeof rel !== 'string' || rel.includes('\0')) return undefined;
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return undefined;
  const normalized = normalizeDocPath(rel).replace(/\/+$/, '');
  if (normalized === '') return undefined;
  const segments = normalized.split('/');
  if (segments.some((s) => s === '..' || s === '.' || s.toLowerCase() === '.git')) return undefined;
  return normalized;
}

async function lstat(file: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(file);
  } catch (err) {
    if (errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR') return undefined;
    throw err;
  }
}

async function pool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

/**
 * Keeps a local folder equal to the host's shared folder, as saved on disk.
 * A manifest (kept outside the folder) remembers what the mirror wrote, so
 * files the guest changed on its own are never silently overwritten or
 * deleted. Files that are open in an editor are left to the live binding.
 */
export class MirrorDisk {
  private manifest: Manifest = { version: 1, files: {} };
  /** Files the host shares, as of the last sync. */
  private readonly hostFiles = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly log: (message: string) => void;
  private realRoot: string | undefined;

  constructor(
    readonly root: string,
    private readonly remote: MirrorRemote,
    private readonly manifestPath: string,
    private readonly options: MirrorDiskOptions,
  ) {
    this.log = options.log ?? (() => {});
  }

  /** True if the host shares this file (it may still be loading). */
  knows(rel: string): boolean {
    return this.hostFiles.has(normalizeDocPath(rel));
  }

  /** Mirror-relative path of an absolute local path, or undefined if outside the folder. */
  relativePath(absolute: string): string | undefined {
    const rel = path.relative(this.root, absolute);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return normalizeDocPath(rel);
  }

  /** Brings the folder (or the part below `prefix`) up to date with the host. */
  sync(prefix = ''): Promise<SyncResult> {
    return this.enqueue(() => this.doSync(prefix));
  }

  /** Applies the host's file events: downloads created/changed files, deletes removed ones. */
  applyHostChanges(changes: readonly FsChange[]): Promise<void> {
    return this.enqueue(async () => {
      for (const c of changes) {
        const rel = safeRelativePath(c.path);
        if (!rel) continue;
        try {
          if (c.type === 'deleted') await this.removeMissing(rel, new Set());
          else await this.doSync(rel, { quiet: true });
        } catch (err) {
          this.log(`could not apply host change to ${rel}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
  }

  /**
   * Records that the editor saved `rel` here (a live file), so the next sync
   * may replace it with the host's version without asking.
   */
  markSaved(rel: string): Promise<void> {
    return this.enqueue(async () => {
      const file = this.absolute(rel);
      if (!file) return;
      const st = await lstat(file);
      if (!st?.isFile()) return;
      const bytes = await fs.readFile(file);
      this.manifest.files[rel] = {
        hostMtime: -1,
        hostSize: -1,
        hash: sha1(bytes),
        localMtime: Math.round(st.mtimeMs),
        localSize: st.size,
      };
      await this.saveManifest();
    });
  }

  /** Loads the manifest of an earlier mirror of this folder, if any. */
  async load(): Promise<void> {
    try {
      const data = JSON.parse(await fs.readFile(this.manifestPath, 'utf8')) as Manifest;
      if (data?.version === 1 && typeof data.files === 'object') this.manifest = data;
    } catch {
      // First mirror into this folder.
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private absolute(rel: string): string | undefined {
    const safe = safeRelativePath(rel);
    return safe ? path.join(this.root, ...safe.split('/')) : undefined;
  }

  /**
   * Creates the parent folders of `file`, refusing to go through symbolic
   * links that leave the mirror folder.
   */
  private async ensureParent(file: string): Promise<void> {
    this.realRoot ??= await fs.realpath(this.root);
    const rel = path.relative(this.root, path.dirname(file));
    let current = this.root;
    for (const segment of rel ? rel.split(path.sep) : []) {
      current = path.join(current, segment);
      const st = await lstat(current);
      if (!st) {
        await fs.mkdir(current);
        continue;
      }
      if (st.isSymbolicLink()) {
        const real = await fs.realpath(current);
        const inside = path.relative(this.realRoot, real);
        if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`${current} links outside the mirror folder`);
        if (!(await fs.stat(real)).isDirectory()) throw new Error(`${current} is not a folder`);
      } else if (!st.isDirectory()) {
        throw new Error(`${current} is not a folder`);
      }
    }
  }

  private async write(rel: string, file: string, bytes: Uint8Array, host: TreeFile): Promise<boolean> {
    if (this.options.isLive(rel)) return false; // opened meanwhile
    await this.ensureParent(file);
    await fs.writeFile(file, bytes);
    const st = await fs.stat(file);
    this.remember(rel, host, sha1(bytes), st);
    return true;
  }

  private remember(rel: string, host: TreeFile, hash: string, local: Stats): void {
    this.manifest.files[rel] = {
      hostMtime: host.mtime,
      hostSize: host.size,
      hash,
      localMtime: Math.round(local.mtimeMs),
      localSize: local.size,
    };
  }

  private async doSync(prefix: string, opts: { quiet?: boolean } = {}): Promise<SyncResult> {
    const result: SyncResult = { written: 0, deleted: 0, kept: 0 };
    let tree: TreeResult;
    try {
      tree = await this.remote.tree(prefix);
    } catch (err) {
      if (errorCode(err) !== 'not-found' || prefix === '') throw err;
      // Gone (or hidden) on the host by now.
      result.deleted += await this.removeMissing(prefix, new Set());
      await this.saveManifest();
      return result;
    }

    for (const dir of tree.dirs) {
      const abs = this.absolute(dir);
      if (!abs) continue;
      try {
        await this.ensureParent(path.join(abs, 'x'));
      } catch (err) {
        this.log(`cannot create folder ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const seen = new Set<string>();
    const conflicts: Array<{ rel: string; file: string; bytes: Uint8Array; host: TreeFile }> = [];
    const files = tree.files.filter((f) => {
      const rel = safeRelativePath(f.path);
      if (!rel || !isUnder(rel, prefix)) {
        this.log(`ignoring unsafe path from host: ${JSON.stringify(f.path)}`);
        return false;
      }
      seen.add(rel);
      this.hostFiles.add(rel);
      return true;
    });

    await pool(files, this.options.concurrency ?? 8, async (host) => {
      const rel = normalizeDocPath(host.path);
      const file = this.absolute(rel)!;
      if (this.options.isLive(rel)) return;
      try {
        const local = await lstat(file);
        if (local && !local.isFile()) {
          this.log(`not replacing ${rel}: it is not a regular file here`);
          return;
        }
        const known = this.manifest.files[rel];
        if (
          known &&
          local &&
          known.hostMtime === host.mtime &&
          known.hostSize === host.size &&
          known.localMtime === Math.round(local.mtimeMs) &&
          known.localSize === local.size
        ) {
          return; // up to date
        }
        const bytes = await this.remote.read(rel);
        const hash = sha1(bytes);
        if (!local) {
          if (await this.write(rel, file, bytes, host)) result.written++;
          return;
        }
        const localHash = sha1(await fs.readFile(file));
        if (localHash === hash) {
          this.remember(rel, host, hash, local);
        } else if (known && known.hash === localHash) {
          if (await this.write(rel, file, bytes, host)) result.written++;
        } else {
          conflicts.push({ rel, file, bytes, host });
        }
      } catch (err) {
        this.log(`could not mirror ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    if (conflicts.length > 0) {
      conflicts.sort((a, b) => a.rel.localeCompare(b.rel));
      const replace = opts.quiet ? true : ((await this.options.confirmReplace?.(conflicts.map((c) => c.rel))) ?? true);
      for (const c of conflicts) {
        if (replace) {
          if (await this.write(c.rel, c.file, c.bytes, c.host).catch(() => false)) result.written++;
          continue;
        }
        // Keep the local version; the host's next change to it replaces it.
        const local = await lstat(c.file);
        if (local) this.remember(c.rel, c.host, sha1(await fs.readFile(c.file)), local);
        result.kept++;
      }
    }

    result.deleted += await this.removeMissing(prefix, seen);
    await this.saveManifest();
    return result;
  }

  /**
   * Deletes mirrored files below `prefix` that the host no longer shares,
   * unless they were changed here. Returns how many were deleted.
   */
  private async removeMissing(prefix: string, present: ReadonlySet<string>): Promise<number> {
    let deleted = 0;
    for (const rel of [...this.hostFiles]) {
      if (isUnder(rel, prefix) && !present.has(rel)) this.hostFiles.delete(rel);
    }
    for (const [rel, known] of Object.entries(this.manifest.files)) {
      if (!isUnder(rel, prefix) || present.has(rel) || this.options.isLive(rel)) continue;
      const file = this.absolute(rel);
      delete this.manifest.files[rel];
      if (!file) continue;
      const local = await lstat(file);
      if (!local?.isFile()) continue;
      if (sha1(await fs.readFile(file)) !== known.hash) {
        this.log(`keeping ${rel}: deleted on the host but changed here`);
        continue;
      }
      await fs.unlink(file);
      deleted++;
      await this.pruneEmptyParents(path.dirname(file));
    }
    if (prefix !== '' && present.size === 0) {
      const dir = this.absolute(prefix);
      if (dir && (await lstat(dir))?.isDirectory()) await this.pruneEmptyDirs(dir);
    }
    return deleted;
  }

  /** Removes `dir` and its subfolders if they hold no files. */
  private async pruneEmptyDirs(dir: string): Promise<boolean> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let empty = true;
    for (const e of entries) {
      if (e.isDirectory() && (await this.pruneEmptyDirs(path.join(dir, e.name)))) continue;
      empty = false;
    }
    if (empty) await fs.rmdir(dir).catch(() => {});
    return empty;
  }

  private async pruneEmptyParents(dir: string): Promise<void> {
    while (dir !== this.root && dir.startsWith(this.root)) {
      const rel = this.relativePath(dir);
      // Folders the host still shares stay, even when empty.
      if (rel && [...this.hostFiles].some((f) => isUnder(f, rel))) return;
      try {
        await fs.rmdir(dir);
      } catch {
        return; // not empty
      }
      dir = path.dirname(dir);
    }
  }

  private async saveManifest(): Promise<void> {
    await fs.mkdir(path.dirname(this.manifestPath), { recursive: true });
    const tmp = `${this.manifestPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.manifest));
    await fs.rename(tmp, this.manifestPath);
  }
}

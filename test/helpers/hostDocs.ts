import { promises as fs } from 'node:fs';
import type { HostDocs } from '../../src/host/SessionServer';
import { WorkspaceIndex } from '../../src/host/WorkspaceIndex';
import { DocRegistry } from '../../src/sync/DocRegistry';

/** HostDocs over a plain folder, without an editor: Y.Docs are seeded from disk. */
export function folderHostDocs(
  root: string,
  maxFileBytes = 2 * 1024 * 1024,
  exclude: string[] = [],
  options: { retain?: boolean } = {},
) {
  const index = new WorkspaceIndex(root, { maxFileBytes, exclude });
  const registry = new DocRegistry({ retain: options.retain });
  const saved: string[] = [];
  const docs: HostDocs = {
    async open(path) {
      const real = await index.resolveTextFile(path);
      const canonical = (await index.relative(real)) ?? path;
      const text = await fs.readFile(real, 'utf8');
      return registry.acquire(canonical, () => text);
    },
    close(path) {
      registry.release(path);
    },
    async save(path) {
      saved.push(path);
    },
    stat: (path) => index.stat(path),
    list: (path) => index.list(path),
    read: (path) => index.readRaw(path),
  };
  return { docs, registry, index, saved };
}

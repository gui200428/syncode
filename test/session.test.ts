import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { JoinError, SessionClient } from '../src/guest/SessionClient';
import { SessionServer, toUint8 } from '../src/host/SessionServer';
import { decodeFrame, decodeJson, jsonFrame, MsgType, PROTOCOL_VERSION } from '../src/protocol';
import { folderHostDocs } from './helpers/hostDocs';
import { rng } from './helpers/random';

const PIN = '123456';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await sleep(10);
  }
}

describe('SessionServer / SessionClient', () => {
  let root: string;
  let host: ReturnType<typeof folderHostDocs>;
  let server: SessionServer;
  const clients: SessionClient[] = [];

  const join = (pin = PIN, name = 'guest') =>
    SessionClient.connect({ host: '127.0.0.1', port: server.port, pin, name, color: '#f00' }).then((c) => {
      clients.push(c);
      return c;
    });

  beforeEach(async () => {
    root = mkdtempSync(join_(tmpdir(), 'lanpair-session-'));
    mkdirSync(join_(root, 'src'));
    writeFileSync(join_(root, 'src', 'main.ts'), 'const a = 1;\r\nconst b = 2;\r\n');
    writeFileSync(join_(root, 'blob.bin'), Buffer.from([0, 1, 2]));
    writeFileSync(join_(root, 'secret.env'), 'KEY=1');
    mkdirSync(join_(root, 'node_modules'));
    writeFileSync(join_(root, 'node_modules', 'dep.js'), '');
    host = folderHostDocs(root, 2 * 1024 * 1024, ['**/node_modules/**', '*.env']);
    server = await SessionServer.start({
      port: 0,
      host: '127.0.0.1',
      pin: PIN,
      sessionId: 'abcd1234',
      hostName: 'Host',
      rootName: 'proj',
      docs: host.docs,
      awareness: host.registry.awareness,
      helloTimeoutMs: 300,
    });
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.dispose();
    server.dispose();
    host.registry.dispose();
  });

  it('welcomes a guest with the right PIN', async () => {
    const c = await join();
    expect(c.welcome).toMatchObject({ protocol: PROTOCOL_VERSION, sessionId: 'abcd1234', rootName: 'proj' });
    await until(() => server.guests.length === 1);
    expect(server.guests[0]).toMatchObject({ name: 'guest', color: '#f00' });
  });

  it('rejects wrong PINs and blocks the address after 5 failures', async () => {
    for (let left = 4; left >= 1; left--) {
      await expect(join('000000')).rejects.toMatchObject({ code: 'pin', attemptsLeft: left });
    }
    await expect(join('000000')).rejects.toMatchObject({ code: 'blocked', attemptsLeft: 0 });
    await expect(join(PIN)).rejects.toMatchObject({ code: 'blocked' });
    expect(server.guests).toHaveLength(0);
  });

  it('sends nothing but a Reject before authentication', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const frames: number[] = [];
    ws.on('message', (d) => frames.push(decodeFrame(toUint8(d)).type));
    await new Promise((r) => ws.once('open', r));
    // Try to skip the handshake and request a file directly.
    ws.send(jsonFrame(MsgType.Request, { id: 1, method: 'open', params: { path: 'src/main.ts' } }));
    await new Promise((r) => ws.once('close', r));
    expect(frames).toEqual([MsgType.Reject]);
  });

  it('rejects other protocol versions and silent clients', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const reject = new Promise<unknown>((r) => ws.once('message', (d) => r(decodeJson(decodeFrame(toUint8(d)).payload))));
    await new Promise((r) => ws.once('open', r));
    ws.send(jsonFrame(MsgType.Hello, { protocol: PROTOCOL_VERSION + 1, pin: PIN, name: 'x', color: 'x' }));
    expect(await reject).toMatchObject({ code: 'version' });

    const silent = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const msg = new Promise<unknown>((r) => silent.once('message', (d) => r(decodeJson(decodeFrame(toUint8(d)).payload))));
    expect(await msg).toMatchObject({ code: 'timeout' });
  });

  it('reports network errors', async () => {
    const port = server.port;
    server.dispose();
    await expect(
      SessionClient.connect({ host: '127.0.0.1', port, pin: PIN, name: 'g', color: 'c', timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(JoinError);
  });

  it('opens a file with normalized line endings and refuses unsafe paths', async () => {
    const c = await join();
    const entry = await c.openDoc('./src/main.ts');
    expect(entry.path).toBe('src/main.ts');
    expect(entry.text.toString()).toBe('const a = 1;\nconst b = 2;\n');
    await expect(c.openDoc('../outside.txt')).rejects.toMatchObject({ code: 'outside-root' });
    await expect(c.openDoc('blob.bin')).rejects.toMatchObject({ code: 'binary' });
    await expect(c.openDoc('nope.ts')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('syncs concurrent edits between host and two guests', async () => {
    const g1 = await join(PIN, 'g1');
    const g2 = await join(PIN, 'g2');
    const [e1, e2] = await Promise.all([g1.openDoc('src/main.ts'), g2.openDoc('src/main.ts')]);
    const h = host.registry.get('src/main.ts')!;
    const r = rng(3);
    for (let i = 0; i < 300; i++) {
      const t = [h.text, e1.text, e2.text][r.int(3)]!;
      const len = t.length;
      if (r.next() < 0.7 || len === 0) t.insert(r.int(len + 1), r.str(3));
      else t.delete(r.int(len), 1);
      if (r.next() < 0.2) await sleep(0);
    }
    await until(() => e1.text.toString() === h.text.toString() && e2.text.toString() === h.text.toString());
    expect(h.text.length).toBeGreaterThan(20);
  });

  it('releases host documents when guests close them or leave', async () => {
    const g1 = await join();
    await g1.openDoc('src/main.ts');
    await g1.openDoc('src/main.ts'); // second reference, same host reference
    expect(host.registry.get('src/main.ts')).toBeDefined();
    g1.closeDoc('src/main.ts');
    await sleep(50);
    expect(host.registry.get('src/main.ts')).toBeDefined();
    g1.closeDoc('src/main.ts');
    await until(() => host.registry.get('src/main.ts') === undefined);

    const g2 = await join();
    await g2.openDoc('src/main.ts');
    g2.dispose();
    await until(() => host.registry.get('src/main.ts') === undefined && server.guests.length === 1); // g1 is still connected
  });

  it('forwards save requests and notifies guests', async () => {
    const g1 = await join();
    const g2 = await join();
    await g1.openDoc('src/main.ts');
    await g2.openDoc('src/main.ts');
    const notified: string[] = [];
    g2.onDidNotify((n) => notified.push(n.event === 'saved' ? `saved:${n.path}` : n.event));
    await g1.save('src/main.ts');
    expect(host.saved).toEqual(['src/main.ts']);
    await until(() => notified.length === 1);
    expect(notified).toEqual(['saved:src/main.ts']);
  });

  it('lists, stats and reads files, hiding excluded ones', async () => {
    const c = await join();
    const rootEntries = await c.list('');
    expect(rootEntries).toEqual(expect.arrayContaining([['src', 'directory'], ['blob.bin', 'file']]));
    expect(rootEntries.map((e) => e[0])).not.toContain('node_modules');
    expect(rootEntries.map((e) => e[0])).not.toContain('secret.env');
    await expect(c.list('node_modules')).rejects.toMatchObject({ code: 'not-found' });
    await expect(c.openDoc('secret.env')).rejects.toMatchObject({ code: 'not-found' });
    expect(await c.stat('src/main.ts')).toMatchObject({ kind: 'file', syncable: true });
    expect(await c.stat('blob.bin')).toMatchObject({ kind: 'file', syncable: false });
    expect(await c.stat('')).toMatchObject({ kind: 'directory' });
    expect([...(await c.read('blob.bin'))]).toEqual([0, 1, 2]);
    await expect(c.read('../x')).rejects.toMatchObject({ code: 'outside-root' });
  });

  it('relays presence between host and guests and clears it when a guest leaves', async () => {
    host.registry.awareness.setLocalState({ user: { name: 'Host' } });
    const g1 = await join(PIN, 'g1');
    await until(() => g1.registry.awareness.getStates().size === 2);
    const g2 = await join(PIN, 'g2');
    g2.registry.awareness.setLocalState({ user: { name: 'g2' }, file: 'src/main.ts' });
    await until(() => g1.registry.awareness.getStates().size === 3);
    const names = () => [...g1.registry.awareness.getStates().values()].map((s) => (s as { user?: { name: string } }).user?.name);
    await until(() => names().includes('g2'));
    g2.dispose();
    await until(() => g1.registry.awareness.getStates().size === 2);
    // g1 never published a state, so the host only knows itself again.
    await until(() => host.registry.awareness.getStates().size === 1);
  });

  it('closes the guest session when the host stops', async () => {
    const c = await join();
    const closed = new Promise<string>((r) => c.onDidClose(r));
    server.dispose();
    expect(await closed).toContain('1001');
    expect(c.isOpen).toBe(false);
  });
});

function join_(...parts: string[]): string {
  return join(...parts);
}

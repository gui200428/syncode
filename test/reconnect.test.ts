import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionClient, type ConnectionState } from '../src/guest/SessionClient';
import { SessionServer } from '../src/host/SessionServer';
import { folderHostDocs } from './helpers/hostDocs';

const PIN = '111111';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await sleep(10);
  }
}

describe('reconnection', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanup.splice(0).reverse()) c();
  });

  async function setup(port = 0, sessionId = 'sess0001') {
    const root = mkdtempSync(join(tmpdir(), 'syncode-reconnect-'));
    writeFileSync(join(root, 'a.txt'), 'hello world\n');
    // Like the real host, keep documents for the whole session.
    const host = folderHostDocs(root, undefined, [], { retain: true });
    const server = await SessionServer.start({
      port,
      host: '127.0.0.1',
      pin: PIN,
      sessionId,
      hostName: 'Host',
      rootName: 'r',
      docs: host.docs,
      awareness: host.registry.awareness,
      heartbeatMs: 100,
    });
    cleanup.push(() => {
      server.dispose();
      host.registry.dispose();
    });
    return { root, host, server };
  }

  async function guest(port: number) {
    const c = await SessionClient.connect({
      host: '127.0.0.1',
      port,
      pin: PIN,
      name: 'g',
      color: '#0f0',
      backoffMs: [50, 100],
      deadAfterMs: 400,
      log: (m) => process.env.SYNCODE_DEBUG && console.log('[client]', m),
    });
    cleanup.push(() => c.dispose());
    return c;
  }

  it('reconnects after a network drop and merges edits made on both sides meanwhile', async () => {
    const { host, server } = await setup();
    const g = await guest(server.port);
    const states: ConnectionState[] = [];
    g.onDidChangeState((s) => states.push(s));
    const entry = await g.openDoc('a.txt');
    const h = host.registry.get('a.txt')!;

    server.simulateNetworkDrop();
    await until(() => !g.isConnected);
    entry.text.insert(0, 'GUEST ');
    h.text.insert(h.text.length, 'HOST\n');

    await until(() => g.isConnected);
    await until(() => entry.text.toString() === h.text.toString());
    expect(h.text.toString()).toBe('GUEST hello world\nHOST\n');
    expect(states).toEqual(['reconnecting', 'connected']);
    expect(g.isOpen).toBe(true);
  });

  it('keeps reconnecting while the host is unreachable and restores presence', async () => {
    const { host, server } = await setup();
    host.registry.awareness.setLocalState({ user: { name: 'Host' } });
    const g = await guest(server.port);
    g.registry.awareness.setLocalState({ user: { name: 'g' } });
    await until(() => g.registry.awareness.getStates().size === 2 && host.registry.awareness.getStates().size === 2);
    server.simulateNetworkDrop();
    await until(() => !g.isConnected);
    await until(() => g.isConnected);
    const sizes = () => `guest=${g.registry.awareness.getStates().size} host=${host.registry.awareness.getStates().size}`;
    await until(() => g.registry.awareness.getStates().size === 2 && host.registry.awareness.getStates().size === 2, 2000).catch(() => {
      throw new Error(`presence not restored: ${sizes()}`);
    });
  });

  it('detects a silent host through the heartbeat', async () => {
    const { server } = await setup();
    const g = await guest(server.port);
    // Freeze the server's pings: the guest must notice and reconnect.
    (server as unknown as { heartbeat: ReturnType<typeof setInterval> }).heartbeat &&
      clearInterval((server as unknown as { heartbeat: ReturnType<typeof setInterval> }).heartbeat);
    await until(() => !g.isConnected, 3000);
    await until(() => g.isConnected, 3000);
  });

  it('gives up when the host ends the session', async () => {
    const { server } = await setup();
    const g = await guest(server.port);
    const closed = new Promise<string>((r) => g.onDidClose(r));
    server.dispose();
    expect(await closed).toContain('1001');
    expect(g.isOpen).toBe(false);
  });

  it('ends the session instead of merging into a recreated document', async () => {
    const root = mkdtempSync(join(tmpdir(), 'syncode-reconnect-'));
    writeFileSync(join(root, 'a.txt'), 'abc');
    const host = folderHostDocs(root); // no retain: the doc is recreated
    const server = await SessionServer.start({
      port: 0, host: '127.0.0.1', pin: PIN, sessionId: 's', hostName: 'H', rootName: 'r',
      docs: host.docs, awareness: host.registry.awareness, heartbeatMs: 100,
    });
    cleanup.push(() => server.dispose());
    const g = await guest(server.port);
    const entry = await g.openDoc('a.txt');
    const closed = new Promise<string>((r) => g.onDidClose(r));
    server.simulateNetworkDrop();
    expect(await closed).toContain('recreated');
    expect(entry.text.toString()).toBe('abc'); // nothing duplicated
  });

  it('gives up when a new session runs on the same port', async () => {
    const first = await setup();
    const port = first.server.port;
    const g = await guest(port);
    const closed = new Promise<string>((r) => g.onDidClose(r));
    first.server.simulateNetworkDrop();
    first.server.dispose();
    await setup(port, 'sess0002');
    expect(await closed).toMatch(/new session|1001/);
  });
});

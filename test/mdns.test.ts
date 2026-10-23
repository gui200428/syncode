import { describe, expect, it } from 'vitest';
import { advertise, browse, type DiscoveredSession } from '../src/discovery/mdns';
import { PROTOCOL_VERSION } from '../src/protocol';

describe('mDNS discovery', () => {
  it('finds an advertised session and notices when it goes away', async () => {
    const sessionId = `t${Math.random().toString(16).slice(2, 9)}`;
    const ad = advertise({ sessionId, hostName: 'Ana', rootName: 'proj', port: 45678 }, () => {});
    let latest: DiscoveredSession[] = [];
    const browser = browse((s) => (latest = s), () => {});
    try {
      const start = Date.now();
      while (!latest.some((s) => s.sessionId === sessionId)) {
        if (Date.now() - start > 8000) throw new Error('not discovered');
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(latest.find((s) => s.sessionId === sessionId)).toMatchObject({
        hostName: 'Ana',
        rootName: 'proj',
        port: 45678,
        protocol: PROTOCOL_VERSION,
      });
    } finally {
      ad.dispose();
      browser.dispose();
    }
  }, 15000);
});

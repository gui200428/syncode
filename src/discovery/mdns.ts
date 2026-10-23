import { Bonjour, type Service } from 'bonjour-service';
import { PROTOCOL_VERSION } from '../protocol';
import type { Disposable } from '../sync/document';

/** DNS-SD service type: _lanpair._tcp.local */
export const SERVICE_TYPE = 'lanpair';

export interface AdvertisedSession {
  sessionId: string;
  hostName: string;
  rootName: string;
  port: number;
}

export interface DiscoveredSession extends AdvertisedSession {
  /** Address to connect to (where the announcement came from, else the first IPv4). */
  address: string;
  protocol: number;
}

/** Announces a hosted session on the LAN until disposed. */
export function advertise(session: AdvertisedSession, log: (m: string) => void): Disposable {
  const bonjour = new Bonjour(undefined, (err: unknown) => log(`mDNS error: ${String(err)}`));
  const service = bonjour.publish({
    // Instance names must be unique on the network; the session id makes it so.
    name: `${session.hostName} · ${session.rootName} (${session.sessionId})`.slice(0, 63),
    type: SERVICE_TYPE,
    port: session.port,
    disableIPv6: true,
    txt: { sid: session.sessionId, host: session.hostName, root: session.rootName, v: String(PROTOCOL_VERSION) },
  });
  service.on('error', (err: unknown) => log(`mDNS advertise error: ${String(err)}`));
  return {
    dispose: () => {
      service.stop?.(() => bonjour.destroy());
      setTimeout(() => bonjour.destroy(), 1000).unref?.();
    },
  };
}

function toSession(service: Service): DiscoveredSession | undefined {
  const txt = (service.txt ?? {}) as Record<string, unknown>;
  const sid = typeof txt.sid === 'string' ? txt.sid : undefined;
  if (!sid) return undefined;
  const ipv4 = (service.addresses ?? []).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  const address = service.referer?.address ?? ipv4[0];
  if (!address) return undefined;
  return {
    sessionId: sid,
    hostName: typeof txt.host === 'string' ? txt.host : service.name,
    rootName: typeof txt.root === 'string' ? txt.root : '',
    port: service.port,
    address,
    protocol: Number(txt.v ?? 0),
  };
}

/**
 * Looks for sessions on the LAN; `onChange` receives the full current list
 * whenever it changes. Queries are repeated so new hosts show up quickly.
 */
export function browse(onChange: (sessions: DiscoveredSession[]) => void, log: (m: string) => void): Disposable {
  const bonjour = new Bonjour(undefined, (err: unknown) => log(`mDNS error: ${String(err)}`));
  const browser = bonjour.find({ type: SERVICE_TYPE });
  const emit = () => {
    const byId = new Map<string, DiscoveredSession>();
    for (const s of browser.services) {
      const session = toSession(s);
      if (session) byId.set(session.sessionId, session);
    }
    onChange([...byId.values()]);
  };
  browser.on('up', emit);
  browser.on('down', emit);
  browser.on('txt-update', emit);
  const requery = setInterval(() => browser.update(), 3000);
  return {
    dispose: () => {
      clearInterval(requery);
      browser.stop();
      bonjour.destroy();
    },
  };
}

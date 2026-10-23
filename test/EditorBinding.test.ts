import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { LOCAL_ORIGIN } from '../src/sync/EditorBinding';
import { createPair, createPeer, Link, settle, tick, type Peer } from './helpers/peers';
import { rng } from './helpers/random';

function expectConverged(...peers: Peer[]): void {
  const expected = peers[0]!.ytext();
  for (const p of peers) {
    expect(p.ytext()).toBe(expected);
    expect(p.text()).toBe(expected);
    expect(p.binding.isConsistent()).toBe(true);
    expect(p.logs.filter((l) => /out of sync|threw|resolved before/.test(l))).toEqual([]);
  }
}

describe('EditorBinding', () => {
  it('initializes the guest editor from the Y.Text', async () => {
    const { host, guest } = await createPair('hello\nworld');
    expect(guest.text()).toBe('hello\nworld');
    expectConverged(host, guest);
  });

  it('keeps unsaved host text when it seeds the Y.Text', async () => {
    // The registry seeds from the TextDocument; the binding then sees nothing to do.
    const host = createPeer('unsaved edits');
    await settle([host]);
    expect(host.raw.version).toBe(0);
    expect(host.ytext()).toBe('unsaved edits');
  });

  it('propagates typing in both directions', async () => {
    const { host, guest, link } = await createPair('abc');
    host.raw.userEdit([{ offset: 3, length: 0, text: 'd' }]);
    await settle([host, guest], link);
    guest.raw.userEdit([{ offset: 0, length: 1, text: 'A' }]);
    await settle([host, guest], link);
    expect(host.text()).toBe('Abcd');
    expectConverged(host, guest);
  });

  it('does not echo remote edits back into the Y.Text', async () => {
    const { host, guest, link } = await createPair('abc');
    const localTx: unknown[] = [];
    guest.ydoc.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.origin === LOCAL_ORIGIN) localTx.push(tr);
    });
    const versionBefore = guest.raw.version;
    host.raw.userEdit([{ offset: 1, length: 1, text: 'XYZ' }]);
    await settle([host, guest], link);
    expect(guest.text()).toBe('aXYZc');
    expect(guest.raw.version).toBe(versionBefore + 1); // exactly one applyEdit
    expect(localTx).toHaveLength(0); // the echo was not pushed back
    expectConverged(host, guest);
  });

  it('applies multi-cursor changes in one event', async () => {
    const { host, guest, link } = await createPair('foo bar baz\nfoo bar baz');
    // Rename every "bar" at once, plus an insertion at the start.
    host.raw.userEdit([
      { offset: 0, length: 0, text: '// ' },
      { offset: 4, length: 3, text: 'quux' },
      { offset: 16, length: 3, text: 'quux' },
    ]);
    await settle([host, guest], link);
    expect(guest.text()).toBe('// foo quux baz\nfoo quux baz');
    expectConverged(host, guest);
  });

  it('syncs a CRLF host with an LF guest', async () => {
    const { host, guest, link } = await createPair('one\ntwo\nthree', { hostEol: '\r\n' });
    expect(host.raw.getText()).toBe('one\r\ntwo\r\nthree');
    expect(guest.raw.getText()).toBe('one\ntwo\nthree');
    expect(host.ytext()).toBe('one\ntwo\nthree');

    guest.raw.userEdit([{ offset: 8, length: 0, text: 'and\n' }]); // before "three"
    await settle([host, guest], link);
    expect(host.raw.getText()).toBe('one\r\ntwo\r\nand\r\nthree');

    host.raw.userEdit([{ offset: 5, length: 5, text: '' }]); // delete "two\r\n"
    await settle([host, guest], link);
    expect(guest.raw.getText()).toBe('one\nand\nthree');
    expectConverged(host, guest);
  });

  it('merges concurrent inserts at the same position', async () => {
    const { host, guest, link } = await createPair('ab', { manual: true });
    host.raw.userEdit([{ offset: 1, length: 0, text: 'HOST' }]);
    guest.raw.userEdit([{ offset: 1, length: 0, text: 'GUEST' }]);
    await settle([host, guest], link);
    expect(host.text()).toMatch(/^a(HOSTGUEST|GUESTHOST)b$/);
    expectConverged(host, guest);
  });

  it('merges concurrent overlapping deletes and inserts', async () => {
    const { host, guest, link } = await createPair('0123456789', { manual: true });
    host.raw.userEdit([{ offset: 2, length: 5, text: 'H' }]);
    guest.raw.userEdit([{ offset: 4, length: 5, text: 'G' }]);
    await settle([host, guest], link);
    expect(host.text()).toBe('01HG9');
    expectConverged(host, guest);
  });

  it('handles pasting a large text', async () => {
    const { host, guest, link } = await createPair('start\nend');
    const big = Array.from({ length: 20_000 }, (_, i) => `line ${i}: ${'x'.repeat(i % 80)}`).join('\n');
    host.raw.userEdit([{ offset: 6, length: 0, text: `${big}\n` }]);
    guest.raw.userEdit([{ offset: 0, length: 5, text: 'START' }]);
    await settle([host, guest], link);
    expect(guest.text()).toBe(`START\n${big}\nend`);
    expectConverged(host, guest);
  });

  describe('race between async applyEdit and local typing', () => {
    it('keeps local typing that happens before a remote edit is applied', async () => {
      const { host, guest, link } = await createPair('hello world', { manual: true });

      host.raw.userEdit([{ offset: 0, length: 0, text: '>> ' }]);
      link.deliver();
      await tick(); // guest binding has sent its applyEdit, still unapplied
      expect(guest.raw.pendingApplies).toBe(1);

      guest.raw.userEdit([{ offset: 11, length: 0, text: '!' }]); // user types first
      expect(guest.ytext()).toBe('>> hello world!');
      expect(guest.raw.releaseNext()).toBe(true); // rejected: version changed
      expect(guest.text()).toBe('hello world!');

      await settle([host, guest], link);
      expect(host.text()).toBe('>> hello world!');
      expectConverged(host, guest);
    });

    it('keeps local typing between the echo and the applyEdit resolution', async () => {
      const { host, guest, link } = await createPair('abc', { manual: true });
      host.raw.userEdit([{ offset: 3, length: 0, text: 'def' }]);
      link.deliver();
      await tick();
      guest.raw.releaseNext(() => {
        guest.raw.userEdit([{ offset: 0, length: 0, text: '_' }]);
      });
      await settle([host, guest], link);
      expect(host.text()).toBe('_abcdef');
      expectConverged(host, guest);
    });

    it('keeps remote edits that arrive while an applyEdit is in flight', async () => {
      const { host, guest, link } = await createPair('abc', { manual: true });
      host.raw.userEdit([{ offset: 0, length: 0, text: '1' }]);
      link.deliver();
      await tick();
      host.raw.userEdit([{ offset: 4, length: 0, text: '2' }]);
      link.deliver();
      guest.raw.userEdit([{ offset: 1, length: 1, text: 'B' }]);
      await settle([host, guest], link);
      expect(host.text()).toBe('1aBc2');
      expectConverged(host, guest);
    });
  });

  it('converges under random concurrent editing (fuzz)', async () => {
    let rejected = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const { host, guest, link } = await createPair('fn main() {\n  body\n}\n', {
        manual: true,
        hostEol: seed % 2 ? '\r\n' : '\n',
      });
      const peers = [host, guest];
      for (let step = 0; step < 150; step++) {
        const p = peers[r.int(2)]!;
        const action = r.next();
        if (action < 0.5) {
          const text = p.text();
          const edits = [];
          let cursor = 0;
          for (let k = 0; k < 1 + r.int(3) && cursor <= text.length; k++) {
            const offset = cursor + r.int(Math.max(1, Math.min(10, text.length - cursor + 1)));
            if (offset > text.length) break;
            const length = Math.min(r.int(4), text.length - offset);
            edits.push({ offset, length, text: r.str(4) });
            cursor = offset + length + 1;
          }
          p.raw.userEditNormalized(edits.filter((e) => !/[\udc00-\udfff]/.test(text[e.offset] ?? '') && !/[\udc00-\udfff]/.test(text[e.offset + e.length] ?? '')));
        } else if (action < 0.7) {
          link.deliver(p.ydoc);
        } else if (action < 0.85) {
          p.raw.releaseNext(r.next() < 0.3 ? () => p.raw.userEditNormalized([{ offset: 0, length: 0, text: 'z' }]) : undefined);
        } else {
          await tick();
        }
      }
      await settle(peers, link);
      expectConverged(host, guest);
      rejected += host.raw.rejected + guest.raw.rejected;
    }
    // The run must actually exercise the applyEdit/typing race.
    expect(rejected).toBeGreaterThan(20);
  });

  it('stops syncing after dispose', async () => {
    const { host, guest, link } = await createPair('abc');
    guest.binding.dispose();
    host.raw.userEdit([{ offset: 0, length: 0, text: 'x' }]);
    await settle([host], link);
    expect(guest.ytext()).toBe('xabc');
    expect(guest.text()).toBe('abc');
  });
});

describe('two Y.Docs without editors', () => {
  it('link helper converges', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    new Link(a, b);
    a.getText('content').insert(0, 'hi');
    expect(b.getText('content').toString()).toBe('hi');
  });
});

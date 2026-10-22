import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

describe('toolchain smoke test', () => {
  it('syncs two in-memory Y.Docs', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText('t').insert(0, 'hello');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(b.getText('t').toString()).toBe('hello');
  });
});

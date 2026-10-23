import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  compose,
  type Delta,
  diffText,
  fromEdits,
  fromYDelta,
  toEdits,
  transform,
} from '../src/sync/delta';
import { rng } from './helpers/random';

/** Random delta valid for `text`, never splitting surrogate pairs. */
function randomDelta(r: ReturnType<typeof rng>, text: string): Delta {
  const edits = [];
  let cursor = 0;
  while (cursor < text.length && r.next() < 0.6) {
    let offset = cursor + r.int(text.length - cursor + 1);
    let end = Math.min(text.length, offset + r.int(4));
    if (offset > 0 && /[\udc00-\udfff]/.test(text[offset] ?? '')) offset--;
    if (end > offset && /[\udc00-\udfff]/.test(text[end] ?? '')) end++;
    end = Math.max(end, offset);
    edits.push({ offset, length: end - offset, text: r.str(3) });
    cursor = end + 1;
  }
  return fromEdits(edits);
}

describe('delta', () => {
  it('builds from multi-cursor edits regardless of order', () => {
    const text = 'aaa bbb ccc';
    const edits = [
      { offset: 8, length: 3, text: 'C' },
      { offset: 0, length: 3, text: 'A' },
      { offset: 4, length: 0, text: '>' },
    ];
    expect(applyDelta(text, fromEdits(edits))).toBe('A >bbb C');
    expect(toEdits(fromEdits(edits))).toEqual([...edits].sort((x, y) => x.offset - y.offset));
  });

  it('accepts an insertion and a deletion at the same offset in any order', () => {
    const edits = [
      { offset: 2, length: 1, text: '' },
      { offset: 2, length: 0, text: '\n' },
    ];
    expect(applyDelta('abcd', fromEdits(edits))).toBe('ab\nd');
    expect(applyDelta('abcd', fromEdits([...edits].reverse()))).toBe('ab\nd');
  });

  it('rejects overlapping edits', () => {
    expect(() => fromEdits([{ offset: 0, length: 3, text: '' }, { offset: 2, length: 1, text: '' }])).toThrow();
  });

  it('converts Y deltas', () => {
    expect(fromYDelta([{ retain: 2 }, { delete: 1 }, { insert: 'x' }])).toEqual([{ retain: 2 }, { insert: 'x' }, { delete: 1 }]);
  });

  it('diffs with a single minimal replace and keeps surrogate pairs whole', () => {
    expect(toEdits(diffText('hello world', 'hello brave world'))).toEqual([{ offset: 6, length: 0, text: 'brave ' }]);
    expect(diffText('same', 'same')).toEqual([]);
    const a = 'x😀y';
    const b = 'x😃y';
    expect(applyDelta(a, diffText(a, b))).toBe(b);
    expect(toEdits(diffText(a, b))[0]).toEqual({ offset: 1, length: 2, text: '😃' });
  });

  it('satisfies compose and transform properties (random)', () => {
    const r = rng(42);
    for (let i = 0; i < 3000; i++) {
      const s = r.str(12);
      const a = randomDelta(r, s);
      const b = randomDelta(r, s);
      const c = randomDelta(r, applyDelta(s, a));
      expect(applyDelta(s, compose(a, c))).toBe(applyDelta(applyDelta(s, a), c));
      const p = r.next() < 0.5;
      const left = applyDelta(applyDelta(s, a), transform(a, b, p));
      const right = applyDelta(applyDelta(s, b), transform(b, a, !p));
      expect(left).toBe(right);
      expect(applyDelta(s, diffText(s, left))).toBe(left);
    }
  });
});

describe('index mapping', () => {
  it('maps positions through a delta and back', async () => {
    const { transformIndex, transformIndexBack } = await import('../src/sync/delta');
    const d = fromEdits([
      { offset: 0, length: 0, text: '>> ' },
      { offset: 6, length: 5, text: 'there' },
    ]); // ">> hello there"
    expect(transformIndex(d, 0)).toBe(3);
    expect(transformIndex(d, 4)).toBe(7);
    expect(transformIndex(d, 8)).toBe(14); // inside the replaced word: end of replacement
    expect(transformIndex(d, 11)).toBe(14);
    expect(transformIndexBack(d, 1)).toBe(0); // inside inserted ">> "
    expect(transformIndexBack(d, 7)).toBe(4);
    expect(transformIndexBack(d, 14)).toBe(11);
    // Characters that survive map to the same character.
    const r = rng(9);
    for (let i = 0; i < 500; i++) {
      const s = r.str(10);
      const delta = randomDelta(r, s);
      const after = applyDelta(s, delta);
      const deleted = new Set<number>();
      for (const e of toEdits(delta)) for (let k = e.offset; k < e.offset + e.length; k++) deleted.add(k);
      let previous = 0;
      for (let k = 0; k <= s.length; k++) {
        const j = transformIndex(delta, k);
        expect(j).toBeGreaterThanOrEqual(previous); // monotonic
        expect(j).toBeLessThanOrEqual(after.length);
        previous = j;
        if (k < s.length && !deleted.has(k)) {
          expect(after[j]).toBe(s[k]);
          expect(transformIndexBack(delta, j)).toBe(k);
        }
      }
    }
  });
});

import { describe, expect, it } from 'vitest';
import { LineIndex, NormalizedDocument, normalizeChange, toEol, type DocChange } from '../src/sync/document';
import { FakeRawDocument } from './helpers/FakeRawDocument';

describe('EOL handling', () => {
  it('converts between LF and CRLF', () => {
    expect(toEol('a\nb\r\nc', '\r\n')).toBe('a\r\nb\r\nc');
    expect(toEol('a\r\nb', '\n')).toBe('a\nb');
  });

  it('maps raw CRLF change offsets to normalized offsets', () => {
    // "ab\r\ncd\r\nef": replace "d\r\ne" (raw 5..9) with "X\r\nY"
    expect(normalizeChange({ rangeOffset: 5, rangeLength: 4, startLine: 1, endLine: 2, text: 'X\r\nY' }, '\r\n')).toEqual({
      offset: 4,
      length: 3,
      text: 'X\nY',
    });
  });

  it('computes positions on normalized text', () => {
    const idx = new LineIndex('ab\ncd\n\nef');
    expect(idx.positionAt(0)).toEqual({ line: 0, character: 0 });
    expect(idx.positionAt(3)).toEqual({ line: 1, character: 0 });
    expect(idx.positionAt(6)).toEqual({ line: 2, character: 0 });
    expect(idx.positionAt(9)).toEqual({ line: 3, character: 2 });
  });

  it('round-trips edits and events through a CRLF document', async () => {
    const raw = new FakeRawDocument('line1\nline2\nline3', '\r\n');
    const doc = new NormalizedDocument(raw);
    const seen: DocChange[][] = [];
    doc.onDidChange((c) => seen.push([...c]));

    expect(doc.getText()).toBe('line1\nline2\nline3');
    // Normalized offset 12 is the start of "line3".
    expect(await doc.applyEdits([{ offset: 12, length: 0, text: 'new\n' }])).toBe(true);
    expect(raw.getText()).toBe('line1\r\nline2\r\nnew\r\nline3');
    expect(seen[0]).toEqual([{ offset: 12, length: 0, text: 'new\n' }]);

    raw.userEdit([{ offset: 7, length: 7, text: '' }]); // delete "line2\r\n"
    expect(seen[1]).toEqual([{ offset: 6, length: 6, text: '' }]);
    expect(doc.getText()).toBe('line1\nnew\nline3');
  });
});

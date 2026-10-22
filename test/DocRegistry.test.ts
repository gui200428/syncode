import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DocRegistry, normalizeDocPath } from '../src/sync/DocRegistry';
import { EditorBinding } from '../src/sync/EditorBinding';
import { NormalizedDocument } from '../src/sync/document';
import { FakeRawDocument } from './helpers/FakeRawDocument';
import { settle } from './helpers/peers';

describe('DocRegistry', () => {
  it('normalizes paths', () => {
    expect(normalizeDocPath('./src\\a//b.ts')).toBe('src/a/b.ts');
    expect(normalizeDocPath('/x.ts')).toBe('x.ts');
  });

  it('creates on demand, seeds once and reference counts', () => {
    const reg = new DocRegistry();
    const added: string[] = [];
    const removed: string[] = [];
    reg.onDidAdd((e) => added.push(e.path));
    reg.onDidRemove((e) => removed.push(e.path));

    let calls = 0;
    const a = reg.acquire('src/a.ts', () => (calls++, 'one\r\ntwo'));
    const b = reg.acquire('./src/a.ts', () => (calls++, 'ignored'));
    expect(a).toBe(b);
    expect(calls).toBe(1);
    expect(a.text.toString()).toBe('one\ntwo'); // EOL normalized
    expect(added).toEqual(['src/a.ts']);

    reg.release('src/a.ts');
    expect(reg.get('src/a.ts')).toBeDefined();
    reg.release('src/a.ts');
    expect(reg.get('src/a.ts')).toBeUndefined();
    expect(removed).toEqual(['src/a.ts']);
    reg.dispose();
  });

  it('exposes one session awareness', () => {
    const reg = new DocRegistry();
    reg.awareness.setLocalStateField('name', 'Ana');
    expect(reg.awareness.getLocalState()).toMatchObject({ name: 'Ana' });
    reg.dispose();
  });

  it('applies external disk changes as a minimal diff that reaches the editor', async () => {
    const reg = new DocRegistry();
    const entry = reg.acquire('f.txt', () => 'alpha\nbeta\ngamma');
    // A remote cursor anchored in "gamma" must survive an edit in "alpha".
    const anchor = Y.createRelativePositionFromTypeIndex(entry.text, 13);
    const raw = new FakeRawDocument('alpha\nbeta\ngamma');
    const binding = new EditorBinding(entry.text, new NormalizedDocument(raw));

    expect(reg.applyExternalText('f.txt', 'ALPHA\r\nbeta\r\ngamma')).toBe(true);
    expect(reg.applyExternalText('f.txt', 'ALPHA\nbeta\ngamma')).toBe(false);
    const abs = Y.createAbsolutePositionFromRelativePosition(anchor, entry.doc);
    expect(abs?.index).toBe(13);

    await settle([{ raw, binding } as never]);
    expect(raw.getText()).toBe('ALPHA\nbeta\ngamma');
    binding.dispose();
    reg.dispose();
  });
});

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createPair, settle } from './helpers/peers';

describe('local undo with Y.UndoManager', () => {
  it('undoes only this editor\'s edits, even after remote edits around them', async () => {
    const { host, guest, link } = await createPair('let a = 1;\n');
    const undo = new Y.UndoManager(guest.binding.ytext, { trackedOrigins: new Set([guest.binding]), captureTimeout: 0 });

    guest.raw.userEdit([{ offset: 11, length: 0, text: 'let g = 2;\n' }]);
    await settle([host, guest], link);
    host.raw.userEdit([{ offset: 0, length: 0, text: '// host\n' }]);
    host.raw.userEdit([{ offset: host.text().length, length: 0, text: 'let h = 3;\n' }]);
    await settle([host, guest], link);
    expect(guest.text()).toBe('// host\nlet a = 1;\nlet g = 2;\nlet h = 3;\n');

    undo.undo();
    await settle([host, guest], link);
    expect(host.text()).toBe('// host\nlet a = 1;\nlet h = 3;\n');
    expect(guest.text()).toBe(host.text());

    undo.redo();
    await settle([host, guest], link);
    expect(host.text()).toBe('// host\nlet a = 1;\nlet g = 2;\nlet h = 3;\n');
    expect(guest.binding.isConsistent()).toBe(true);
    expect(host.binding.isConsistent()).toBe(true);
  });
});

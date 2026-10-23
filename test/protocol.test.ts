import { describe, expect, it } from 'vitest';
import { decodeFrame, decodeJson, encodeFrame, jsonFrame, MsgType, ProtocolError } from '../src/protocol';

describe('protocol', () => {
  it('round-trips frames', () => {
    const payload = new Uint8Array([1, 2, 3, 255]);
    expect(decodeFrame(encodeFrame(MsgType.Sync, 'src/ç.ts', payload))).toEqual({
      type: MsgType.Sync,
      docId: 'src/ç.ts',
      payload,
    });
    const f = decodeFrame(jsonFrame(MsgType.Request, { id: 1, method: 'open' }));
    expect(decodeJson(f.payload)).toEqual({ id: 1, method: 'open' });
  });

  it('rejects malformed frames', () => {
    expect(() => decodeFrame(new Uint8Array([99, 0, 0]))).toThrow(ProtocolError);
    expect(() => decodeFrame(new Uint8Array([3, 5]))).toThrow(ProtocolError);
    expect(() => decodeFrame(new Uint8Array([...encodeFrame(MsgType.Sync, '', new Uint8Array()), 7]))).toThrow(ProtocolError);
    expect(() => decodeJson(new Uint8Array([0xff]))).toThrow(ProtocolError);
  });
});

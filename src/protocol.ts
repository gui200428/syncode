/**
 * Wire protocol. Every WebSocket message is one binary frame:
 *
 *   varUint type | varString docId | varUint8Array payload
 *
 * Sync and Awareness payloads are y-protocols messages; the other types carry
 * UTF-8 JSON. docId is the workspace-relative path ('' for session-level frames).
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

export const PROTOCOL_VERSION = 3;

/** Max size of a single frame; files are limited to a few MB of text. */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export enum MsgType {
  /** guest → host, first frame: HelloPayload */
  Hello = 0,
  /** host → guest after a valid Hello: WelcomePayload */
  Welcome = 1,
  /** host → guest, then the connection is closed: RejectPayload */
  Reject = 2,
  /** y-protocols sync message for the Y.Doc of docId */
  Sync = 3,
  /** y-protocols awareness update (session-wide) */
  Awareness = 4,
  /** RequestPayload, answered by a Response with the same id */
  Request = 5,
  Response = 6,
  /** NotifyPayload, host → guests */
  Notify = 7,
}

export interface Frame {
  type: MsgType;
  docId: string;
  payload: Uint8Array;
}

export interface HelloPayload {
  protocol: number;
  pin: string;
  name: string;
  color: string;
}

export interface WelcomePayload {
  protocol: number;
  sessionId: string;
  hostName: string;
  /** Name of the shared folder, for display. */
  rootName: string;
}

export type RejectCode = 'pin' | 'blocked' | 'version' | 'timeout' | 'protocol';

export interface RejectPayload {
  code: RejectCode;
  message: string;
  attemptsLeft?: number;
}

export type FileKind = 'file' | 'directory';

export interface FileStatResult {
  kind: FileKind;
  size: number;
  mtime: number;
  ctime: number;
  /** Text file within the size limit: edited live. Otherwise read-only. */
  syncable: boolean;
}

export interface RequestMap {
  /**
   * Start syncing a file; the guest then exchanges SyncStep1/2 for the returned
   * canonical path. `epoch` (the host Y.Doc guid) changes if the host recreated
   * the document, in which case old guest state must not be merged into it.
   */
  open: { params: { path: string }; result: { path: string; epoch: string } };
  close: { params: { path: string }; result: Record<string, never> };
  /** Ask the host to write the file to disk. */
  save: { params: { path: string }; result: Record<string, never> };
  stat: { params: { path: string }; result: FileStatResult };
  /** Directory entries as [name, kind]. */
  list: { params: { path: string }; result: { entries: Array<[string, FileKind]> } };
  /** Raw content (base64) of a file as saved on disk (any file up to 16 MB). */
  read: { params: { path: string }; result: { base64: string } };
  /**
   * Every shared file and folder below `path` ('' = root), for guests that
   * mirror the folder to disk. Excluded paths are left out.
   */
  tree: { params: { path: string }; result: TreeResult };
}

export interface TreeFile {
  path: string;
  size: number;
  mtime: number;
}

export interface TreeResult {
  files: TreeFile[];
  /** Folders, parents before children (empty ones included). */
  dirs: string[];
}

export type RequestMethod = keyof RequestMap;

export interface RequestPayload {
  id: number;
  method: RequestMethod;
  params: unknown;
}

export interface ResponsePayload {
  id: number;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface FsChange {
  path: string;
  type: 'created' | 'changed' | 'deleted';
}

export type NotifyPayload = { event: 'saved'; path: string } | { event: 'fs'; changes: FsChange[] };

export function encodeFrame(type: MsgType, docId: string, payload: Uint8Array): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, type);
  encoding.writeVarString(e, docId);
  encoding.writeVarUint8Array(e, payload);
  return encoding.toUint8Array(e);
}

export class ProtocolError extends Error {}

export function decodeFrame(data: Uint8Array): Frame {
  try {
    const d = decoding.createDecoder(data);
    const type = decoding.readVarUint(d);
    if (!(type in MsgType)) throw new ProtocolError(`unknown message type ${type}`);
    const docId = decoding.readVarString(d);
    const payload = decoding.readVarUint8Array(d);
    if (decoding.hasContent(d)) throw new ProtocolError('trailing bytes in frame');
    return { type, docId, payload };
  } catch (err) {
    if (err instanceof ProtocolError) throw err;
    throw new ProtocolError(`malformed frame: ${String(err)}`);
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function encodeJson(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

export function decodeJson<T>(payload: Uint8Array): T {
  try {
    return JSON.parse(textDecoder.decode(payload)) as T;
  } catch (err) {
    throw new ProtocolError(`invalid JSON payload: ${String(err)}`);
  }
}

export function jsonFrame(type: MsgType, value: unknown, docId = ''): Uint8Array {
  return encodeFrame(type, docId, encodeJson(value));
}

/** Error with a machine-readable code, carried in Response.error. */
export class RemoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

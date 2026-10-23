import * as os from 'node:os';
import * as vscode from 'vscode';

const PALETTE = ['#e06c75', '#61afef', '#98c379', '#c678dd', '#e5c07b', '#56b6c2', '#d19a66', '#ff79c6'];

export interface LanPairConfig {
  displayName: string;
  color: string;
  port: number;
  exclude: string[];
  maxFileBytes: number;
}

function defaultName(): string {
  try {
    return os.userInfo().username || os.hostname();
  } catch {
    return os.hostname();
  }
}

function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function readConfig(): LanPairConfig {
  const c = vscode.workspace.getConfiguration('lanpair');
  const displayName = c.get<string>('displayName')?.trim() || defaultName();
  return {
    displayName,
    color: c.get<string>('color')?.trim() || colorFor(displayName),
    port: Math.max(0, Math.min(65535, c.get<number>('port') ?? 0)),
    exclude: c.get<string[]>('exclude') ?? [],
    maxFileBytes: Math.max(1, c.get<number>('maxFileSizeKB') ?? 2048) * 1024,
  };
}

/** Non-internal IPv4 addresses, for display in join info. */
export function lanAddresses(): string[] {
  const result: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) result.push(a.address);
  }
  return result;
}

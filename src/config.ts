import * as os from 'node:os';
import * as vscode from 'vscode';

export const PALETTE: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'Red', color: '#e06c75' },
  { name: 'Blue', color: '#61afef' },
  { name: 'Green', color: '#98c379' },
  { name: 'Purple', color: '#c678dd' },
  { name: 'Yellow', color: '#e5c07b' },
  { name: 'Cyan', color: '#56b6c2' },
  { name: 'Orange', color: '#d19a66' },
  { name: 'Pink', color: '#ff79c6' },
];

export interface SynCodeConfig {
  displayName: string;
  /** True when syncode.color is set explicitly. */
  colorConfigured: boolean;
  nameLabels: 'always' | 'whileMoving' | 'never';
  color: string;
  port: number;
  exclude: string[];
  respectGitignore: boolean;
  advertise: boolean;
  localUndo: boolean;
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
  return PALETTE[h % PALETTE.length]!.color;
}

export function readConfig(): SynCodeConfig {
  const c = vscode.workspace.getConfiguration('syncode');
  const displayName = c.get<string>('displayName')?.trim() || defaultName();
  return {
    displayName,
    color: c.get<string>('color')?.trim() || colorFor(displayName),
    colorConfigured: !!c.get<string>('color')?.trim(),
    nameLabels: c.get<SynCodeConfig['nameLabels']>('nameLabels') ?? 'always',
    port: Math.max(0, Math.min(65535, c.get<number>('port') ?? 0)),
    exclude: c.get<string[]>('exclude') ?? [],
    respectGitignore: c.get<boolean>('respectGitignore') ?? true,
    advertise: c.get<boolean>('advertise') ?? true,
    localUndo: c.get<boolean>('localUndo') ?? true,
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

/**
 * Asks for the name (prefilled) and, if never chosen, the color others will
 * see. Saves both to the user settings. Returns undefined if cancelled.
 */
export async function askIdentity(options: { forceColor?: boolean } = {}): Promise<{ name: string; color: string } | undefined> {
  const config = readConfig();
  const name = await vscode.window.showInputBox({
    title: 'SynCode: your name in the session',
    prompt: 'Shown next to your cursor for the other participants',
    value: config.displayName,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? 'Enter a name' : v.trim().length > 32 ? 'Use at most 32 characters' : undefined),
  });
  if (name === undefined) return undefined;
  const settings = vscode.workspace.getConfiguration('syncode');
  if (name.trim() !== config.displayName) await settings.update('displayName', name.trim(), vscode.ConfigurationTarget.Global);

  let color = config.colorConfigured ? config.color : colorFor(name.trim());
  if (!config.colorConfigured || options.forceColor) {
    const pick = await vscode.window.showQuickPick(
      PALETTE.map((p) => ({ label: p.name, description: p.color, picked: p.color === color, color: p.color })),
      { title: 'SynCode: your cursor color', placeHolder: `Current: ${color}`, ignoreFocusOut: true },
    );
    if (pick) {
      color = pick.color;
      await settings.update('color', color, vscode.ConfigurationTarget.Global);
    }
  }
  return { name: name.trim(), color };
}

import * as vscode from 'vscode';

const MAX_RECENT = 500;

/** "LanPair" output channel that also keeps recent lines for diagnostics and tests. */
export class Logger implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('LanPair');
  private readonly recent: string[] = [];

  appendLine(line: string): void {
    this.channel.appendLine(line);
    this.recent.push(line);
    if (this.recent.length > MAX_RECENT) this.recent.shift();
  }

  recentLines(): readonly string[] {
    return this.recent;
  }

  dispose(): void {
    this.channel.dispose();
  }
}

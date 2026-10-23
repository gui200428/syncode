import * as vscode from 'vscode';

export type StatusState =
  | { kind: 'idle' }
  | { kind: 'hosting'; pin: string; guests: number }
  | { kind: 'guest'; hostName: string; rootName: string };

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  constructor() {
    this.update({ kind: 'idle' });
    this.item.show();
  }

  update(state: StatusState): void {
    switch (state.kind) {
      case 'idle':
        this.item.text = '$(broadcast) LanPair';
        this.item.tooltip = 'LanPair: start hosting or join a session';
        this.item.command = 'lanpair.showMenu';
        break;
      case 'hosting': {
        const guests = state.guests === 1 ? '1 guest' : `${state.guests} guests`;
        this.item.text = `$(broadcast) LanPair: hosting (PIN ${state.pin}) · ${guests}`;
        this.item.tooltip = 'Click for join info or to stop the session';
        this.item.command = 'lanpair.showMenu';
        break;
      }
      case 'guest':
        this.item.text = `$(plug) LanPair: ${state.hostName} · ${state.rootName}`;
        this.item.tooltip = 'Click to open a file or leave the session';
        this.item.command = 'lanpair.showMenu';
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

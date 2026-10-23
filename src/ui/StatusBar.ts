import * as vscode from 'vscode';

export type StatusState =
  | { kind: 'idle' }
  | { kind: 'hosting'; pin: string; guests: number; following?: string }
  | { kind: 'guest'; hostName: string; rootName: string; following?: string }
  | { kind: 'connecting'; address: string };

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
        this.item.text = `$(broadcast) LanPair: hosting (PIN ${state.pin}) · ${guests}${state.following ? ` · following ${state.following}` : ''}`;
        this.item.tooltip = 'Click for join info or to stop the session';
        this.item.command = 'lanpair.showMenu';
        break;
      }
      case 'guest':
        this.item.text = `$(plug) LanPair: ${state.hostName} · ${state.rootName}${state.following ? ` · following ${state.following}` : ''}`;
        this.item.tooltip = 'Click to follow a participant or leave the session';
        this.item.command = 'lanpair.showMenu';
        break;
      case 'connecting':
        this.item.text = `$(sync~spin) LanPair: connecting to ${state.address}…`;
        this.item.tooltip = 'LanPair is connecting to the host';
        this.item.command = 'lanpair.showMenu';
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

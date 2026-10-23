import * as vscode from 'vscode';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { LineIndex, normalizeEol } from './document';
import type { EditorBinding } from './EditorBinding';

const PUBLISH_THROTTLE_MS = 50;
const RENDER_THROTTLE_MS = 50;
const LABEL_VISIBLE_MS = 3000;

/** Maps editor documents to shared docIds; implemented by the host and the guest side. */
export interface DocLocator {
  /** docId of a document in the shared folder, even if no guest has it open. */
  docIdFor(document: vscode.TextDocument): string | undefined;
  /** Binding of a document whose content is currently shared. */
  bindingFor(document: vscode.TextDocument): EditorBinding | undefined;
  uriFor(docId: string): vscode.Uri;
}

export interface UserInfo {
  name: string;
  color: string;
}

interface SelectionState {
  anchor: unknown; // Y.RelativePosition as JSON
  head: unknown;
}

export interface PresenceState {
  user: UserInfo;
  /** docId of the active editor, or null. */
  file: string | null;
  selections: SelectionState[];
}

export interface Participant {
  clientId: number;
  user: UserInfo;
  file: string | null;
}

function isPresence(value: unknown): value is PresenceState {
  const v = value as PresenceState;
  return typeof v === 'object' && v !== null && typeof v.user?.name === 'string' && typeof v.user?.color === 'string';
}

/** #rgb / #rrggbb only, so we can derive a translucent selection color safely. */
export function safeColor(color: string, fallback = '#61afef'): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : fallback;
}

interface Styles {
  cursor: vscode.TextEditorDecorationType;
  selection: vscode.TextEditorDecorationType;
  label: vscode.TextEditorDecorationType;
}

/**
 * Presence: publishes this editor's active file and selections to the session
 * Awareness (positions as Y.RelativePosition, so they survive concurrent
 * edits) and renders everyone else's cursors, selections and names.
 * Also implements Follow Participant.
 */
export class RemoteCursors implements vscode.Disposable {
  private readonly styles = new Map<string, Styles>();
  /** Editors that currently show decorations, to clear them later. */
  private readonly decorated = new Set<vscode.TextEditor>();
  private readonly lastMove = new Map<number, number>();
  private readonly lastHeads = new Map<number, string>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private labelTimer: ReturnType<typeof setTimeout> | undefined;
  private following: number | undefined;
  private readonly followListeners = new Set<(p: Participant | undefined) => void>();
  private disposed = false;

  constructor(
    private readonly awareness: Awareness,
    private readonly locator: DocLocator,
    private readonly user: UserInfo,
  ) {
    awareness.on('change', this.onAwarenessChange);
    this.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        this.schedulePublish();
        // Moving your own cursor (keyboard/mouse) stops following.
        if (this.following !== undefined && e.kind !== undefined && e.kind !== vscode.TextEditorSelectionChangeKind.Command) {
          this.follow(undefined);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedulePublish()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleRender()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) this.scheduleRender();
      }),
    );
    this.publish();
  }

  /** Call when a document became shared (or stopped being shared). */
  refresh(): void {
    this.schedulePublish();
    this.scheduleRender();
  }

  participants(): Participant[] {
    const result: Participant[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.awareness.clientID || !isPresence(state)) continue;
      result.push({ clientId, user: state.user, file: state.file });
    }
    return result;
  }

  /** Remote cursor heads in visible editors (what render() draws); for diagnostics and tests. */
  remoteHeads(): Array<{ name: string; uri: string; line: number; character: number }> {
    const result: Array<{ name: string; uri: string; line: number; character: number }> = [];
    for (const editor of vscode.window.visibleTextEditors) {
      const binding = this.locator.bindingFor(editor.document);
      const docId = this.locator.docIdFor(editor.document);
      if (!binding || !docId) continue;
      const lines = new LineIndex(normalizeEol(editor.document.getText()));
      for (const [id, state] of this.awareness.getStates()) {
        if (id === this.awareness.clientID || !isPresence(state) || state.file !== docId) continue;
        const head = state.selections[0]?.head;
        if (head === undefined) continue;
        const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(head), binding.ytext.doc!);
        if (!abs || abs.type !== binding.ytext) continue;
        const p = lines.positionAt(binding.toDocOffset(abs.index));
        result.push({ name: state.user.name, uri: editor.document.uri.toString(), line: p.line, character: p.character });
      }
    }
    return result;
  }

  get followed(): Participant | undefined {
    return this.participants().find((p) => p.clientId === this.following);
  }

  follow(clientId: number | undefined): void {
    this.following = clientId;
    for (const l of this.followListeners) l(this.followed);
    if (clientId !== undefined) void this.revealFollowed();
  }

  onDidChangeFollow(listener: (p: Participant | undefined) => void): vscode.Disposable {
    this.followListeners.add(listener);
    return new vscode.Disposable(() => this.followListeners.delete(listener));
  }

  dispose(): void {
    this.disposed = true;
    this.awareness.off('change', this.onAwarenessChange);
    for (const t of [this.publishTimer, this.renderTimer, this.labelTimer]) if (t) clearTimeout(t);
    for (const s of this.subscriptions.splice(0)) s.dispose();
    for (const s of this.styles.values()) for (const d of Object.values(s)) d.dispose();
    this.styles.clear();
    this.awareness.setLocalState(null);
  }

  private readonly onAwarenessChange = (changes: { added: number[]; updated: number[]; removed: number[] }): void => {
    for (const id of [...changes.added, ...changes.updated]) {
      if (id === this.awareness.clientID) continue;
      const state = this.awareness.getStates().get(id) as PresenceState | undefined;
      const key = JSON.stringify([state?.file, state?.selections?.[0]?.head]);
      if (this.lastHeads.get(id) !== key) {
        this.lastHeads.set(id, key);
        this.lastMove.set(id, Date.now());
      }
    }
    if (this.following !== undefined && changes.removed.includes(this.following)) this.follow(undefined);
    this.scheduleRender();
    if (this.following !== undefined && [...changes.added, ...changes.updated].includes(this.following)) {
      void this.revealFollowed();
    }
  };

  private schedulePublish(): void {
    if (this.publishTimer || this.disposed) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      this.publish();
    }, PUBLISH_THROTTLE_MS);
  }

  private publish(): void {
    if (this.disposed) return;
    const editor = vscode.window.activeTextEditor;
    const document = editor?.document;
    const file = document ? (this.locator.docIdFor(document) ?? null) : null;
    const binding = document ? this.locator.bindingFor(document) : undefined;
    const selections: SelectionState[] = [];
    if (editor && binding) {
      const toRel = (pos: vscode.Position) => {
        const raw = editor.document.offsetAt(pos);
        const normalized = editor.document.eol === vscode.EndOfLine.CRLF ? raw - pos.line : raw;
        const rel = Y.createRelativePositionFromTypeIndex(binding.ytext, binding.toYIndex(normalized));
        return Y.relativePositionToJSON(rel);
      };
      for (const sel of editor.selections) selections.push({ anchor: toRel(sel.anchor), head: toRel(sel.active) });
    }
    const state: PresenceState = { user: this.user, file, selections };
    this.awareness.setLocalState(state);
  }

  private scheduleRender(): void {
    if (this.renderTimer || this.disposed) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, RENDER_THROTTLE_MS);
  }

  private stylesFor(color: string): Styles {
    let s = this.styles.get(color);
    if (!s) {
      s = {
        cursor: vscode.window.createTextEditorDecorationType({
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
          overviewRulerColor: color,
          overviewRulerLane: vscode.OverviewRulerLane.Center,
          before: {
            contentText: '',
            textDecoration: `none; position: absolute; height: 1.2em; border-left: 2px solid ${color}; margin-left: -1px;`,
          },
        }),
        selection: vscode.window.createTextEditorDecorationType({
          backgroundColor: `${color}40`,
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        }),
        label: vscode.window.createTextEditorDecorationType({
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
          after: {
            backgroundColor: color,
            color: '#ffffff',
            margin: '0 0 0 2px',
            textDecoration: 'none; font-size: 0.85em; padding: 0 3px; border-radius: 2px;',
          },
        }),
      };
      this.styles.set(color, s);
    }
    return s;
  }

  private render(): void {
    if (this.disposed) return;
    const states = [...this.awareness.getStates()].filter(
      ([id, st]) => id !== this.awareness.clientID && isPresence(st) && st.file,
    ) as Array<[number, PresenceState]>;
    const now = Date.now();
    let nextLabelExpiry = Infinity;
    const stillDecorated = new Set<vscode.TextEditor>();

    for (const editor of vscode.window.visibleTextEditors) {
      const binding = this.locator.bindingFor(editor.document);
      const docId = this.locator.docIdFor(editor.document);
      const perStyle = new Map<Styles, { cursor: vscode.DecorationOptions[]; selection: vscode.Range[]; label: vscode.DecorationOptions[] }>();
      if (binding && docId) {
        const ydoc = binding.ytext.doc!;
        let lines: LineIndex | undefined;
        const toPosition = (relJson: unknown): vscode.Position | undefined => {
          const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(relJson), ydoc);
          if (!abs || abs.type !== binding.ytext) return undefined;
          lines ??= new LineIndex(normalizeEol(editor.document.getText()));
          const p = lines.positionAt(binding.toDocOffset(abs.index));
          return editor.document.validatePosition(new vscode.Position(p.line, p.character));
        };
        for (const [clientId, state] of states) {
          if (state.file !== docId) continue;
          const style = this.stylesFor(safeColor(state.user.color));
          let bucket = perStyle.get(style);
          if (!bucket) perStyle.set(style, (bucket = { cursor: [], selection: [], label: [] }));
          const labelUntil = (this.lastMove.get(clientId) ?? 0) + LABEL_VISIBLE_MS;
          state.selections.forEach((sel, i) => {
            const head = toPosition(sel.head);
            const anchor = toPosition(sel.anchor);
            if (!head) return;
            const hover = new vscode.MarkdownString(`**${state.user.name}**`);
            bucket.cursor.push({ range: new vscode.Range(head, head), hoverMessage: hover });
            if (anchor && !anchor.isEqual(head)) bucket.selection.push(new vscode.Range(anchor, head));
            if (i === 0 && labelUntil > now) {
              nextLabelExpiry = Math.min(nextLabelExpiry, labelUntil);
              bucket.label.push({
                range: new vscode.Range(head, head),
                renderOptions: { after: { contentText: state.user.name } },
              });
            }
          });
        }
      }
      if (perStyle.size === 0 && !this.decorated.has(editor)) continue;
      for (const style of this.styles.values()) {
        const bucket = perStyle.get(style);
        editor.setDecorations(style.cursor, bucket?.cursor ?? []);
        editor.setDecorations(style.selection, bucket?.selection ?? []);
        editor.setDecorations(style.label, bucket?.label ?? []);
      }
      if (perStyle.size > 0) stillDecorated.add(editor);
    }
    this.decorated.clear();
    for (const e of stillDecorated) this.decorated.add(e);

    if (this.labelTimer) clearTimeout(this.labelTimer);
    this.labelTimer =
      nextLabelExpiry < Infinity ? setTimeout(() => this.scheduleRender(), nextLabelExpiry - now + 10) : undefined;
  }

  private async revealFollowed(): Promise<void> {
    const id = this.following;
    if (id === undefined) return;
    const state = this.awareness.getStates().get(id);
    if (!isPresence(state) || !state.file) return;
    const uri = this.locator.uriFor(state.file);
    let editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    try {
      if (!editor || vscode.window.activeTextEditor !== editor) {
        editor = await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: false, viewColumn: editor?.viewColumn });
      }
    } catch {
      return; // e.g. file not readable for us
    }
    const binding = this.locator.bindingFor(editor.document);
    const head = state.selections[0]?.head;
    if (!binding || head === undefined || this.following !== id) return;
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(head), binding.ytext.doc!);
    if (!abs || abs.type !== binding.ytext) return;
    const p = new LineIndex(normalizeEol(editor.document.getText())).positionAt(binding.toDocOffset(abs.index));
    const pos = editor.document.validatePosition(new vscode.Position(p.line, p.character));
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

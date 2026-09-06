/**
 * Projector HUD: chore bar, tool palette, ledger, Gauntlet grid, receipts.
 * Plain DOM, no framework — everything re-renders from RoomState.
 */

import QRCode from 'qrcode';
import type { AssetManifest, Gauntlet, RoomState, Task } from '../sim/types';

export type Tool = 'select' | 'item' | 'zone' | 'drawer' | 'door' | 'robot';

export interface HudCallbacks {
  onSubmitChore(text: string): void;
  onToolChange(tool: Tool): void;
  onRemoveEntity(id: string): void;
  onSelectEntity(id: string | null): void;
  onRunGauntlet(count: number): void;
  onReplayVariant(gauntletId: string, variantId: string): void;
  onReset(): void;
  onAbort(): void;
  onToggleFollow(on: boolean): void;
  onToggleLabels(on: boolean): void;
}

export interface HudOptions {
  mode: 'local' | 'convex';
  ledgerUrl: string;
  manifest: AssetManifest | null;
}

export interface ItemDraft {
  name: string;
  shape: string;
  color: string;
}

const SHAPES = ['mug', 'bottle', 'book', 'plant', 'ball', 'can', 'box', 'crate'];
const EXAMPLES = [
  'put the red mug on the shelf',
  'put the blue bottle in the top drawer, then close it',
  'bring me the green book',
  'open the top drawer',
  'tidy the room',
];

/** Pick the task the room should be looking at: running first, then the oldest queued, then the latest finished. */
export function currentTask(tasks: Task[]): Task | undefined {
  const byNewest = [...tasks].sort((a, b) => b.createdAt - a.createdAt);
  return (
    byNewest.find((t) => t.status === 'running' || t.status === 'planning') ??
    [...tasks].filter((t) => t.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0] ??
    byNewest[0]
  );
}

export class Hud {
  private root: HTMLElement;
  private tool: Tool = 'select';
  private selectedId: string | null = null;
  private lastState: RoomState | null = null;
  private gridInfo = '';
  private statusEl!: HTMLElement;
  private resetArmedTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(parent: HTMLElement, private cb: HudCallbacks, private opts: HudOptions) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = this.template();
    parent.appendChild(this.root);
    this.statusEl = this.q('#status');
    this.wire();
    if (opts.mode === 'convex') void this.renderQr();
    if (new URLSearchParams(location.search).get('stage') === '1') this.setStage(true);
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string): T {
    return this.root.querySelector(sel) as T;
  }

  private template(): string {
    const live = this.opts.mode === 'convex';
    const modeLabel = live ? 'Convex · live' : 'Local · offline';
    return `
    <header class="brand">
      <div class="brand-row">
        <span class="brand-name">Dry Run</span>
        <span class="badge ${this.opts.mode}">${modeLabel}</span>
      </div>
      <div class="brand-sub">Rehearse the robot's chore in a twin of the real room before it touches anything.</div>
      <div class="brand-world" id="worldline"></div>
    </header>

    <div id="status" class="status" hidden><span class="pulse"></span><span id="status-text"></span></div>
    <div id="toast" class="toast" hidden></div>

    <aside class="panel left">
      <section class="tools">
        <div class="section-title">Tools <span class="hint">click in the room</span></div>
        <div class="seg" id="tools">
          <button data-tool="select" class="on">Select</button>
          <button data-tool="item">+ Item</button>
          <button data-tool="zone">+ Zone</button>
          <button data-tool="drawer">+ Drawer</button>
          <button data-tool="door">+ Door</button>
          <button data-tool="robot">Robot start</button>
        </div>
        <div class="draft" id="draft-item" hidden>
          <input id="item-name" placeholder="name, e.g. yellow cup" value="yellow cup" />
          <select id="item-shape">${SHAPES.map((s) => `<option value="${s}">${s}</option>`).join('')}</select>
          <input id="item-color" type="color" value="#f4c430" title="colour" />
        </div>
        <div class="draft" id="draft-zone" hidden>
          <input id="zone-name" placeholder="zone name, e.g. sink" value="sink" />
        </div>
        <div class="draft" id="draft-fixture" hidden>
          <input id="fixture-name" placeholder="name, e.g. left cabinet" value="left cabinet" />
        </div>
        <div class="tool-hint" id="tool-hint">Click an item, zone or drawer to select it.</div>
      </section>

      <section>
        <div class="section-title">Gauntlet <span class="hint">same chore, N layouts</span></div>
        <div class="row">
          <input id="gauntlet-count" type="number" min="2" max="24" value="6" />
          <button id="gauntlet-run" class="primary">Run variants</button>
        </div>
        <div class="gauntlet" id="gauntlet"></div>
      </section>

      <section>
        <div class="section-title">Room <span class="hint" id="entity-count"></span></div>
        <ul class="entities" id="entities"></ul>
      </section>

      <section>
        <details>
          <summary class="section-title">Receipts <span class="hint">who made what</span></summary>
          <div class="receipts" id="receipts"></div>
        </details>
      </section>
    </aside>

    <aside class="panel right">
      <section class="row controls">
        <button id="reset" class="danger">Reset room</button>
        <button id="abort" class="ghost">Stop robot</button>
        <label class="toggle"><input type="checkbox" id="follow" checked /> Follow</label>
        <label class="toggle"><input type="checkbox" id="labels" checked /> Labels</label>
      </section>
      <section>
        <div class="section-title">Ledger <span class="hint" id="ledger-hint"></span></div>
        <div id="ledger"></div>
      </section>
      <section>
        <div class="section-title">Robot</div>
        <div class="robot-status" id="robot-status"></div>
      </section>
      <section class="qr">
        ${
          live
            ? `<canvas id="qr" width="148" height="148"></canvas>
        <div class="qr-text">
          <div><strong>Phone ledger</strong></div>
          <div class="hint">Scan to submit chores and watch every step flip on your phone.</div>
          <a id="ledger-link" href="${this.opts.ledgerUrl}" target="_blank" rel="noreferrer">${shortUrl(this.opts.ledgerUrl)}</a>
        </div>`
            : `<div class="qr-text">
          <div><strong>Phone sync is off</strong> (offline mode)</div>
          <div class="hint">The ledger is mirrored in a second tab of this browser: <a href="${this.opts.ledgerUrl}" target="_blank" rel="noreferrer">open ledger</a>. Set <span class="mono">VITE_CONVEX_URL</span> to go live for phones.</div>
        </div>`
        }
      </section>
    </aside>

    <footer class="chorebar">
      <form id="chore-form" autocomplete="off">
        <input id="chore" placeholder='Type a chore: "put the red mug on the shelf"' />
        <button type="submit" class="primary">Rehearse</button>
      </form>
      <div class="chips" id="chips">${EXAMPLES.map((e) => `<button type="button" data-chore="${e}">${e}</button>`).join('')}</div>
    </footer>

    <div class="hints">Drag: orbit · Scroll: zoom · Esc: select tool · F: follow · L: labels · S: stage zoom</div>
    `;
  }

  private wire(): void {
    this.q('#tools').addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest('button');
      if (!btn) return;
      this.setTool(btn.dataset.tool as Tool);
    });
    const form = this.q<HTMLFormElement>('#chore-form');
    const input = this.q<HTMLInputElement>('#chore');
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      this.cb.onSubmitChore(text);
      input.value = '';
    };
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      submit();
    });
    // Explicit Enter handling — some kiosk/projector setups swallow implicit form submission.
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submit();
      }
    });
    this.q('#chips').addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest('button');
      if (!btn?.dataset.chore) return;
      input.value = btn.dataset.chore;
      input.focus();
    });
    this.q('#entities').addEventListener('click', (ev) => {
      const el = ev.target as HTMLElement;
      const li = el.closest('li');
      if (!li?.dataset.id) return;
      if (el.closest('.remove')) {
        this.cb.onRemoveEntity(li.dataset.id);
        return;
      }
      this.cb.onSelectEntity(li.dataset.id === this.selectedId ? null : li.dataset.id);
    });
    this.q('#gauntlet-run').addEventListener('click', () => {
      const n = Math.max(2, Math.min(24, Number(this.q<HTMLInputElement>('#gauntlet-count').value) || 6));
      this.cb.onRunGauntlet(n);
    });
    this.q('#gauntlet').addEventListener('click', (ev) => {
      const tile = (ev.target as HTMLElement).closest('.tile') as HTMLElement | null;
      if (!tile?.dataset.gid || !tile.dataset.vid) return;
      this.cb.onReplayVariant(tile.dataset.gid, tile.dataset.vid);
    });
    // Two-step reset: no native dialog on the projector.
    const resetBtn = this.q<HTMLButtonElement>('#reset');
    resetBtn.addEventListener('click', () => {
      if (resetBtn.dataset.armed === '1') {
        clearTimeout(this.resetArmedTimer);
        resetBtn.dataset.armed = '0';
        resetBtn.textContent = 'Reset room';
        this.cb.onReset();
        return;
      }
      resetBtn.dataset.armed = '1';
      resetBtn.textContent = 'Confirm reset (3 s)';
      this.resetArmedTimer = setTimeout(() => {
        resetBtn.dataset.armed = '0';
        resetBtn.textContent = 'Reset room';
      }, 3000);
    });
    this.q('#abort').addEventListener('click', () => this.cb.onAbort());
    this.q<HTMLInputElement>('#follow').addEventListener('change', (ev) => this.cb.onToggleFollow((ev.target as HTMLInputElement).checked));
    this.q<HTMLInputElement>('#labels').addEventListener('change', (ev) => this.cb.onToggleLabels((ev.target as HTMLInputElement).checked));
    window.addEventListener('keydown', (ev) => {
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes((ev.target as HTMLElement)?.tagName);
      if (ev.key === 'Escape') this.setTool('select');
      if (typing) return;
      if (ev.key === 'f' || ev.key === 'F') {
        const f = this.q<HTMLInputElement>('#follow');
        f.checked = !f.checked;
        this.cb.onToggleFollow(f.checked);
      }
      if (ev.key === 'l' || ev.key === 'L') {
        const l = this.q<HTMLInputElement>('#labels');
        l.checked = !l.checked;
        this.cb.onToggleLabels(l.checked);
      }
      if (ev.key === 's' || ev.key === 'S') this.setStage(!document.documentElement.classList.contains('stage'));
    });
  }

  /** Stage mode: bigger HUD type for a projector at the back of the room. */
  setStage(on: boolean): void {
    document.documentElement.classList.toggle('stage', on);
    this.toast(on ? 'Stage zoom on' : 'Stage zoom off', 1200);
  }

  private async renderQr(): Promise<void> {
    try {
      await QRCode.toCanvas(this.q<HTMLCanvasElement>('#qr'), this.opts.ledgerUrl, {
        width: 148,
        margin: 2,
        color: { dark: '#0e1116', light: '#ffffff' },
      });
    } catch (e) {
      console.warn('qr failed', e);
    }
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('#tools button')) b.classList.toggle('on', b.dataset.tool === tool);
    this.q('#draft-item').hidden = tool !== 'item';
    this.q('#draft-zone').hidden = tool !== 'zone';
    this.q('#draft-fixture').hidden = !(tool === 'drawer' || tool === 'door');
    if (tool === 'drawer' || tool === 'door') {
      const f = this.q<HTMLInputElement>('#fixture-name');
      if (!f.dataset.touched) f.value = tool === 'door' ? 'left cabinet' : 'bottom drawer';
      f.addEventListener('input', () => (f.dataset.touched = '1'), { once: true });
    }
    const hints: Record<Tool, string> = {
      select: 'Click an item, zone or drawer to select it.',
      item: 'Click a surface to drop the item there.',
      zone: 'Click a flat surface to mark a target zone (shelf, sink, table).',
      drawer: 'Click a wall or cabinet face to mount a drawer; click the floor for a free-standing unit.',
      door: 'Click a wall or cabinet face to mount a hinged door; click the floor for a free-standing unit.',
      robot: 'Click the floor to move the robot start position.',
    };
    this.q('#tool-hint').textContent = hints[tool];
    this.cb.onToolChange(tool);
  }

  getTool(): Tool {
    return this.tool;
  }

  itemDraft(): ItemDraft {
    return {
      name: this.q<HTMLInputElement>('#item-name').value.trim() || 'item',
      shape: this.q<HTMLSelectElement>('#item-shape').value,
      color: this.q<HTMLInputElement>('#item-color').value,
    };
  }

  zoneDraft(): string {
    return this.q<HTMLInputElement>('#zone-name').value.trim() || 'zone';
  }

  fixtureDraft(): string {
    return this.q<HTMLInputElement>('#fixture-name').value.trim() || (this.tool === 'door' ? 'cabinet door' : 'drawer');
  }

  setStatus(text: string | null): void {
    this.statusEl.hidden = !text;
    this.q('#status-text').textContent = text ?? '';
  }

  toast(text: string, ms = 2600): void {
    const t = this.q('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout((t as any)._timer);
    (t as any)._timer = setTimeout(() => (t.hidden = true), ms);
  }

  setGridInfo(info: string): void {
    this.gridInfo = info;
    if (this.lastState) this.renderWorldLine(this.lastState);
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    if (this.lastState) this.renderEntities(this.lastState);
  }

  update(state: RoomState): void {
    this.lastState = state;
    this.renderWorldLine(state);
    this.renderEntities(state);
    this.renderLedger(state);
    this.renderRobot(state);
    this.renderGauntlet(state);
    this.renderReceipts(state);
  }

  private renderWorldLine(state: RoomState): void {
    this.q('#worldline').textContent = `${state.world.name} · ${this.gridInfo}`;
  }

  private renderEntities(state: RoomState): void {
    const list = this.q('#entities');
    const es = state.entities.filter((e) => !(e.kind === 'item' && e.clutter));
    const clutter = state.entities.filter((e) => e.kind === 'item' && e.clutter).length;
    this.q('#entity-count').textContent = `${es.length}${clutter ? ` + ${clutter} clutter` : ''}`;
    list.innerHTML = es
      .map((e) => {
        const meta =
          e.kind === 'item'
            ? e.state === 'held'
              ? 'in gripper'
              : e.state === 'placed'
                ? `placed`
                : 'loose'
            : e.kind === 'fixture'
              ? `${e.fixtureType} · ${e.openness > 0.5 ? 'open' : 'closed'}`
              : 'zone';
        const swatch = e.kind === 'item' ? `<i class="swatch" style="background:${e.color}"></i>` : `<i class="swatch ${e.kind}"></i>`;
        return `<li data-id="${e.id}" class="${e.id === this.selectedId ? 'selected' : ''}">
          ${swatch}<span class="ename">${escapeHtml(e.name)}</span><span class="emeta">${meta}</span>
          <button class="remove" title="remove">×</button></li>`;
      })
      .join('');
  }

  private renderLedger(state: RoomState): void {
    const current = currentTask(state.tasks);
    const queued = [...state.tasks].filter((t) => t.status === 'queued' && t.id !== current?.id).sort((a, b) => a.createdAt - b.createdAt);
    this.q('#ledger-hint').textContent = queued.length ? `${queued.length} queued` : '';
    const el = this.q('#ledger');
    if (!current) {
      el.innerHTML = `<div class="empty">No chores yet. Type one below${this.opts.mode === 'convex' ? ' or scan the QR from a phone' : ''}.</div>`;
      return;
    }
    const history = [...state.tasks]
      .sort((a, b) => b.createdAt - a.createdAt)
      .filter((t) => t.id !== current.id && (t.status === 'pass' || t.status === 'fail'))
      .slice(0, 4);
    el.innerHTML =
      renderTask(current) +
      (queued.length
        ? `<div class="queue"><div class="queue-title">Up next (${queued.length})</div>${queued
            .map((t) => `<div class="queue-item"><span>${escapeHtml(t.text)}</span><em>${escapeHtml(t.source ?? '')}</em></div>`)
            .join('')}</div>`
        : '') +
      (history.length
        ? `<details class="history"><summary>Earlier (${history.length})</summary>${history
            .map((t) => `<div class="hist ${t.status}"><span>${escapeHtml(t.text)}</span><b>${t.status.toUpperCase()}</b></div>`)
            .join('')}</details>`
        : '');
  }

  private renderRobot(state: RoomState): void {
    const r = state.robot;
    const carrying = r.carrying ? (state.entities.find((e) => e.id === r.carrying)?.name ?? 'item') : 'nothing';
    const mpu = state.world.metersPerUnit;
    this.q('#robot-status').innerHTML = `
      <span class="led ${r.state}"></span><b>${r.state}</b>
      <span class="mono">(${(r.pos.x * mpu).toFixed(1)} m, ${(r.pos.z * mpu).toFixed(1)} m) · ${Math.round(((r.yaw * 180) / Math.PI + 360) % 360)}°</span>
      <span class="hint">carrying ${escapeHtml(carrying)}</span>`;
  }

  private renderGauntlet(state: RoomState): void {
    const g: Gauntlet | undefined = [...state.gauntlets].sort((a, b) => b.createdAt - a.createdAt)[0];
    const el = this.q('#gauntlet');
    if (!g) {
      el.innerHTML = `<div class="empty">Replays the last chore across shuffled layouts with random clutter and paints failures on the floor.</div>`;
      return;
    }
    const passes = g.variants.filter((v) => v.passed === true).length;
    const done = g.variants.filter((v) => v.passed !== null).length;
    const firstFail = g.variants.find((v) => v.passed === false);
    el.innerHTML = `
      <div class="gauntlet-head"><span>“${escapeHtml(g.taskText)}”</span><b>${passes}/${done} pass</b></div>
      ${firstFail ? `<div class="gauntlet-why"><b>${escapeHtml(firstFail.label)}:</b> ${escapeHtml(firstFail.reason ?? 'failed')}</div>` : ''}
      <div class="tiles">${g.variants
        .map(
          (v) => `<div class="tile ${v.passed === null ? 'pending' : v.passed ? 'pass' : 'fail'}" data-gid="${g.id}" data-vid="${v.id}" title="${escapeHtml(
            v.passed === null ? 'running…' : `${v.passed ? 'PASS' : 'FAIL'} — ${v.reason ?? ''} · click to replay in 3D`,
          )}">
            <b>${escapeHtml(v.label)}</b><span>${v.passed === null ? '…' : v.passed ? `PASS · ${(v.distanceM ?? 0).toFixed(1)} m` : escapeHtml(v.reason ?? 'FAIL')}</span></div>`,
        )
        .join('')}</div>`;
  }

  private renderReceipts(state: RoomState): void {
    const m = this.opts.manifest;
    const rows: string[] = [];
    rows.push(receipt('World Labs', state.world.provenance, m?.world?.provider === 'worldlabs' ? `Marble ${m.world.model ?? ''} · world ${m.world.worldId ?? ''}` : ''));
    rows.push(
      receipt(
        'Tripo',
        m?.robot?.provider === 'tripo'
          ? `Robot GLB ${m.robot.model ?? ''} · rig ${m.robot.rig ?? ''} · tasks ${(m.robot.taskIds ?? []).join(', ')}`
          : 'Procedural robot body (run scripts/tripo-robot.mjs to swap in a rigged Tripo character).',
        m?.robot?.note ?? '',
      ),
    );
    const mintProps = (m?.props ?? []).filter((p) => p.provider === 'mint');
    rows.push(
      receipt(
        'Mint',
        mintProps.length
          ? `${mintProps.length} props from a Mint MCP asset pack: ${mintProps.map((p) => p.name).join(', ')}`
          : 'Props are procedural. Ask the Mint MCP for an asset pack and run scripts/mint-sync.mjs.',
        (m?.audio ?? []).length ? `${m!.audio!.length} Mint SFX clips` : 'Synth SFX fallback',
      ),
    );
    rows.push(
      receipt(
        'Convex',
        this.opts.mode === 'convex'
          ? 'Live: entities, tasks, gauntlets and heat are one reactive query, the robot pose another; every step is a mutation.'
          : 'Offline mode: same state model in localStorage + BroadcastChannel. Set VITE_CONVEX_URL to go live.',
        '',
      ),
    );
    this.q('#receipts').innerHTML = rows.join('');
  }
}

function receipt(who: string, what: string, extra: string): string {
  return `<div class="receipt"><b>${who}</b><span>${escapeHtml(what)}</span>${extra ? `<em>${escapeHtml(extra)}</em>` : ''}</div>`;
}

export function renderTask(t: Task): string {
  const stepsHtml = t.steps.length
    ? `<ol class="steps">${t.steps
        .map(
          (s) => `<li class="${s.status}"><span class="chip">${s.status}</span><span class="kind">${s.kind}</span><span class="tname">${escapeHtml(s.targetName)}</span>${
            s.note ? `<span class="note">${escapeHtml(s.note)}</span>` : ''
          }</li>`,
        )
        .join('')}</ol>`
    : t.status === 'planning'
      ? `<div class="planning">planning…</div>`
      : t.status === 'queued'
        ? `<div class="planning">waiting for the robot…</div>`
        : '';
  const result = t.result
    ? `<div class="result ${t.result.passed ? 'pass' : 'fail'}"><b>${t.result.passed ? 'PASS' : 'FAIL'}</b><span>${escapeHtml(t.result.reason)}</span></div>`
    : '';
  return `<div class="task ${t.status}">
    <div class="task-text">“${escapeHtml(t.text)}”</div>
    <div class="task-meta">${t.plannerName ? escapeHtml(t.plannerName) : ''}${t.source ? ` · from ${escapeHtml(t.source)}` : ''}</div>
    ${stepsHtml}${result}</div>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function shortUrl(u: string): string {
  return u.replace(/^https?:\/\//, '').slice(0, 42);
}

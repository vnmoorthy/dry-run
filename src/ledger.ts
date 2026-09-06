/**
 * Phone ledger: the second screen. Submits chores and mirrors every step,
 * the robot's position on a top-down map, and the Gauntlet grid — from the
 * same store the projector writes to.
 */

import { createStore } from './data/store';
import { currentTask, renderTask, escapeHtml } from './ui/hud';
import type { Entity, RoomState } from './sim/types';

const app = document.getElementById('ledger-app')!;
const store = createStore();
app.innerHTML = `
  <header>
    <div class="brand">Dry Run <span class="badge ${store.mode}">${store.mode === 'convex' ? 'live' : 'offline'}</span></div>
    <div class="sub">Room “${escapeHtml(store.roomSlug)}” · every step below flips the moment the robot does it.</div>
  </header>
  <form id="f" autocomplete="off">
    <input id="chore" placeholder='Chore: "put the red mug on the shelf"' />
    <button type="submit">Send</button>
  </form>
  <div class="chips" id="chips"></div>
  <section><canvas id="map"></canvas></section>
  <section id="current"></section>
  <section id="queue"></section>
  <section id="gauntlet"></section>
  <section id="history"></section>
  <footer id="status">connecting…</footer>
`;

const chips = ['put the red mug on the shelf', 'open the top drawer', 'bring me the green book', 'tidy the room'];
document.getElementById('chips')!.innerHTML = chips.map((c) => `<button type="button" data-c="${c}">${c}</button>`).join('');
document.getElementById('chips')!.addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest('button');
  if (!b?.dataset.c) return;
  (document.getElementById('chore') as HTMLInputElement).value = b.dataset.c;
});
document.getElementById('f')!.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = document.getElementById('chore') as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  void store.submitTask(text, 'phone');
  input.value = '';
  if (navigator.vibrate) navigator.vibrate(20);
});

store
  .ready()
  .then(() => {
    document.getElementById('status')!.textContent =
      store.mode === 'convex' ? 'Live via Convex — this page updates with the projector.' : 'This room is offline: it mirrors other tabs of this browser only. Ask the presenter to switch to live mode for phones.';
  })
  .catch((e) => {
    document.getElementById('status')!.textContent = `Connection failed: ${(e as Error).message}`;
  });

let lastVibrateTask = '';
let lastState: RoomState | null = null;
store.subscribe(render);
window.addEventListener('resize', () => lastState && drawMap(lastState));

function render(s: RoomState): void {
  lastState = s;
  const current = currentTask(s.tasks);
  document.getElementById('current')!.innerHTML = current ? renderTask(current) : '<div class="empty">No chores yet.</div>';
  if (current?.result && lastVibrateTask !== current.id) {
    lastVibrateTask = current.id;
    if (navigator.vibrate) navigator.vibrate(current.result.passed ? [30, 40, 30] : [120]);
  }
  const queued = [...s.tasks].filter((t) => t.status === 'queued' && t.id !== current?.id).sort((a, b) => a.createdAt - b.createdAt);
  document.getElementById('queue')!.innerHTML = queued.length
    ? `<div class="gh">Up next (${queued.length})</div>` + queued.map((t) => `<div class="hist"><span>${escapeHtml(t.text)}</span><b>${escapeHtml(t.source ?? '')}</b></div>`).join('')
    : '';
  const g = [...s.gauntlets].sort((a, b) => b.createdAt - a.createdAt)[0];
  document.getElementById('gauntlet')!.innerHTML = g
    ? `<div class="gh">Gauntlet “${escapeHtml(g.taskText)}” · ${g.variants.filter((v) => v.passed).length}/${g.variants.filter((v) => v.passed !== null).length} pass</div>
       <div class="tiles">${g.variants.map((v) => `<div class="tile ${v.passed === null ? 'pending' : v.passed ? 'pass' : 'fail'}"><b>${escapeHtml(v.label)}</b><span>${v.passed === null ? '…' : v.passed ? 'PASS' : escapeHtml(v.reason ?? '')}</span></div>`).join('')}</div>`
    : '';
  const hist = [...s.tasks]
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter((t) => t.id !== current?.id && t.result)
    .slice(0, 8);
  document.getElementById('history')!.innerHTML = hist.length
    ? `<div class="gh">Earlier</div>` + hist.map((t) => `<div class="hist ${t.status}"><span>${escapeHtml(t.text)}</span><b>${t.status.toUpperCase()}</b></div>`).join('')
    : '';
  drawMap(s);
}

function drawMap(s: RoomState): void {
  const canvas = document.getElementById('map') as HTMLCanvasElement;
  const cssW = canvas.clientWidth || 320;
  const cssH = Math.round(cssW * 0.66);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = `${cssH}px`;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW;
  const H = cssH;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#12161d';
  ctx.fillRect(0, 0, W, H);
  // Fit to the entities and the robot; heat can be far away and would shrink everything.
  const pts = [...s.entities.filter((e) => !(e.kind === 'item' && e.clutter)).map((e) => e.pos), s.robot.pos];
  if (pts.length === 0) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const pad = 2.5;
  minX -= pad;
  maxX += pad;
  minZ -= pad;
  maxZ += pad;
  const k = Math.min(W / (maxX - minX), H / (maxZ - minZ));
  const ox = (W - (maxX - minX) * k) / 2;
  const oz = (H - (maxZ - minZ) * k) / 2;
  const X = (x: number) => ox + (x - minX) * k;
  const Z = (z: number) => oz + (z - minZ) * k;
  const mpu = s.world.metersPerUnit;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  const stepU = 1 / mpu;
  for (let x = Math.ceil(minX / stepU) * stepU; x < maxX; x += stepU) {
    ctx.beginPath();
    ctx.moveTo(X(x), 0);
    ctx.lineTo(X(x), H);
    ctx.stroke();
  }
  for (let z = Math.ceil(minZ / stepU) * stepU; z < maxZ; z += stepU) {
    ctx.beginPath();
    ctx.moveTo(0, Z(z));
    ctx.lineTo(W, Z(z));
    ctx.stroke();
  }
  for (const h of s.heat) {
    ctx.fillStyle = 'rgba(255,59,48,0.35)';
    ctx.beginPath();
    ctx.arc(X(h.x), Z(h.z), 0.9 * k, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.font = '600 13px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (const e of s.entities) drawEntity(ctx, e, X, Z, k);
  const r = s.robot;
  ctx.save();
  ctx.translate(X(r.pos.x), Z(r.pos.z));
  ctx.rotate(-r.yaw);
  ctx.fillStyle = { idle: '#4da3ff', moving: '#3ddc97', working: '#ffb340', failed: '#ff3b30' }[r.state];
  ctx.beginPath();
  ctx.moveTo(0, -0.9 * k);
  ctx.lineTo(0.6 * k, 0.6 * k);
  ctx.lineTo(-0.6 * k, 0.6 * k);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#f4f2ee';
  ctx.fillText('robot', X(r.pos.x), Z(r.pos.z) + 1.2 * k + 14);
}

function drawEntity(ctx: CanvasRenderingContext2D, e: Entity, X: (x: number) => number, Z: (z: number) => number, k: number): void {
  const x = X(e.pos.x);
  const z = Z(e.pos.z);
  if (e.kind === 'zone') {
    ctx.strokeStyle = '#3ddc97';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, z, e.radius * k, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#3ddc97';
    ctx.fillText(e.name, x, z - e.radius * k - 5);
  } else if (e.kind === 'fixture') {
    ctx.save();
    ctx.translate(x, z);
    ctx.rotate(-e.yaw);
    ctx.fillStyle = '#ffd166';
    ctx.fillRect((-e.width / 2) * k, 0, e.width * k, e.depth * k);
    if (e.openness > 0.5) {
      ctx.fillStyle = 'rgba(255,209,102,0.5)';
      ctx.fillRect((-e.width / 2) * k, -e.travel * k, e.width * k, e.travel * k);
    }
    ctx.restore();
    ctx.fillStyle = '#ffd166';
    ctx.fillText(`${e.name}${e.openness > 0.5 ? ' (open)' : ''}`, x, z - 8);
  } else {
    if (e.state === 'held') return;
    ctx.fillStyle = e.clutter ? '#b8874a' : e.color;
    ctx.beginPath();
    ctx.arc(x, z, Math.max(5, 0.3 * k), 0, Math.PI * 2);
    ctx.fill();
    if (!e.clutter) {
      ctx.fillStyle = '#f4f2ee';
      ctx.fillText(e.name, x, z - 9);
    }
  }
}

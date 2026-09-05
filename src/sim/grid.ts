/**
 * Occupancy grid + A* over the world collider.
 *
 * The grid is rasterized from the Marble collider mesh (or any collider) by a
 * caller-supplied sampler, so this module stays free of three.js and can run in
 * Node for tests and in the headless Gauntlet evaluator.
 */

import type { Vec3 } from './types';

export interface Cell {
  c: number;
  r: number;
}

export interface Grid {
  originX: number;
  originZ: number;
  cell: number;
  cols: number;
  rows: number;
  floorY: number;
  /** 0 = free, 1 = blocked, 2 = void (no floor). */
  cells: Uint8Array;
}

export interface SampleResult {
  /** Y of the first surface hit when casting down at this (x, z); null if nothing. */
  hitY: number | null;
}

export interface GridBuildOptions {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cell: number;
  floorY: number;
  /** Anything higher than floorY + this counts as an obstacle. */
  floorTolerance: number;
  /** Extra blocked ring (cells) around obstacles so the robot body fits. */
  inflate: number;
}

export function buildGrid(sample: (x: number, z: number) => SampleResult, o: GridBuildOptions): Grid {
  const cols = Math.max(1, Math.ceil((o.maxX - o.minX) / o.cell));
  const rows = Math.max(1, Math.ceil((o.maxZ - o.minZ) / o.cell));
  const cells = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = o.minX + (c + 0.5) * o.cell;
      const z = o.minZ + (r + 0.5) * o.cell;
      const s = sample(x, z);
      let v = 0;
      if (s.hitY === null) v = 2;
      else if (Math.abs(s.hitY - o.floorY) > o.floorTolerance) v = 1;
      cells[r * cols + c] = v;
    }
  }
  const grid: Grid = { originX: o.minX, originZ: o.minZ, cell: o.cell, cols, rows, floorY: o.floorY, cells };
  // Void borders behave like walls.
  const withVoidWalls = grid.cells.slice();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid.cells[r * cols + c] !== 0) continue;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols || grid.cells[rr * cols + cc] === 2) {
            withVoidWalls[r * cols + c] = 1;
          }
        }
      }
    }
  }
  grid.cells = withVoidWalls;
  return o.inflate > 0 ? inflate(grid, o.inflate) : grid;
}

export function inflate(grid: Grid, radius: number): Grid {
  const out = grid.cells.slice();
  const { cols, rows } = grid;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid.cells[r * cols + c] !== 1) continue;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          if (out[rr * cols + cc] === 0) out[rr * cols + cc] = 1;
        }
      }
    }
  }
  return { ...grid, cells: out };
}

export function cloneGrid(grid: Grid): Grid {
  return { ...grid, cells: grid.cells.slice() };
}

export function worldToCell(grid: Grid, x: number, z: number): Cell {
  return {
    c: Math.floor((x - grid.originX) / grid.cell),
    r: Math.floor((z - grid.originZ) / grid.cell),
  };
}

export function cellToWorld(grid: Grid, cell: Cell): Vec3 {
  return {
    x: grid.originX + (cell.c + 0.5) * grid.cell,
    y: grid.floorY,
    z: grid.originZ + (cell.r + 0.5) * grid.cell,
  };
}

export function inBounds(grid: Grid, cell: Cell): boolean {
  return cell.c >= 0 && cell.r >= 0 && cell.c < grid.cols && cell.r < grid.rows;
}

export function isFree(grid: Grid, cell: Cell): boolean {
  return inBounds(grid, cell) && grid.cells[cell.r * grid.cols + cell.c] === 0;
}

export function setBlocked(grid: Grid, cell: Cell, blocked: boolean): void {
  if (!inBounds(grid, cell)) return;
  grid.cells[cell.r * grid.cols + cell.c] = blocked ? 1 : 0;
}

/** Block a disc of cells around a world point (used for clutter and items on the floor). */
export function blockDisc(grid: Grid, x: number, z: number, radiusUnits: number): Cell[] {
  const changed: Cell[] = [];
  const center = worldToCell(grid, x, z);
  const rc = Math.ceil(radiusUnits / grid.cell);
  for (let dr = -rc; dr <= rc; dr++) {
    for (let dc = -rc; dc <= rc; dc++) {
      const cell = { c: center.c + dc, r: center.r + dr };
      if (!inBounds(grid, cell)) continue;
      const w = cellToWorld(grid, cell);
      if (Math.hypot(w.x - x, w.z - z) > radiusUnits + grid.cell * 0.5) continue;
      if (grid.cells[cell.r * grid.cols + cell.c] === 0) {
        grid.cells[cell.r * grid.cols + cell.c] = 1;
        changed.push(cell);
      }
    }
  }
  return changed;
}

/** Nearest free cell to `cell` within `maxR` rings (spiral search). */
export function nearestFree(grid: Grid, cell: Cell, maxR = 6): Cell | null {
  if (isFree(grid, cell)) return cell;
  for (let r = 1; r <= maxR; r++) {
    let best: Cell | null = null;
    let bestD = Infinity;
    for (let dr = -r; dr <= r; dr++) {
      for (let dc = -r; dc <= r; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== r) continue;
        const cand = { c: cell.c + dc, r: cell.r + dr };
        if (!isFree(grid, cand)) continue;
        const d = dr * dr + dc * dc;
        if (d < bestD) {
          bestD = d;
          best = cand;
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Pick the free cell the robot should stand on to interact with a target: within
 * `reach` world units of the target, preferring cells close to `from`.
 */
export function findApproachCell(grid: Grid, target: Vec3, reach: number, from: Vec3): Cell | null {
  const center = worldToCell(grid, target.x, target.z);
  const rc = Math.ceil(reach / grid.cell) + 1;
  let best: Cell | null = null;
  let bestScore = Infinity;
  for (let dr = -rc; dr <= rc; dr++) {
    for (let dc = -rc; dc <= rc; dc++) {
      const cand = { c: center.c + dc, r: center.r + dr };
      if (!isFree(grid, cand)) continue;
      const w = cellToWorld(grid, cand);
      const dTarget = Math.hypot(w.x - target.x, w.z - target.z);
      if (dTarget > reach || dTarget < grid.cell * 0.9) continue;
      const dFrom = Math.hypot(w.x - from.x, w.z - from.z);
      // Prefer close to the target (good reach) but not far from where we are.
      const score = dTarget * 1.5 + dFrom * 0.25;
      if (score < bestScore) {
        bestScore = score;
        best = cand;
      }
    }
  }
  return best;
}

interface Node {
  c: number;
  r: number;
  g: number;
  f: number;
  parent: number;
}

/** 8-connected A* with no corner cutting. Returns cells from start to goal inclusive. */
export function astar(grid: Grid, start: Cell, goal: Cell, maxExpansions = 200_000): Cell[] | null {
  if (!isFree(grid, start) || !isFree(grid, goal)) return null;
  if (start.c === goal.c && start.r === goal.r) return [start];
  const { cols, rows } = grid;
  const key = (c: number, r: number) => r * cols + c;
  const closed = new Uint8Array(cols * rows);
  const bestG = new Float32Array(cols * rows).fill(Infinity);
  const nodes: Node[] = [];
  const open: number[] = [];
  const h = (c: number, r: number) => {
    const dx = Math.abs(c - goal.c);
    const dy = Math.abs(r - goal.r);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  const push = (n: Node) => {
    nodes.push(n);
    const idx = nodes.length - 1;
    open.push(idx);
    let i = open.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (nodes[open[p]].f <= nodes[open[i]].f) break;
      [open[p], open[i]] = [open[i], open[p]];
      i = p;
    }
  };
  const pop = (): number => {
    const top = open[0];
    const last = open.pop()!;
    if (open.length > 0) {
      open[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const rgt = 2 * i + 2;
        let m = i;
        if (l < open.length && nodes[open[l]].f < nodes[open[m]].f) m = l;
        if (rgt < open.length && nodes[open[rgt]].f < nodes[open[m]].f) m = rgt;
        if (m === i) break;
        [open[m], open[i]] = [open[i], open[m]];
        i = m;
      }
    }
    return top;
  };
  push({ c: start.c, r: start.r, g: 0, f: h(start.c, start.r), parent: -1 });
  bestG[key(start.c, start.r)] = 0;
  let expansions = 0;
  while (open.length > 0 && expansions < maxExpansions) {
    const idx = pop();
    const n = nodes[idx];
    const k = key(n.c, n.r);
    if (closed[k]) continue;
    closed[k] = 1;
    expansions += 1;
    if (n.c === goal.c && n.r === goal.r) {
      const path: Cell[] = [];
      let cur = idx;
      while (cur !== -1) {
        path.push({ c: nodes[cur].c, r: nodes[cur].r });
        cur = nodes[cur].parent;
      }
      path.reverse();
      return path;
    }
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nc = n.c + dc;
        const nr = n.r + dr;
        const cand = { c: nc, r: nr };
        if (!isFree(grid, cand)) continue;
        if (dr !== 0 && dc !== 0) {
          // No corner cutting: both orthogonal neighbours must be free.
          if (!isFree(grid, { c: n.c + dc, r: n.r }) || !isFree(grid, { c: n.c, r: n.r + dr })) continue;
        }
        const nk = key(nc, nr);
        if (closed[nk]) continue;
        const g = n.g + (dr !== 0 && dc !== 0 ? Math.SQRT2 : 1);
        if (g >= bestG[nk]) continue;
        bestG[nk] = g;
        push({ c: nc, r: nr, g, f: g + h(nc, nr), parent: idx });
      }
    }
  }
  return null;
}

/** Bresenham line-of-sight over free cells. */
export function lineOfSight(grid: Grid, a: Cell, b: Cell): boolean {
  let x0 = a.c;
  let y0 = a.r;
  const x1 = b.c;
  const y1 = b.r;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (!isFree(grid, { c: x0, r: y0 })) return false;
    if (x0 === x1 && y0 === y1) return true;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
      // Also check the orthogonal neighbour so the line does not squeeze through corners.
      if (!isFree(grid, { c: x0, r: y0 })) return false;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** String-pulling: drop intermediate waypoints that have line of sight. */
export function smoothPath(grid: Grid, path: Cell[]): Cell[] {
  if (path.length <= 2) return path;
  const out: Cell[] = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let j = path.length - 1;
    while (j > i + 1 && !lineOfSight(grid, path[i], path[j])) j -= 1;
    out.push(path[j]);
    i = j;
  }
  return out;
}

export function pathLengthUnits(grid: Grid, path: Cell[]): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) {
    const a = cellToWorld(grid, path[i - 1]);
    const b = cellToWorld(grid, path[i]);
    len += Math.hypot(a.x - b.x, a.z - b.z);
  }
  return len;
}

/** Cells reachable from `start` (flood fill), for diagnostics. */
export function reachableSet(grid: Grid, start: Cell): Set<number> {
  const seen = new Set<number>();
  if (!isFree(grid, start)) return seen;
  const stack = [start];
  const key = (c: Cell) => c.r * grid.cols + c.c;
  seen.add(key(start));
  while (stack.length) {
    const cur = stack.pop()!;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const n = { c: cur.c + dc, r: cur.r + dr };
        if (!isFree(grid, n)) continue;
        const k = key(n);
        if (seen.has(k)) continue;
        seen.add(k);
        stack.push(n);
      }
    }
  }
  return seen;
}

/** Free cells within `radius` cells of `cell` that are reachable from `from` (for random placement). */
export function freeCellsNear(grid: Grid, cell: Cell, radius: number, reachable?: Set<number>): Cell[] {
  const out: Cell[] = [];
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      const cand = { c: cell.c + dc, r: cell.r + dr };
      if (!isFree(grid, cand)) continue;
      if (reachable && !reachable.has(cand.r * grid.cols + cand.c)) continue;
      out.push(cand);
    }
  }
  return out;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

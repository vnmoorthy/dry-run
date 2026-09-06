/**
 * Gauntlet: headless evaluation of one chore across N layout variants.
 *
 * A variant shuffles the loose items to nearby reachable spots and drops a
 * few clutter boxes on the floor. The trial then replays the planner's steps
 * on the occupancy grid only (no rendering): every `navigate` must find a path,
 * every `pick`/`place`/`open` must be within reach. This is the "evaluation,
 * not training, is the bottleneck" beat — hundreds of trials in milliseconds.
 */

import {
  astar,
  blockDisc,
  cellToWorld,
  cloneGrid,
  findApproachCell,
  freeCellsNear,
  isFree,
  nearestFree,
  pathLengthUnits,
  reachableSet,
  rng,
  setBlocked,
  smoothPath,
  worldToCell,
  type Cell,
  type Grid,
} from './grid';
import { planTaskLocal } from './planner';
import type { Entity, Item, RobotPose, Step, Variant, VariantLayout, Vec3 } from './types';
import { dist2d } from './types';

export interface TrialConfig {
  /** How far (world units) the robot arm can reach from its standing cell. */
  reach: number;
  /** Approach cells are searched within reach × this, leaving margin for the final turn. */
  approachFactor: number;
  /** Footprint radius of a clutter box (world units). */
  clutterRadius: number;
  /** Footprint radius of an item standing on the floor (world units). */
  itemRadius: number;
  metersPerUnit: number;
}

export const DEFAULT_TRIAL: TrialConfig = { reach: 2.2, approachFactor: 0.9, clutterRadius: 0.55, itemRadius: 0.3, metersPerUnit: 0.4 };

/** Where the robot must get near: the handle for fixtures (in front of the face), the entity itself otherwise. */
export function interactionPoint(e: Entity): Vec3 {
  if (e.kind === 'fixture') {
    const out = e.fixtureType === 'drawer' ? 0.12 + e.openness * e.travel : 0.12;
    return { x: e.pos.x + e.normal.x * out, y: e.pos.y, z: e.pos.z + e.normal.z * out };
  }
  return e.pos;
}

export interface TrialOutcome {
  passed: boolean;
  reason: string;
  distanceUnits: number;
  stuckAt: Vec3 | null;
  failedStep?: Step;
}

/** Apply a layout to a copy of the entities (items moved, clutter added as items). */
export function applyLayout(entities: Entity[], layout: VariantLayout): Entity[] {
  const byId = new Map(layout.items.map((i) => [i.id, i.pos] as const));
  const moved: Entity[] = entities.map((e) => {
    if (e.kind === 'item' && byId.has(e.id)) return { ...e, pos: byId.get(e.id)!, state: 'idle', zoneId: null, heldBy: null };
    return e;
  });
  layout.clutter.forEach((pos, i) => {
    const box: Item = {
      id: `clutter_${i}`,
      kind: 'item',
      name: `clutter box ${i + 1}`,
      tags: ['clutter', 'box'],
      pos,
      yaw: 0,
      createdAt: 0,
      shape: 'crate',
      color: '#b8874a',
      size: 0.9,
      state: 'idle',
      clutter: true,
    };
    moved.push(box);
  });
  return moved;
}

/**
 * The cell the robot stands on is free by definition, even if an item was just
 * placed beside it; fall back to the nearest free cell if the base grid itself
 * is blocked there (robot dropped on furniture).
 */
export function startCellFor(base: Grid, grid: Grid, pos: Vec3): Cell | null {
  const c = worldToCell(grid, pos.x, pos.z);
  if (isFree(grid, c)) return c;
  if (isFree(base, c)) {
    setBlocked(grid, c, false);
    return c;
  }
  return nearestFree(grid, c, 4);
}

/** Block the grid where floor-standing items and clutter sit. */
export function gridWithEntities(base: Grid, entities: Entity[], cfg: TrialConfig): Grid {
  const g = cloneGrid(base);
  for (const e of entities) {
    if (e.kind !== 'item') continue;
    // Only floor-standing things block; items on tables/shelves are above the floor tolerance already.
    if (Math.abs(e.pos.y - base.floorY) > 0.6) continue;
    blockDisc(g, e.pos.x, e.pos.z, e.clutter ? cfg.clutterRadius : cfg.itemRadius);
  }
  return g;
}

export function makeVariantLayout(
  base: Grid,
  entities: Entity[],
  robot: RobotPose,
  seed: number,
  opts: { shuffleRadiusCells?: number; clutterCount?: number; clutterRadius?: number } = {},
): VariantLayout {
  const rand = rng(seed);
  const shuffleRadius = opts.shuffleRadiusCells ?? 4;
  const clutterCount = opts.clutterCount ?? 3;
  const start = worldToCell(base, robot.pos.x, robot.pos.z);
  const reachable = reachableSet(base, start);
  const items: VariantLayout['items'] = [];
  const g = cloneGrid(base);
  for (const e of entities) {
    if (e.kind !== 'item' || e.clutter) continue;
    // Items that live on furniture (above the floor) keep their spot; floor items get shuffled nearby.
    if (Math.abs(e.pos.y - base.floorY) > 0.6) {
      // Nudge them a little so the approach changes.
      const jitter = () => (rand() - 0.5) * base.cell;
      items.push({ id: e.id, pos: { x: e.pos.x + jitter(), y: e.pos.y, z: e.pos.z + jitter() } });
      continue;
    }
    const cell = worldToCell(base, e.pos.x, e.pos.z);
    const cands = freeCellsNear(g, cell, shuffleRadius, reachable);
    if (cands.length === 0) {
      items.push({ id: e.id, pos: e.pos });
      continue;
    }
    const pick = cands[Math.floor(rand() * cands.length)];
    const w = cellToWorld(base, pick);
    items.push({ id: e.id, pos: { x: w.x, y: e.pos.y, z: w.z } });
    blockDisc(g, w.x, w.z, opts.clutterRadius ?? DEFAULT_TRIAL.itemRadius);
  }
  const clutter: Vec3[] = [];
  const reachableCells = [...reachable].map((k) => ({ c: k % base.cols, r: Math.floor(k / base.cols) }));
  const placedItems = new Map(items.map((i) => [i.id, i.pos] as const));
  const keepClear = entities.map((e) => (e.kind === 'item' && placedItems.has(e.id) ? placedItems.get(e.id)! : e.pos));
  let guard = 0;
  while (clutter.length < clutterCount && guard++ < 300 && reachableCells.length > 0) {
    const cell = reachableCells[Math.floor(rand() * reachableCells.length)];
    if (!isFree(g, cell)) continue;
    const w = cellToWorld(base, cell);
    // Keep clutter away from the robot's start so the run is not dead on arrival,
    // off the items/zones/fixtures themselves, and apart from other clutter.
    if (Math.hypot(w.x - robot.pos.x, w.z - robot.pos.z) < 2.5) continue;
    if (keepClear.some((p) => Math.hypot(p.x - w.x, p.z - w.z) < 1.1)) continue;
    if (clutter.some((c) => Math.hypot(c.x - w.x, c.z - w.z) < 1.2)) continue;
    clutter.push({ x: w.x, y: base.floorY, z: w.z });
    blockDisc(g, w.x, w.z, opts.clutterRadius ?? DEFAULT_TRIAL.clutterRadius);
  }
  return { items, clutter };
}

export interface Blocker {
  pos: Vec3;
  name: string;
}

/**
 * Find what is blocking the path (the "why did we fail" answer): the single
 * floor-standing item whose removal unblocks it — clutter first, then loose
 * items, then placed items — or a pair of clutter boxes.
 */
export function findBlocker(base: Grid, entities: Entity[], from: Vec3, target: Vec3, cfg: TrialConfig): Blocker | null {
  const floorItems = entities.filter((e): e is Item => e.kind === 'item' && Math.abs(e.pos.y - base.floorY) <= 0.6);
  const ordered = [
    ...floorItems.filter((i) => i.clutter),
    ...floorItems.filter((i) => !i.clutter && i.state !== 'placed'),
    ...floorItems.filter((i) => !i.clutter && i.state === 'placed'),
  ];
  const pathExistsWithout = (ids: Set<string>): boolean => {
    const g = gridWithEntities(base, entities.filter((e) => !ids.has(e.id)), cfg);
    const startCell = startCellFor(base, g, from);
    const approach = findApproachCell(g, target, cfg.reach * cfg.approachFactor, from);
    if (!approach || !startCell) return false;
    return astar(g, startCell, approach) !== null;
  };
  for (const c of ordered) if (pathExistsWithout(new Set([c.id]))) return { pos: c.pos, name: c.name };
  const clutter = ordered.filter((i) => i.clutter).slice(0, 4);
  for (let i = 0; i < clutter.length; i++) {
    for (let j = i + 1; j < clutter.length; j++) {
      if (pathExistsWithout(new Set([clutter[i].id, clutter[j].id]))) return { pos: clutter[i].pos, name: `${clutter[i].name} + ${clutter[j].name}` };
    }
  }
  return null;
}

export function blockerReason(blocker: Blocker | null, target: Entity, from: Vec3, mpu: number): string {
  if (!blocker) return `no path to ${target.name} from (${(from.x * mpu).toFixed(1)} m, ${(from.z * mpu).toFixed(1)} m)`;
  const d = dist2d(blocker.pos, target.pos) * mpu;
  return `blocked by ${blocker.name} ${d.toFixed(1)} m from ${target.name} (at ${(blocker.pos.x * mpu).toFixed(1)} m, ${(blocker.pos.z * mpu).toFixed(1)} m)`;
}

export function runTrial(base: Grid, entitiesIn: Entity[], robotIn: RobotPose, taskText: string, cfg: TrialConfig = DEFAULT_TRIAL): TrialOutcome {
  let entities = entitiesIn.map((e) => ({ ...e }));
  const robot: RobotPose = { ...robotIn, pos: { ...robotIn.pos } };
  const plan = planTaskLocal(taskText, entities, robot);
  if (!plan.ok) return { passed: false, reason: plan.reason, distanceUnits: 0, stuckAt: null };
  let distance = 0;
  let holding: string | null = null;
  const byId = () => new Map(entities.map((e) => [e.id, e] as const));
  for (const step of plan.steps) {
    const target = byId().get(step.targetId);
    if (!target) return { passed: false, reason: `lost track of ${step.targetName}`, distanceUnits: distance, stuckAt: null, failedStep: step };
    if (step.kind === 'navigate') {
      const grid = gridWithEntities(base, entities.filter((e) => e.id !== holding), cfg);
      const startCell = startCellFor(base, grid, robot.pos);
      if (!startCell) {
        return { passed: false, reason: 'robot start is not on drivable floor', distanceUnits: distance, stuckAt: robot.pos, failedStep: step };
      }
      const point = interactionPoint(target);
      const approach = findApproachCell(grid, point, cfg.reach * cfg.approachFactor, robot.pos);
      if (!approach) {
        return {
          passed: false,
          reason: `no standing room within ${(cfg.reach * cfg.approachFactor * cfg.metersPerUnit).toFixed(1)} m of ${target.name}`,
          distanceUnits: distance,
          stuckAt: target.pos,
          failedStep: step,
        };
      }
      const path = astar(grid, startCell, approach);
      if (!path) {
        const blocker = findBlocker(base, entities.filter((e) => e.id !== holding), robot.pos, point, cfg);
        const where = blockerReason(blocker, target, robot.pos, cfg.metersPerUnit);
        return { passed: false, reason: where, distanceUnits: distance, stuckAt: blocker ? blocker.pos : target.pos, failedStep: step };
      }
      const smooth = smoothPath(grid, path);
      distance += pathLengthUnits(grid, smooth);
      const end = cellToWorld(grid, approach);
      robot.pos = { x: end.x, y: end.y, z: end.z };
      continue;
    }
    if (dist2d(robot.pos, interactionPoint(target)) > cfg.reach + 0.1) {
      return { passed: false, reason: `${target.name} out of reach`, distanceUnits: distance, stuckAt: robot.pos, failedStep: step };
    }
    if (step.kind === 'pick') {
      if (target.kind !== 'item') return { passed: false, reason: `${target.name} is not something I can pick up`, distanceUnits: distance, stuckAt: null, failedStep: step };
      if (holding) return { passed: false, reason: `hands full (holding ${holding})`, distanceUnits: distance, stuckAt: null, failedStep: step };
      holding = target.id;
      entities = entities.map((e) => (e.id === target.id ? { ...e, state: 'held' as const } : e));
    } else if (step.kind === 'place') {
      if (!holding) return { passed: false, reason: 'nothing in hand to place', distanceUnits: distance, stuckAt: null, failedStep: step };
      if (target.kind === 'fixture' && target.openness < 0.5) {
        return { passed: false, reason: `${target.name} is closed`, distanceUnits: distance, stuckAt: null, failedStep: step };
      }
      const held = holding;
      entities = entities.map((e) => (e.id === held ? { ...e, state: 'placed' as const, pos: target.pos, zoneId: target.id } : e));
      holding = null;
    } else if (step.kind === 'open' || step.kind === 'close') {
      if (target.kind !== 'fixture') return { passed: false, reason: `${target.name} cannot be opened`, distanceUnits: distance, stuckAt: null, failedStep: step };
      entities = entities.map((e) => (e.id === target.id ? { ...e, openness: step.kind === 'open' ? 1 : 0 } : e));
    }
  }
  return { passed: true, reason: `${plan.steps.length} steps, ${(distance * cfg.metersPerUnit).toFixed(1)} m travelled`, distanceUnits: distance, stuckAt: null };
}

export function runGauntlet(
  base: Grid,
  entities: Entity[],
  robot: RobotPose,
  taskText: string,
  count: number,
  cfg: TrialConfig = DEFAULT_TRIAL,
  seedBase = 1,
): Variant[] {
  const variants: Variant[] = [];
  for (let i = 0; i < count; i++) {
    const seed = seedBase + i * 7919;
    const layout = i === 0 ? { items: [], clutter: [] } : makeVariantLayout(base, entities, robot, seed, { clutterCount: 2 + (i % 3) });
    const staged = applyLayout(entities, layout);
    const outcome = runTrial(base, staged, robot, taskText, cfg);
    variants.push({
      id: `v${i + 1}`,
      seed,
      label: i === 0 ? 'as-is' : `variant ${i}`,
      passed: outcome.passed,
      reason: outcome.reason,
      distanceM: outcome.distanceUnits * cfg.metersPerUnit,
      layout,
      stuckAt: outcome.stuckAt,
    });
  }
  return variants;
}

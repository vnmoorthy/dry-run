import { test } from 'node:test';
import assert from 'node:assert/strict';
import { astar, buildGrid, cellToWorld, findApproachCell, smoothPath, worldToCell, type Grid } from '../src/sim/grid';
import { planTaskLocal, splitClauses } from '../src/sim/planner';
import { runGauntlet, runTrial } from '../src/sim/evaluate';
import type { Entity, Fixture, Item, RobotPose, Zone } from '../src/sim/types';

/** 20x20 room with a wall down the middle that has a 2-cell gap. */
function roomGrid(): Grid {
  return buildGrid(
    (x, z) => {
      // Walls: x in [4.5, 5.5] except gap near z in [4, 6]
      const wall = x > 4.5 && x < 5.5 && !(z > 4 && z < 6);
      return { hitY: wall ? 2 : 0 };
    },
    { minX: 0, maxX: 10, minZ: 0, maxZ: 10, cell: 0.5, floorY: 0, floorTolerance: 0.35, inflate: 0 },
  );
}

const now = 0;
function item(name: string, x: number, z: number, tags: string[] = []): Item {
  return { id: name.replace(/\s/g, '_'), kind: 'item', name, tags, pos: { x, y: 0, z }, yaw: 0, createdAt: now, shape: 'mug', color: '#fff', size: 0.5, state: 'idle' };
}
function zone(name: string, x: number, z: number, tags: string[] = []): Zone {
  return { id: name, kind: 'zone', name, tags, pos: { x, y: 0, z }, yaw: 0, createdAt: now, radius: 0.9, normal: { x: 0, y: 1, z: 0 } };
}
function drawer(name: string, x: number, z: number, openness = 0): Fixture {
  return { id: name.replace(/\s/g, '_'), kind: 'fixture', name, tags: ['drawer'], pos: { x, y: 0.5, z }, yaw: 0, createdAt: now, fixtureType: 'drawer', normal: { x: 0, y: 0, z: 1 }, openness, width: 1, height: 0.5, depth: 1, travel: 0.6 };
}
const robot: RobotPose = { pos: { x: 1, y: 0, z: 1 }, yaw: 0, state: 'idle', updatedAt: now };

test('astar routes through the gap in the wall, not through it', () => {
  const g = roomGrid();
  const path = astar(g, worldToCell(g, 1, 1), worldToCell(g, 9, 9));
  assert.ok(path, 'path exists');
  const throughGap = path!.some((c) => {
    const w = cellToWorld(g, c);
    return w.x > 4.4 && w.x < 5.6 && w.z > 4 && w.z < 6;
  });
  assert.ok(throughGap, 'path passes through the gap');
  const smooth = smoothPath(g, path!);
  assert.ok(smooth.length <= path!.length);
  assert.ok(smooth.length >= 2);
});

test('astar returns null when the goal is sealed off', () => {
  const g = buildGrid((x) => ({ hitY: x > 4.5 && x < 5.5 ? 2 : 0 }), { minX: 0, maxX: 10, minZ: 0, maxZ: 10, cell: 0.5, floorY: 0, floorTolerance: 0.35, inflate: 0 });
  assert.equal(astar(g, worldToCell(g, 1, 1), worldToCell(g, 9, 9)), null);
});

test('findApproachCell picks a free cell within reach', () => {
  const g = roomGrid();
  const cell = findApproachCell(g, { x: 8, y: 0, z: 8 }, 1.5, { x: 1, y: 0, z: 1 });
  assert.ok(cell);
  const w = cellToWorld(g, cell!);
  assert.ok(Math.hypot(w.x - 8, w.z - 8) <= 1.5);
});

test('planner: put X on Y expands to navigate/pick/navigate/place', () => {
  const entities: Entity[] = [item('red mug', 3, 3, ['cup']), item('blue bottle', 2, 2), zone('shelf', 8, 8, ['storage'])];
  const plan = planTaskLocal('put the red mug on the shelf', entities, robot);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.deepEqual(
    plan.steps.map((s) => `${s.kind}:${s.targetName}`),
    ['navigate:red mug', 'pick:red mug', 'navigate:shelf', 'place:shelf'],
  );
});

test('planner: placing into a closed drawer opens it first; "then close it" resolves the pronoun', () => {
  const entities: Entity[] = [item('red mug', 3, 3), drawer('top drawer', 8, 8)];
  const plan = planTaskLocal('put the mug in the top drawer, then close it', entities, robot);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.deepEqual(
    plan.steps.map((s) => s.kind),
    ['navigate', 'pick', 'navigate', 'open', 'place', 'navigate', 'close'],
  );
});

test('planner: unknown object fails with a helpful reason', () => {
  const plan = planTaskLocal('put the banana on the shelf', [zone('shelf', 8, 8)], robot);
  assert.ok(!plan.ok);
  if (plan.ok) return;
  assert.match(plan.reason, /banana/);
});

test('planner: fetch then "put it" keeps the held item', () => {
  const entities: Entity[] = [item('green book', 3, 3), zone('table', 8, 8)];
  const plan = planTaskLocal('get the green book and put it on the table', entities, robot);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.deepEqual(
    plan.steps.map((s) => s.kind),
    ['navigate', 'pick', 'navigate', 'place'],
  );
});

test('splitClauses handles commas, "then", and "and <verb>"', () => {
  assert.deepEqual(splitClauses('open the drawer, put the mug in it and close it'), ['open the drawer', 'put the mug in it', 'close it']);
});

test('runTrial passes on an open room and fails when the target is walled off', () => {
  const g = roomGrid();
  const entities: Entity[] = [item('red mug', 2, 2), zone('shelf', 8, 8)];
  const ok = runTrial(g, entities, robot, 'put the red mug on the shelf');
  assert.equal(ok.passed, true, ok.reason);
  assert.ok(ok.distanceUnits > 5);
  const sealed = buildGrid((x) => ({ hitY: x > 4.5 && x < 5.5 ? 2 : 0 }), { minX: 0, maxX: 10, minZ: 0, maxZ: 10, cell: 0.5, floorY: 0, floorTolerance: 0.35, inflate: 0 });
  const bad = runTrial(sealed, entities, robot, 'put the red mug on the shelf');
  assert.equal(bad.passed, false);
  assert.match(bad.reason, /no path|blocked|standing room/);
});

test('runGauntlet is deterministic per seed and reports clutter blockers', () => {
  const g = roomGrid();
  const entities: Entity[] = [item('red mug', 2, 2), zone('shelf', 8, 8)];
  const a = runGauntlet(g, entities, robot, 'put the red mug on the shelf', 6);
  const b = runGauntlet(g, entities, robot, 'put the red mug on the shelf', 6);
  assert.deepEqual(
    a.map((v) => [v.passed, v.layout.clutter.length]),
    b.map((v) => [v.passed, v.layout.clutter.length]),
  );
  assert.equal(a[0].label, 'as-is');
  assert.equal(a[0].passed, true);
  for (const v of a.slice(1)) assert.ok(v.layout.clutter.length >= 2);
});

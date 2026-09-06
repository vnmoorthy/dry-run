import { test } from 'node:test';
import assert from 'node:assert/strict';
import { astar, buildGrid, cellToWorld, findApproachCell, smoothPath, worldToCell, type Grid } from '../src/sim/grid';
import { planTaskLocal, splitClauses, stepsFromLlm } from '../src/sim/planner';
import { makeVariantLayout, runGauntlet, runTrial } from '../src/sim/evaluate';
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
  const plan = planTaskLocal('open the top drawer, put the mug in it and close it', [item('red mug', 3, 3), drawer('top drawer', 8, 8)], robot);
  assert.ok(plan.ok, !plan.ok ? plan.reason : '');
  if (!plan.ok) return;
  // The drawer is opened once (by the explicit clause), not again by the place clause.
  assert.deepEqual(
    plan.steps.map((s) => s.kind),
    ['navigate', 'open', 'navigate', 'pick', 'navigate', 'place', 'navigate', 'close'],
  );
});

test('planner: "bring me the mug" and "bring the mug to me" are fetches', () => {
  const entities: Entity[] = [item('red mug', 3, 3), zone('shelf', 8, 8)];
  for (const text of ['bring me the red mug', 'bring the red mug to me', 'hand me the mug', 'grab the mug and bring it to me']) {
    const plan = planTaskLocal(text, entities, robot);
    assert.ok(plan.ok, `${text}: ${!plan.ok ? plan.reason : ''}`);
    if (!plan.ok) continue;
    assert.deepEqual(plan.steps.map((s) => s.kind), ['navigate', 'pick'], text);
  }
});

test('planner: a held item carries over between chores via robot.carrying', () => {
  const entities: Entity[] = [item('red mug', 3, 3), item('blue bottle', 2, 2), zone('table', 8, 8)];
  const carrying: RobotPose = { ...robot, carrying: 'red_mug' };
  const put = planTaskLocal('put the mug on the table', entities, carrying);
  assert.ok(put.ok);
  if (put.ok) assert.deepEqual(put.steps.map((s) => s.kind), ['navigate', 'place']);
  const other = planTaskLocal('get the bottle', entities, carrying);
  assert.ok(!other.ok);
  if (!other.ok) assert.match(other.reason, /holding red mug/);
});

test('planner: conjunctions and plurals move every item', () => {
  const entities: Entity[] = [item('red mug', 3, 3, ['cup']), item('blue mug', 2, 2, ['cup']), item('green book', 4, 4), zone('shelf', 8, 8)];
  const both = planTaskLocal('put the red mug and the green book on the shelf', entities, robot);
  assert.ok(both.ok);
  if (both.ok) assert.equal(both.steps.filter((s) => s.kind === 'place').length, 2);
  const plural = planTaskLocal('put the mugs on the shelf', entities, robot);
  assert.ok(plural.ok, !plural.ok ? plural.reason : '');
  if (plural.ok) assert.equal(plural.steps.filter((s) => s.kind === 'pick').length, 2);
  const ambiguous = planTaskLocal('put the mug on the shelf', entities, robot);
  assert.ok(!ambiguous.ok);
  if (!ambiguous.ok) assert.match(ambiguous.reason, /Which one/);
});

test('planner: fixture state is tracked across clauses', () => {
  const entities: Entity[] = [item('red mug', 3, 3), drawer('top drawer', 8, 8, 1)];
  const plan = planTaskLocal('close the top drawer, then put the mug in the top drawer', entities, robot);
  assert.ok(plan.ok);
  if (plan.ok) assert.deepEqual(plan.steps.map((s) => s.kind), ['navigate', 'close', 'navigate', 'pick', 'navigate', 'open', 'place']);
});

test('stepsFromLlm rejects an empty plan', () => {
  assert.deepEqual(stepsFromLlm([], [item('red mug', 3, 3)]), { error: 'empty plan' });
});

test('makeVariantLayout keeps clutter off items, zones and fixtures', () => {
  const g = roomGrid();
  const entities: Entity[] = [item('red mug', 2, 2), zone('shelf', 8, 8), drawer('top drawer', 8, 2)];
  for (let seed = 1; seed < 40; seed++) {
    const layout = makeVariantLayout(g, entities, robot, seed, { clutterCount: 3 });
    const positions = [...layout.items.map((i) => i.pos), ...entities.filter((e) => e.kind !== 'item').map((e) => e.pos)];
    for (const c of layout.clutter) {
      for (const p of positions) assert.ok(Math.hypot(p.x - c.x, p.z - c.z) >= 1.0, `seed ${seed}: clutter on an entity`);
    }
  }
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

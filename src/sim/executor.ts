/**
 * Executor: claims queued chores from the store, plans them, and drives the
 * robot through every step in the 3D twin. Every transition is written back
 * to the store so the projector, the judges' phones and the Convex dashboard
 * see the same ledger flip queued -> doing -> done at the same moment.
 */

import * as THREE from 'three';
import type { Store } from '../data/store';
import type { Robot } from '../robot/robot';
import type { RoomView } from '../app/room';
import type { WorldHandles } from '../world/world';
import type { Sfx } from '../app/sfx';
import { astar, cellToWorld, findApproachCell, smoothPath } from './grid';
import { findBlocker, gridWithEntities, startCellFor, DEFAULT_TRIAL, type TrialConfig } from './evaluate';
import { planTaskLocal, stepsFromLlm } from './planner';
import type { Entity, Fixture, Item, RobotPose, Step, Task, Vec3 } from './types';

export interface ExecutorDeps {
  store: Store;
  world: WorldHandles;
  robot: Robot;
  room: RoomView;
  sfx?: Sfx;
  trial?: TrialConfig;
  /** Called with the path the robot is about to drive (for the on-floor ribbon). */
  onPath?: (points: Vec3[] | null) => void;
}

class StepFailure extends Error {
  constructor(
    message: string,
    readonly stuckAt: Vec3 | null = null,
  ) {
    super(message);
  }
}

export class Executor {
  private busy = false;
  private arrival: (() => void) | null = null;
  private turned: (() => void) | null = null;
  private lastPoseWrite = 0;
  private aborted = false;
  private heldObj: THREE.Object3D | null = null;
  private heldId: string | null = null;
  private trial: TrialConfig;
  currentTaskId: string | null = null;

  constructor(private deps: ExecutorDeps) {
    this.trial = deps.trial ?? DEFAULT_TRIAL;
    // A reload mid-chore leaves tasks stranded in planning/running; close them out honestly.
    for (const t of deps.store.getState().tasks) {
      if (t.status === 'running' || t.status === 'planning') {
        void deps.store.updateTask(t.id, {
          status: 'fail',
          endedAt: Date.now(),
          steps: t.steps.map((s) => (s.status === 'doing' ? { ...s, status: 'failed', note: 'interrupted' } : s)),
          result: { passed: false, reason: 'interrupted (page reloaded)', distanceM: 0, durationMs: 0 },
        });
      }
    }
    deps.store.subscribe(() => this.maybeStart());
  }

  get isBusy(): boolean {
    return this.busy;
  }

  abort(): void {
    this.aborted = true;
    this.deps.robot.stop();
    this.arrival?.();
    this.turned?.();
  }

  /**
   * Per-frame: move the robot, resolve waits, throttle pose writes.
   * Sub-steps at ≤1/50 s so motion stays frame-rate independent on a slow
   * projector laptop (a 5 fps frame still advances the robot the right distance).
   */
  tick(dt: number): void {
    const { robot, world, store } = this.deps;
    const floorAt = (x: number, z: number) => {
      const hit = world.raycastDown(x, z, world.floorY + 2.5, 4);
      return hit && Math.abs(hit.point.y - world.floorY) < 0.6 ? hit.point.y : world.floorY;
    };
    const steps = Math.max(1, Math.min(12, Math.ceil(dt / (1 / 50))));
    const sub = dt / steps;
    for (let i = 0; i < steps; i++) {
      const wasTurning = robot.turning;
      const arrived = robot.update(sub, floorAt);
      if (arrived && this.arrival) {
        const r = this.arrival;
        this.arrival = null;
        r();
      }
      if (wasTurning && !robot.turning && this.turned) {
        const r = this.turned;
        this.turned = null;
        r();
      }
    }
    const now = performance.now();
    if (this.busy && now - this.lastPoseWrite > 250) {
      this.lastPoseWrite = now;
      void store.setRobot(this.pose());
    }
  }

  private pose(): RobotPose {
    const { robot } = this.deps;
    return { pos: robot.pos, yaw: robot.yaw, state: robot.state, carrying: this.heldId, updatedAt: Date.now() };
  }

  private maybeStart(): void {
    if (this.busy) return;
    const queued = this.deps.store
      .getState()
      .tasks.filter((t) => t.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!queued) return;
    void this.run(queued);
  }

  private async run(task: Task): Promise<void> {
    const { store, robot } = this.deps;
    this.busy = true;
    this.aborted = false;
    this.currentTaskId = task.id;
    const startedAt = Date.now();
    const startDistance = robot.distanceTravelled;
    await store.updateTask(task.id, { status: 'planning', startedAt });

    const entities = store.getState().entities;
    let steps: Step[] | null = null;
    let plannerName = 'rule-based planner';
    let failReason: string | null = null;
    if (store.plan) {
      const raw = await store.plan(task.text, entities);
      if (raw) {
        const coerced = stepsFromLlm(raw, entities);
        if ('steps' in coerced) {
          steps = coerced.steps;
          plannerName = 'Claude planner (Convex action)';
        }
      }
    }
    if (!steps) {
      const plan = planTaskLocal(task.text, entities, store.getState().robot);
      if (plan.ok) steps = plan.steps;
      else failReason = plan.reason;
    }
    if (!steps) {
      robot.setState('failed');
      await store.updateTask(task.id, {
        status: 'fail',
        steps: [],
        plannerName,
        endedAt: Date.now(),
        result: { passed: false, reason: failReason ?? 'could not plan', distanceM: 0, durationMs: Date.now() - startedAt },
      });
      this.deps.sfx?.fail();
      await this.finish();
      return;
    }

    await store.updateTask(task.id, { status: 'running', steps, plannerName });
    this.deps.sfx?.start();
    let passed = true;
    let reason = '';
    let stuckAt: Vec3 | null = null;
    for (let i = 0; i < steps.length; i++) {
      if (this.aborted) {
        passed = false;
        reason = 'aborted';
        break;
      }
      const step = steps[i];
      steps = patchStep(steps, i, { status: 'doing', startedAt: Date.now() });
      await store.updateTask(task.id, { steps });
      try {
        const note = await this.execute(step);
        steps = patchStep(steps, i, { status: 'done', endedAt: Date.now(), note });
        await store.updateTask(task.id, { steps });
      } catch (e) {
        const err = e instanceof StepFailure ? e : new StepFailure(String((e as Error)?.message ?? e));
        steps = patchStep(steps, i, { status: 'failed', endedAt: Date.now(), note: err.message });
        for (let j = i + 1; j < steps.length; j++) steps = patchStep(steps, j, { note: 'skipped' });
        await store.updateTask(task.id, { steps });
        passed = false;
        reason = err.message;
        stuckAt = err.stuckAt;
        break;
      }
    }
    const distanceM = (robot.distanceTravelled - startDistance) * this.trial.metersPerUnit;
    const durationMs = Date.now() - startedAt;
    if (passed) reason = `${steps.length} steps · ${distanceM.toFixed(1)} m · ${(durationMs / 1000).toFixed(1)} s`;
    robot.setState(passed ? 'idle' : 'failed');
    if (passed) this.deps.sfx?.pass();
    else this.deps.sfx?.fail();
    await store.updateTask(task.id, {
      status: passed ? 'pass' : 'fail',
      endedAt: Date.now(),
      result: { passed, reason, distanceM, durationMs },
    });
    if (stuckAt) await store.setHeat([...store.getState().heat, stuckAt]);
    await this.finish();
  }

  private async finish(): Promise<void> {
    this.deps.onPath?.(null);
    await this.deps.store.setRobot(this.pose());
    this.busy = false;
    this.currentTaskId = null;
    // Give the LED a beat on the final colour, then go idle.
    setTimeout(() => {
      if (!this.busy) {
        this.deps.robot.setState('idle');
        void this.deps.store.setRobot(this.pose());
      }
    }, 1200);
    // Pick up the next queued chore right away.
    this.maybeStart();
  }

  private target(step: Step): Entity {
    const e = this.deps.room.entity(step.targetId);
    if (!e) throw new StepFailure(`${step.targetName} is no longer in the room`);
    return e;
  }

  /** World-space point the robot must get near for this entity. */
  private interactionPoint(e: Entity): Vec3 {
    if (e.kind === 'fixture') {
      const view = this.deps.room.fixtures.get(e.id);
      return view ? view.handleWorldPos() : e.pos;
    }
    return e.pos;
  }

  private async execute(step: Step): Promise<string> {
    const { robot } = this.deps;
    const target = this.target(step);
    switch (step.kind) {
      case 'navigate':
        return this.navigate(target);
      case 'pick':
        return this.pick(target as Item);
      case 'place':
        return this.place(target);
      case 'open':
      case 'close':
        return this.toggle(target as Fixture, step.kind === 'open');
      default:
        robot.setState('failed');
        throw new StepFailure(`unknown step ${(step as Step).kind}`);
    }
  }

  private async navigate(target: Entity): Promise<string> {
    const { robot, world, room, store, onPath } = this.deps;
    const entities = store.getState().entities.filter((e) => e.id !== this.heldId);
    const grid = gridWithEntities(world.grid, entities, this.trial);
    const point = this.interactionPoint(target);
    const from = robot.pos;
    const startCell = startCellFor(world.grid, grid, from);
    if (!startCell) {
      robot.setState('failed');
      throw new StepFailure('robot is not on drivable floor — use the Robot start tool', from);
    }
    const approach = findApproachCell(grid, point, this.trial.reach * 0.9, from);
    if (!approach) {
      robot.setState('failed');
      throw new StepFailure(`no standing room within ${(this.trial.reach * this.trial.metersPerUnit).toFixed(1)} m of ${target.name}`, point);
    }
    const path = astar(grid, startCell, approach);
    if (!path) {
      robot.setState('failed');
      const blocker = findBlocker(world.grid, entities, from, point, this.trial);
      const mpu = this.trial.metersPerUnit;
      const why = blocker
        ? `blocked by clutter at (${(blocker.x * mpu).toFixed(1)} m, ${(blocker.z * mpu).toFixed(1)} m)`
        : `no path to ${target.name}`;
      throw new StepFailure(why, blocker ?? from);
    }
    const smooth = smoothPath(grid, path);
    const points = smooth.slice(1).map((c) => cellToWorld(grid, c));
    // Land exactly on the approach cell centre so the reach check below is stable.
    if (points.length === 0) points.push(cellToWorld(grid, approach));
    onPath?.([from, ...points]);
    robot.setState('moving');
    robot.setPath(points);
    room.setHighlight(target.id);
    await new Promise<void>((resolve) => {
      this.arrival = resolve;
    });
    if (this.aborted) throw new StepFailure('aborted');
    robot.faceToward(point);
    await new Promise<void>((resolve) => {
      this.turned = resolve;
    });
    onPath?.(null);
    robot.setState('working');
    const d = Math.hypot(robot.pos.x - point.x, robot.pos.z - point.z);
    return `arrived · ${(d * this.trial.metersPerUnit).toFixed(2)} m from ${target.name}`;
  }

  private assertReach(target: Entity): void {
    const p = this.interactionPoint(target);
    const d = Math.hypot(this.deps.robot.pos.x - p.x, this.deps.robot.pos.z - p.z);
    if (d > this.trial.reach + 0.1) {
      this.deps.robot.setState('failed');
      throw new StepFailure(`${target.name} is out of reach (${(d * this.trial.metersPerUnit).toFixed(2)} m)`);
    }
  }

  private async pick(item: Item): Promise<string> {
    const { robot, room, store, sfx } = this.deps;
    if (item.kind !== 'item') throw new StepFailure(`${item.name} cannot be picked up`);
    if (this.heldId) throw new StepFailure(`hands full (holding ${room.entity(this.heldId)?.name ?? 'something'})`);
    if (item.state === 'held') throw new StepFailure(`${item.name} is already held`);
    this.assertReach(item);
    const obj = room.items.get(item.id);
    if (!obj) throw new StepFailure(`${item.name} has not finished loading`);
    robot.setState('working');
    room.locked.add(item.id);
    await robot.reachTo({ x: item.pos.x, y: item.pos.y + item.size * 0.5, z: item.pos.z }, 0.8);
    if (this.aborted) throw new StepFailure('aborted');
    robot.attach(obj);
    this.heldObj = obj;
    this.heldId = item.id;
    sfx?.pick();
    await store.updateEntity(item.id, { state: 'held', heldBy: 'robot', zoneId: null } as Partial<Item>);
    await robot.retract(0.45);
    room.locked.delete(item.id);
    return `holding ${item.name}`;
  }

  private async place(target: Entity): Promise<string> {
    const { robot, room, store, sfx, world } = this.deps;
    if (!this.heldId || !this.heldObj) throw new StepFailure('nothing in hand to place');
    const held = room.entity(this.heldId) as Item | undefined;
    if (!held) throw new StepFailure('lost the held item');
    this.assertReach(target);
    let dest: Vec3;
    let yaw = 0;
    if (target.kind === 'fixture') {
      if (target.openness < 0.5) throw new StepFailure(`${target.name} is closed`);
      const view = room.fixtures.get(target.id);
      dest = view ? view.interiorWorldPos() : target.pos;
    } else if (target.kind === 'zone') {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * target.radius * 0.45;
      dest = { x: target.pos.x + Math.cos(a) * r, y: target.pos.y, z: target.pos.z + Math.sin(a) * r };
      const hit = world.raycastDown(dest.x, dest.z, dest.y + 1.5, 3);
      if (hit && hit.normal.y > 0.7) dest.y = hit.point.y;
      yaw = Math.random() * Math.PI * 2;
    } else {
      // Next to another item.
      const away = Math.atan2(target.pos.x - robot.pos.x, target.pos.z - robot.pos.z) + Math.PI / 2;
      dest = { x: target.pos.x + Math.sin(away) * 0.7, y: target.pos.y, z: target.pos.z + Math.cos(away) * 0.7 };
    }
    robot.setState('working');
    room.locked.add(held.id);
    await robot.reachTo({ x: dest.x, y: dest.y + held.size * 0.5, z: dest.z }, 0.8);
    if (this.aborted) throw new StepFailure('aborted');
    robot.detach(this.heldObj, dest, room.group, yaw);
    sfx?.place();
    const placedId = held.id;
    this.heldObj = null;
    this.heldId = null;
    await store.updateEntity(placedId, { state: 'placed', heldBy: null, pos: dest, yaw, zoneId: target.id } as Partial<Item>);
    await robot.retract(0.45);
    room.locked.delete(placedId);
    return `placed in ${target.name}`;
  }

  private async toggle(fixture: Fixture, open: boolean): Promise<string> {
    const { robot, room, store, sfx } = this.deps;
    if (fixture.kind !== 'fixture') throw new StepFailure(`${fixture.name} cannot be ${open ? 'opened' : 'closed'}`);
    this.assertReach(fixture);
    const view = room.fixtures.get(fixture.id);
    if (!view) throw new StepFailure(`${fixture.name} has not finished loading`);
    robot.setState('working');
    await robot.reachTo(view.handleWorldPos(), 0.8);
    if (this.aborted) throw new StepFailure('aborted');
    if (open) sfx?.open();
    else sfx?.close();
    await room.animateFixture(fixture.id, open ? 1 : 0, 0.9);
    await store.updateEntity(fixture.id, { openness: open ? 1 : 0 } as Partial<Fixture>);
    await robot.retract(0.45);
    return `${fixture.name} ${open ? 'open' : 'closed'} (${fixture.fixtureType === 'drawer' ? 'prismatic' : 'revolute'} joint)`;
  }
}

function patchStep(steps: Step[], i: number, patch: Partial<Step>): Step[] {
  return steps.map((s, j) => (j === i ? { ...s, ...patch } : s));
}

/**
 * Room state store with two interchangeable backends.
 *
 *  - LocalStore : in-memory + localStorage + BroadcastChannel. Works with no
 *                 network at all (the fallback path for a dead venue Wi-Fi) and
 *                 syncs every tab of the same browser.
 *  - ConvexStore: the real thing. One reactive query (`room.getState`) feeds
 *                 every screen — projector, judges' phones, the dashboard —
 *                 and every mutation is a Convex mutation. The 4 Hz robot pose
 *                 is a separate small query so heartbeats never re-run the big one.
 *
 * The 3D executor and the phone ledger only talk to this interface.
 */

import type { Entity, Gauntlet, RobotPose, RoomState, Task, Vec3, WorldInfo } from '../sim/types';
import { DEFAULT_WORLD, newId } from '../sim/types';

export interface Store {
  readonly mode: 'local' | 'convex';
  readonly clientId: string;
  readonly roomSlug: string;
  ready(): Promise<void>;
  getState(): RoomState;
  subscribe(cb: (s: RoomState) => void): () => void;
  addEntity(e: Entity): Promise<void>;
  updateEntity(id: string, patch: Partial<Entity>): Promise<void>;
  removeEntity(id: string): Promise<void>;
  setRobot(pose: RobotPose): Promise<void>;
  submitTask(text: string, source: string): Promise<string>;
  updateTask(id: string, patch: Partial<Task>): Promise<void>;
  addGauntlet(g: Gauntlet): Promise<void>;
  updateGauntlet(id: string, patch: Partial<Gauntlet>): Promise<void>;
  setHeat(points: Vec3[]): Promise<void>;
  /** Swapping the world empties the room (old entities would sit inside the new walls). */
  setWorld(world: WorldInfo): Promise<void>;
  reset(entities: Entity[], robot: RobotPose): Promise<void>;
  /** Optional server-side (LLM) planner; returns null when unavailable or when it produced no steps. */
  plan?(text: string, entities: Entity[]): Promise<{ kind: string; target: string }[] | null>;
}

export const DEFAULT_ROBOT: RobotPose = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, state: 'idle', carrying: null, updatedAt: 0 };

export function emptyState(world: WorldInfo = DEFAULT_WORLD): RoomState {
  return { entities: [], robot: { ...DEFAULT_ROBOT }, tasks: [], gauntlets: [], heat: [], world, version: 0 };
}

export function roomSlugFromUrl(): string {
  const p = new URLSearchParams(location.search);
  return (p.get('room') || 'demo').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'demo';
}

const MAX_TASKS = 30;
const MAX_GAUNTLETS = 6;

/* ------------------------------------------------------------------------ */
/* LocalStore                                                                */
/* ------------------------------------------------------------------------ */

type Msg = { type: 'state'; state: RoomState; from: string };

export class LocalStore implements Store {
  readonly mode = 'local' as const;
  readonly clientId = newId('c');
  private state: RoomState;
  private subs = new Set<(s: RoomState) => void>();
  private channel: BroadcastChannel | null = null;
  private key: string;

  constructor(readonly roomSlug: string) {
    this.key = `dryrun:room:${roomSlug}`;
    this.state = this.load() ?? emptyState();
    try {
      this.channel = new BroadcastChannel(`dryrun:${roomSlug}`);
      this.channel.onmessage = (ev: MessageEvent<Msg>) => {
        const m = ev.data;
        if (!m || m.type !== 'state' || m.from === this.clientId) return;
        if (m.state.version <= this.state.version) return;
        this.state = m.state;
        this.notify();
      };
    } catch {
      this.channel = null;
    }
    window.addEventListener('storage', (ev) => {
      if (ev.key !== this.key || !ev.newValue) return;
      try {
        const s = JSON.parse(ev.newValue) as RoomState;
        if (s.version > this.state.version) {
          this.state = s;
          this.notify();
        }
      } catch {
        /* ignore */
      }
    });
  }

  async ready(): Promise<void> {}

  getState(): RoomState {
    return this.state;
  }

  subscribe(cb: (s: RoomState) => void): () => void {
    this.subs.add(cb);
    cb(this.state);
    return () => this.subs.delete(cb);
  }

  private load(): RoomState | null {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return null;
      const s = JSON.parse(raw) as RoomState;
      if (!s || !Array.isArray(s.entities)) return null;
      return s;
    } catch {
      return null;
    }
  }

  /**
   * localStorage is the serialization point: re-read the latest state before
   * applying the update so two tabs committing at once never swap states.
   */
  private commit(update: (s: RoomState) => RoomState): void {
    const latest = this.load();
    if (latest && latest.version > this.state.version) this.state = latest;
    const next = update(this.state);
    next.version = this.state.version + 1;
    this.state = next;
    try {
      localStorage.setItem(this.key, JSON.stringify(next));
    } catch {
      /* quota — ignore */
    }
    this.channel?.postMessage({ type: 'state', state: next, from: this.clientId } satisfies Msg);
    this.notify();
  }

  private notify(): void {
    for (const cb of this.subs) cb(this.state);
  }

  async addEntity(e: Entity): Promise<void> {
    this.commit((s) => ({ ...s, entities: [...s.entities.filter((x) => x.id !== e.id), e] }));
  }

  async updateEntity(id: string, patch: Partial<Entity>): Promise<void> {
    this.commit((s) => ({ ...s, entities: s.entities.map((e) => (e.id === id ? ({ ...e, ...patch } as Entity) : e)) }));
  }

  async removeEntity(id: string): Promise<void> {
    this.commit((s) => ({ ...s, entities: s.entities.filter((e) => e.id !== id) }));
  }

  async setRobot(pose: RobotPose): Promise<void> {
    this.commit((s) => ({ ...s, robot: pose }));
  }

  async submitTask(text: string, source: string): Promise<string> {
    const task: Task = { id: newId('t'), text, status: 'queued', steps: [], createdAt: Date.now(), source };
    this.commit((s) => ({ ...s, tasks: [...s.tasks, task].slice(-MAX_TASKS) }));
    return task.id;
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<void> {
    this.commit((s) => ({ ...s, tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  }

  async addGauntlet(g: Gauntlet): Promise<void> {
    this.commit((s) => ({ ...s, gauntlets: [...s.gauntlets, g].slice(-MAX_GAUNTLETS) }));
  }

  async updateGauntlet(id: string, patch: Partial<Gauntlet>): Promise<void> {
    this.commit((s) => ({ ...s, gauntlets: s.gauntlets.map((g) => (g.id === id ? { ...g, ...patch } : g)) }));
  }

  async setHeat(points: Vec3[]): Promise<void> {
    this.commit((s) => ({ ...s, heat: points.slice(-200) }));
  }

  async setWorld(world: WorldInfo): Promise<void> {
    this.commit((s) => ({ ...s, world, entities: [], tasks: [], gauntlets: [], heat: [], robot: { ...DEFAULT_ROBOT } }));
  }

  async reset(entities: Entity[], robot: RobotPose): Promise<void> {
    this.commit((s) => ({ ...s, entities, robot, tasks: [], gauntlets: [], heat: [] }));
  }
}

/* ------------------------------------------------------------------------ */
/* ConvexStore                                                               */
/* ------------------------------------------------------------------------ */

export class ConvexStore implements Store {
  readonly mode = 'convex' as const;
  readonly clientId = newId('c');
  private state: RoomState = emptyState();
  private subs = new Set<(s: RoomState) => void>();
  private client: import('convex/browser').ConvexClient | null = null;
  private api: any = null;
  private readyPromise: Promise<void>;
  private robot: RobotPose = { ...DEFAULT_ROBOT };

  constructor(readonly roomSlug: string, private url: string) {
    this.readyPromise = this.init();
  }

  private async init(): Promise<void> {
    const [{ ConvexClient }, { anyApi }] = await Promise.all([import('convex/browser'), import('convex/server')]);
    this.client = new ConvexClient(this.url);
    this.api = anyApi;
    await this.client.mutation(this.api.room.ensure, { slug: this.roomSlug, world: DEFAULT_WORLD });
    // Robot pose: small, hot, separate query.
    this.client.onUpdate(this.api.room.getRobot, { slug: this.roomSlug }, (pose: RobotPose | null) => {
      if (!pose) return;
      this.robot = pose;
      this.state = { ...this.state, robot: pose };
      this.notify();
    });
    await new Promise<void>((resolve) => {
      let first = true;
      this.client!.onUpdate(this.api.room.getState, { slug: this.roomSlug }, (s: RoomState | null) => {
        if (s) {
          this.state = { ...s, robot: this.robot };
          this.notify();
        }
        if (first) {
          first = false;
          resolve();
        }
      });
    });
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  getState(): RoomState {
    return this.state;
  }

  subscribe(cb: (s: RoomState) => void): () => void {
    this.subs.add(cb);
    cb(this.state);
    return () => this.subs.delete(cb);
  }

  private notify(): void {
    for (const cb of this.subs) cb(this.state);
  }

  private async call(name: string, args: Record<string, unknown>): Promise<any> {
    await this.readyPromise;
    const [mod, fn] = name.split('.');
    return this.client!.mutation(this.api[mod][fn], { slug: this.roomSlug, ...args });
  }

  addEntity(e: Entity): Promise<void> {
    return this.call('entities.add', { entity: e });
  }
  updateEntity(id: string, patch: Partial<Entity>): Promise<void> {
    return this.call('entities.update', { id, patch });
  }
  removeEntity(id: string): Promise<void> {
    return this.call('entities.remove', { id });
  }
  setRobot(pose: RobotPose): Promise<void> {
    this.robot = pose;
    return this.call('robot.set', { pose });
  }
  async submitTask(text: string, source: string): Promise<string> {
    return (await this.call('tasks.submit', { text, source })) as string;
  }
  updateTask(id: string, patch: Partial<Task>): Promise<void> {
    return this.call('tasks.update', { id, patch });
  }
  addGauntlet(g: Gauntlet): Promise<void> {
    return this.call('gauntlets.add', { gauntlet: g });
  }
  updateGauntlet(id: string, patch: Partial<Gauntlet>): Promise<void> {
    return this.call('gauntlets.update', { id, patch });
  }
  setHeat(points: Vec3[]): Promise<void> {
    return this.call('room.setHeat', { heat: points.slice(-200) });
  }
  setWorld(world: WorldInfo): Promise<void> {
    return this.call('room.setWorld', { world });
  }
  reset(entities: Entity[], robot: RobotPose): Promise<void> {
    return this.call('room.reset', { entities, robot });
  }

  async plan(text: string, entities: Entity[]): Promise<{ kind: string; target: string }[] | null> {
    await this.readyPromise;
    try {
      const res = await this.client!.action(this.api.planner.plan, {
        text,
        entities: entities.map((e) => ({ id: e.id, kind: e.kind, name: e.name, tags: e.tags })),
      });
      const steps = res?.steps;
      if (!Array.isArray(steps) || steps.length === 0) {
        console.warn('LLM planner declined or unavailable:', res?.reason ?? 'empty plan');
        return null;
      }
      return steps;
    } catch (e) {
      console.warn('LLM planner unavailable, using the rule-based planner', e);
      return null;
    }
  }
}

export function createStore(): Store {
  const slug = roomSlugFromUrl();
  const url = (import.meta as any).env?.VITE_CONVEX_URL as string | undefined;
  const forceLocal = new URLSearchParams(location.search).get('local') === '1';
  if (url && !forceLocal) return new ConvexStore(slug, url);
  return new LocalStore(slug);
}

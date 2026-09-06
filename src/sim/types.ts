/**
 * Shared domain types for Dry Run.
 *
 * Everything the 3D executor, the phone ledger, the headless evaluator and the
 * Convex backend agree on lives here. Keep this file dependency-free so it can
 * be imported from Node tests and from `convex/` alike.
 */

export type Vec3 = { x: number; y: number; z: number };

export type EntityKind = 'item' | 'fixture' | 'zone';
export type FixtureType = 'drawer' | 'door';
export type ItemState = 'idle' | 'held' | 'placed';

export interface EntityBase {
  id: string;
  kind: EntityKind;
  /** Human name used by the planner ("red mug", "top drawer", "shelf"). */
  name: string;
  /** Extra planner vocabulary ("cup", "coffee"). */
  tags: string[];
  pos: Vec3;
  /** Yaw in radians around +Y. */
  yaw: number;
  createdBy?: string;
  createdAt: number;
}

export interface Item extends EntityBase {
  kind: 'item';
  /** Procedural prop shape key or a GLB key from the asset manifest. */
  shape: string;
  color: string;
  /** Approximate height in world units (drives prop scale). */
  size: number;
  state: ItemState;
  heldBy?: string | null;
  zoneId?: string | null;
  /** Temporary evaluation clutter (Gauntlet) — removed on reset. */
  clutter?: boolean;
}

export interface Fixture extends EntityBase {
  kind: 'fixture';
  fixtureType: FixtureType;
  /** Outward-facing surface normal where the fixture was placed. */
  normal: Vec3;
  /** 0 = closed, 1 = fully open. */
  openness: number;
  width: number;
  height: number;
  depth: number;
  /** Drawer travel (world units) or door swing (radians). */
  travel: number;
}

export interface Zone extends EntityBase {
  kind: 'zone';
  radius: number;
  normal: Vec3;
}

export type Entity = Item | Fixture | Zone;

export type StepKind = 'navigate' | 'pick' | 'place' | 'open' | 'close';
export type StepStatus = 'queued' | 'doing' | 'done' | 'failed';

export interface Step {
  id: string;
  kind: StepKind;
  targetId: string;
  targetName: string;
  status: StepStatus;
  startedAt?: number;
  endedAt?: number;
  note?: string;
}

export type TaskStatus = 'queued' | 'planning' | 'running' | 'pass' | 'fail';

export interface TaskResult {
  passed: boolean;
  reason: string;
  distanceM: number;
  durationMs: number;
}

export interface Task {
  id: string;
  text: string;
  status: TaskStatus;
  steps: Step[];
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  result?: TaskResult;
  plannerName?: string;
  /** Which screen submitted it ("projector", "phone"). */
  source?: string;
  /** Item positions when the chore started — the Gauntlet's baseline layout. */
  layoutBefore?: { id: string; pos: Vec3 }[];
}

export type RobotState = 'idle' | 'moving' | 'working' | 'failed';

export interface RobotPose {
  pos: Vec3;
  yaw: number;
  state: RobotState;
  carrying?: string | null;
  updatedAt: number;
}

export interface VariantLayout {
  items: { id: string; pos: Vec3 }[];
  clutter: Vec3[];
}

export interface Variant {
  id: string;
  seed: number;
  label: string;
  /** null while running. */
  passed: boolean | null;
  reason?: string;
  distanceM?: number;
  layout: VariantLayout;
  /** Where the rehearsal got stuck, if it did. */
  stuckAt?: Vec3 | null;
}

export interface Gauntlet {
  id: string;
  taskText: string;
  status: 'running' | 'done';
  variants: Variant[];
  createdAt: number;
}

export interface WorldInfo {
  name: string;
  splatUrl: string;
  colliderUrl: string;
  /** Uniform scale applied to both the splat and the collider. */
  scale: number;
  /** Real-world meters per world unit (after scale). */
  metersPerUnit: number;
  /** One-line provenance shown in the receipts panel. */
  provenance: string;
}

export interface RoomState {
  entities: Entity[];
  robot: RobotPose;
  tasks: Task[];
  gauntlets: Gauntlet[];
  /** Failure heat points painted on the floor. */
  heat: Vec3[];
  world: WorldInfo;
  version: number;
}

/** Provenance for every generated asset (public/assets/manifest.json). */
export interface AssetManifest {
  world?: {
    name: string;
    splatUrl: string;
    colliderUrl: string;
    scale?: number;
    metersPerUnit?: number;
    provider: 'worldlabs' | 'mint' | 'starter';
    model?: string;
    worldId?: string;
    marbleUrl?: string;
    inputs?: string;
    generatedAt?: string;
    credits?: number;
    note?: string;
  };
  robot?: {
    glbUrl: string;
    provider: 'tripo' | 'mint' | 'procedural';
    model?: string;
    taskIds?: string[];
    rig?: string;
    clips?: { idle?: string; walk?: string };
    credits?: number;
    heightUnits?: number;
    note?: string;
  };
  props?: {
    key: string;
    name: string;
    glbUrl: string;
    provider: 'tripo' | 'mint';
    id?: string;
    tags?: string[];
    heightUnits?: number;
  }[];
  audio?: { key: string; url: string; provider: 'mint'; id?: string }[];
}

export const DEFAULT_WORLD: WorldInfo = {
  name: 'Attic (starter world)',
  splatUrl: '/attic.spz',
  colliderUrl: '/collider.glb',
  scale: 5,
  metersPerUnit: 0.4,
  provenance:
    'World Labs Marble world + collider from icurtis1/third-person-controller-splat (starter, disclosed). Replace with your own via scripts/worldlabs-generate.mjs.',
};

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function dist2d(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

let idCounter = 0;
export function newId(prefix = 'e'): string {
  idCounter += 1;
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

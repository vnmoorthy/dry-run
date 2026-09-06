import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export const vec3 = v.object({ x: v.number(), y: v.number(), z: v.number() });

const entityBase = {
  id: v.string(),
  name: v.string(),
  tags: v.array(v.string()),
  pos: vec3,
  yaw: v.number(),
  createdBy: v.optional(v.string()),
  createdAt: v.number(),
};

export const entity = v.union(
  v.object({
    ...entityBase,
    kind: v.literal('item'),
    shape: v.string(),
    color: v.string(),
    size: v.number(),
    state: v.union(v.literal('idle'), v.literal('held'), v.literal('placed')),
    heldBy: v.optional(v.union(v.string(), v.null())),
    zoneId: v.optional(v.union(v.string(), v.null())),
    clutter: v.optional(v.boolean()),
  }),
  v.object({
    ...entityBase,
    kind: v.literal('fixture'),
    fixtureType: v.union(v.literal('drawer'), v.literal('door')),
    normal: vec3,
    openness: v.number(),
    width: v.number(),
    height: v.number(),
    depth: v.number(),
    travel: v.number(),
  }),
  v.object({
    ...entityBase,
    kind: v.literal('zone'),
    radius: v.number(),
    normal: vec3,
  }),
);

export const step = v.object({
  id: v.string(),
  kind: v.union(v.literal('navigate'), v.literal('pick'), v.literal('place'), v.literal('open'), v.literal('close')),
  targetId: v.string(),
  targetName: v.string(),
  status: v.union(v.literal('queued'), v.literal('doing'), v.literal('done'), v.literal('failed')),
  startedAt: v.optional(v.number()),
  endedAt: v.optional(v.number()),
  note: v.optional(v.string()),
});

export const taskStatus = v.union(v.literal('queued'), v.literal('planning'), v.literal('running'), v.literal('pass'), v.literal('fail'));

export const taskResult = v.object({ passed: v.boolean(), reason: v.string(), distanceM: v.number(), durationMs: v.number() });

export const robotPose = v.object({
  pos: vec3,
  yaw: v.number(),
  state: v.union(v.literal('idle'), v.literal('moving'), v.literal('working'), v.literal('failed')),
  carrying: v.optional(v.union(v.string(), v.null())),
  updatedAt: v.number(),
});

export const variant = v.object({
  id: v.string(),
  seed: v.number(),
  label: v.string(),
  passed: v.union(v.boolean(), v.null()),
  reason: v.optional(v.string()),
  distanceM: v.optional(v.number()),
  layout: v.object({ items: v.array(v.object({ id: v.string(), pos: vec3 })), clutter: v.array(vec3) }),
  stuckAt: v.optional(v.union(vec3, v.null())),
});

export const worldInfo = v.object({
  name: v.string(),
  splatUrl: v.string(),
  colliderUrl: v.string(),
  scale: v.number(),
  metersPerUnit: v.number(),
  provenance: v.string(),
});

export default defineSchema({
  rooms: defineTable({
    slug: v.string(),
    world: worldInfo,
    heat: v.array(vec3),
    version: v.number(),
  }).index('by_slug', ['slug']),

  /** Hot 4 Hz robot pose, kept out of `rooms` so heartbeats never re-run `getState`. */
  robots: defineTable({
    roomId: v.id('rooms'),
    pose: robotPose,
  }).index('by_room', ['roomId']),

  entities: defineTable({
    roomId: v.id('rooms'),
    entityId: v.string(),
    data: entity,
  })
    .index('by_room', ['roomId'])
    .index('by_room_entity', ['roomId', 'entityId']),

  tasks: defineTable({
    roomId: v.id('rooms'),
    taskId: v.string(),
    text: v.string(),
    status: taskStatus,
    steps: v.array(step),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    result: v.optional(taskResult),
    plannerName: v.optional(v.string()),
    source: v.optional(v.string()),
    /** Item positions when the chore started — the Gauntlet's baseline layout. */
    layoutBefore: v.optional(v.array(v.object({ id: v.string(), pos: vec3 }))),
  })
    .index('by_room', ['roomId', 'createdAt'])
    .index('by_room_task', ['roomId', 'taskId']),

  gauntlets: defineTable({
    roomId: v.id('rooms'),
    gauntletId: v.string(),
    taskText: v.string(),
    status: v.union(v.literal('running'), v.literal('done')),
    variants: v.array(variant),
    createdAt: v.number(),
  })
    .index('by_room', ['roomId', 'createdAt'])
    .index('by_room_gauntlet', ['roomId', 'gauntletId']),

  /** Sponsor generation jobs (World Labs / Tripo / Mint) with live progress. */
  jobs: defineTable({
    roomId: v.optional(v.id('rooms')),
    provider: v.union(v.literal('worldlabs'), v.literal('tripo'), v.literal('mint'), v.literal('anthropic')),
    kind: v.string(),
    status: v.union(v.literal('queued'), v.literal('generating'), v.literal('downloading'), v.literal('ready'), v.literal('errored')),
    externalId: v.optional(v.string()),
    progress: v.optional(v.number()),
    storageId: v.optional(v.id('_storage')),
    url: v.optional(v.string()),
    error: v.optional(v.string()),
    meta: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_room', ['roomId', 'createdAt']),
});

import { v } from 'convex/values';
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { entity, robotPose, vec3, worldInfo } from './schema';

const DEFAULT_ROBOT = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, state: 'idle' as const, carrying: null, updatedAt: 0 };

export async function roomBySlug(ctx: QueryCtx | MutationCtx, slug: string): Promise<Doc<'rooms'> | null> {
  return ctx.db
    .query('rooms')
    .withIndex('by_slug', (q) => q.eq('slug', slug))
    .unique();
}

export async function requireRoom(ctx: QueryCtx | MutationCtx, slug: string): Promise<Doc<'rooms'>> {
  const room = await roomBySlug(ctx, slug);
  if (!room) throw new Error(`room ${slug} does not exist — call room.ensure first`);
  return room;
}

async function clearRoom(ctx: MutationCtx, roomId: Id<'rooms'>): Promise<void> {
  for (const table of ['entities', 'tasks', 'gauntlets'] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex('by_room', (q) => q.eq('roomId', roomId))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
  }
}

async function writeRobot(ctx: MutationCtx, roomId: Id<'rooms'>, pose: Doc<'robots'>['pose']): Promise<void> {
  const row = await ctx.db
    .query('robots')
    .withIndex('by_room', (q) => q.eq('roomId', roomId))
    .unique();
  if (row) await ctx.db.patch(row._id, { pose });
  else await ctx.db.insert('robots', { roomId, pose });
}

/** Create the room if needed; idempotent. */
export const ensure = mutation({
  args: { slug: v.string(), world: worldInfo },
  handler: async (ctx, { slug, world }) => {
    const existing = await roomBySlug(ctx, slug);
    if (existing) return existing._id;
    const id = await ctx.db.insert('rooms', { slug, world, heat: [], version: 0 });
    await ctx.db.insert('robots', { roomId: id, pose: DEFAULT_ROBOT });
    return id;
  },
});

/** One reactive query feeds every screen: projector, phones, dashboard viewers. */
export const getState = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const room = await roomBySlug(ctx, slug);
    if (!room) return null;
    const [entities, tasks, gauntlets] = await Promise.all([
      ctx.db
        .query('entities')
        .withIndex('by_room', (q) => q.eq('roomId', room._id))
        .collect(),
      ctx.db
        .query('tasks')
        .withIndex('by_room', (q) => q.eq('roomId', room._id))
        .order('desc')
        .take(30),
      ctx.db
        .query('gauntlets')
        .withIndex('by_room', (q) => q.eq('roomId', room._id))
        .order('desc')
        .take(6),
    ]);
    return {
      entities: entities.map((e) => e.data),
      // The live pose comes from `getRobot`; this placeholder keeps the shape identical to RoomState.
      robot: DEFAULT_ROBOT,
      tasks: tasks.map((t) => ({
        id: t.taskId,
        text: t.text,
        status: t.status,
        steps: t.steps,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        result: t.result,
        plannerName: t.plannerName,
        source: t.source,
        layoutBefore: t.layoutBefore,
      })),
      gauntlets: gauntlets.map((g) => ({ id: g.gauntletId, taskText: g.taskText, status: g.status, variants: g.variants, createdAt: g.createdAt })),
      heat: room.heat,
      world: room.world,
      version: room.version,
    };
  },
});

/** Small hot query: the robot pose (≈4 Hz while a chore runs). */
export const getRobot = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const room = await roomBySlug(ctx, slug);
    if (!room) return null;
    const row = await ctx.db
      .query('robots')
      .withIndex('by_room', (q) => q.eq('roomId', room._id))
      .unique();
    return row?.pose ?? DEFAULT_ROBOT;
  },
});

export const setHeat = mutation({
  args: { slug: v.string(), heat: v.array(vec3) },
  handler: async (ctx, { slug, heat }) => {
    const room = await requireRoom(ctx, slug);
    await ctx.db.patch(room._id, { heat: heat.slice(-200), version: room.version + 1 });
  },
});

/** Swapping the world empties the room: the old layout would sit inside the new walls. */
export const setWorld = mutation({
  args: { slug: v.string(), world: worldInfo },
  handler: async (ctx, { slug, world }) => {
    const room = await requireRoom(ctx, slug);
    await clearRoom(ctx, room._id);
    await writeRobot(ctx, room._id, DEFAULT_ROBOT);
    await ctx.db.patch(room._id, { world, heat: [], version: room.version + 1 });
  },
});

/** Called by the World Labs job once the splat + collider are in file storage. */
export const applyWorld = internalMutation({
  args: { slug: v.string(), world: worldInfo },
  handler: async (ctx, { slug, world }) => {
    const room = await requireRoom(ctx, slug);
    await clearRoom(ctx, room._id);
    await writeRobot(ctx, room._id, DEFAULT_ROBOT);
    await ctx.db.patch(room._id, { world, heat: [], version: room.version + 1 });
  },
});

/** Visible "Reset" button: restore a seed layout and clear the ledger, atomically. */
export const reset = mutation({
  args: { slug: v.string(), entities: v.array(entity), robot: robotPose },
  handler: async (ctx, { slug, entities, robot }) => {
    const room = await requireRoom(ctx, slug);
    await clearRoom(ctx, room._id);
    for (const e of entities) await ctx.db.insert('entities', { roomId: room._id, entityId: e.id, data: e });
    await writeRobot(ctx, room._id, robot);
    await ctx.db.patch(room._id, { heat: [], version: room.version + 1 });
  },
});

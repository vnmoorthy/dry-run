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

export async function bump(ctx: MutationCtx, roomId: Id<'rooms'>): Promise<void> {
  const room = await ctx.db.get(roomId);
  if (room) await ctx.db.patch(roomId, { version: room.version + 1 });
}

/** Create the room if needed; idempotent. */
export const ensure = mutation({
  args: { slug: v.string(), world: worldInfo },
  handler: async (ctx, { slug, world }) => {
    const existing = await roomBySlug(ctx, slug);
    if (existing) return existing._id;
    return ctx.db.insert('rooms', { slug, world, heat: [], robot: DEFAULT_ROBOT, version: 0 });
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
      robot: room.robot,
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
      })),
      gauntlets: gauntlets.map((g) => ({ id: g.gauntletId, taskText: g.taskText, status: g.status, variants: g.variants, createdAt: g.createdAt })),
      heat: room.heat,
      world: room.world,
      version: room.version,
    };
  },
});

export const setHeat = mutation({
  args: { slug: v.string(), heat: v.array(vec3) },
  handler: async (ctx, { slug, heat }) => {
    const room = await requireRoom(ctx, slug);
    await ctx.db.patch(room._id, { heat: heat.slice(-200), version: room.version + 1 });
  },
});

export const setWorld = mutation({
  args: { slug: v.string(), world: worldInfo },
  handler: async (ctx, { slug, world }) => {
    const room = await requireRoom(ctx, slug);
    await ctx.db.patch(room._id, { world, version: room.version + 1 });
  },
});

/** Called by the World Labs job once the splat + collider are in file storage. */
export const applyWorld = internalMutation({
  args: { slug: v.string(), world: worldInfo },
  handler: async (ctx, { slug, world }) => {
    const room = await requireRoom(ctx, slug);
    await ctx.db.patch(room._id, { world, version: room.version + 1 });
  },
});

/** Visible "Reset" button: restore a seed layout and clear the ledger, atomically. */
export const reset = mutation({
  args: { slug: v.string(), entities: v.array(entity), robot: robotPose },
  handler: async (ctx, { slug, entities, robot }) => {
    const room = await requireRoom(ctx, slug);
    for (const table of ['entities', 'tasks', 'gauntlets'] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_room', (q) => q.eq('roomId', room._id))
        .collect();
      for (const r of rows) await ctx.db.delete(r._id);
    }
    for (const e of entities) await ctx.db.insert('entities', { roomId: room._id, entityId: e.id, data: e });
    await ctx.db.patch(room._id, { robot, heat: [], version: room.version + 1 });
  },
});

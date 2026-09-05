import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { variant } from './schema';
import { requireRoom } from './room';

const gauntlet = v.object({
  id: v.string(),
  taskText: v.string(),
  status: v.union(v.literal('running'), v.literal('done')),
  variants: v.array(variant),
  createdAt: v.number(),
});

export const add = mutation({
  args: { slug: v.string(), gauntlet },
  handler: async (ctx, { slug, gauntlet: g }) => {
    const room = await requireRoom(ctx, slug);
    await ctx.db.insert('gauntlets', { roomId: room._id, gauntletId: g.id, taskText: g.taskText, status: g.status, variants: g.variants, createdAt: g.createdAt });
    await ctx.db.patch(room._id, { version: room.version + 1 });
  },
});

export const update = mutation({
  args: { slug: v.string(), id: v.string(), patch: v.any() },
  handler: async (ctx, { slug, id, patch }) => {
    const room = await requireRoom(ctx, slug);
    const row = await ctx.db
      .query('gauntlets')
      .withIndex('by_room_gauntlet', (q) => q.eq('roomId', room._id).eq('gauntletId', id))
      .unique();
    if (!row) return;
    const p = patch as Record<string, unknown>;
    const allowed: Record<string, unknown> = {};
    for (const k of ['status', 'variants'] as const) if (k in p) allowed[k] = p[k];
    await ctx.db.patch(row._id, allowed);
    await ctx.db.patch(room._id, { version: room.version + 1 });
  },
});

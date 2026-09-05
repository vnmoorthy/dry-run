import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { entity } from './schema';
import { requireRoom } from './room';

export const add = mutation({
  args: { slug: v.string(), entity },
  handler: async (ctx, { slug, entity: e }) => {
    const room = await requireRoom(ctx, slug);
    const existing = await ctx.db
      .query('entities')
      .withIndex('by_room_entity', (q) => q.eq('roomId', room._id).eq('entityId', e.id))
      .unique();
    if (existing) await ctx.db.replace(existing._id, { roomId: room._id, entityId: e.id, data: e });
    else await ctx.db.insert('entities', { roomId: room._id, entityId: e.id, data: e });
    await ctx.db.patch(room._id, { version: room.version + 1 });
  },
});

/** Shallow merge; the executor sends only the fields that changed (state, pos, openness...). */
export const update = mutation({
  args: { slug: v.string(), id: v.string(), patch: v.any() },
  handler: async (ctx, { slug, id, patch }) => {
    const room = await requireRoom(ctx, slug);
    const existing = await ctx.db
      .query('entities')
      .withIndex('by_room_entity', (q) => q.eq('roomId', room._id).eq('entityId', id))
      .unique();
    if (!existing) return;
    const merged = { ...existing.data, ...(patch as object) } as typeof existing.data;
    await ctx.db.patch(existing._id, { data: merged });
    await ctx.db.patch(room._id, { version: room.version + 1 });
  },
});

export const remove = mutation({
  args: { slug: v.string(), id: v.string() },
  handler: async (ctx, { slug, id }) => {
    const room = await requireRoom(ctx, slug);
    const existing = await ctx.db
      .query('entities')
      .withIndex('by_room_entity', (q) => q.eq('roomId', room._id).eq('entityId', id))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.patch(room._id, { version: room.version + 1 });
  },
});

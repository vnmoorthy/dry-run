import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { robotPose } from './schema';
import { requireRoom } from './room';

/**
 * Robot pose lives in its own `robots` row (one writer, ~4 Hz) so the
 * heartbeat never invalidates `room.getState`; only `room.getRobot` re-runs.
 */
export const set = mutation({
  args: { slug: v.string(), pose: robotPose },
  handler: async (ctx, { slug, pose }) => {
    const room = await requireRoom(ctx, slug);
    const row = await ctx.db
      .query('robots')
      .withIndex('by_room', (q) => q.eq('roomId', room._id))
      .unique();
    if (row) await ctx.db.patch(row._id, { pose });
    else await ctx.db.insert('robots', { roomId: room._id, pose });
  },
});

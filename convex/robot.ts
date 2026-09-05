import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { robotPose } from './schema';
import { requireRoom } from './room';

/**
 * Robot pose lives on the room document (one writer, ~4 Hz). Deliberately
 * does not bump `version` so heartbeats never invalidate the ledger diff.
 */
export const set = mutation({
  args: { slug: v.string(), pose: robotPose },
  handler: async (ctx, { slug, pose }) => {
    const room = await requireRoom(ctx, slug);
    await ctx.db.patch(room._id, { robot: pose });
  },
});

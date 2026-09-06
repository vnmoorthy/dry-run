import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { requireRoom } from './room';

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

/** Any screen (projector or a judge's phone) can queue a chore. */
export const submit = mutation({
  args: { slug: v.string(), text: v.string(), source: v.optional(v.string()) },
  handler: async (ctx, { slug, text, source }) => {
    const room = await requireRoom(ctx, slug);
    const trimmed = text.trim().slice(0, 240);
    if (!trimmed) throw new Error('empty chore');
    const taskId = newId('t');
    await ctx.db.insert('tasks', { roomId: room._id, taskId, text: trimmed, status: 'queued', steps: [], createdAt: Date.now(), source });
    await ctx.db.patch(room._id, { version: room.version + 1 });
    return taskId;
  },
});

/** Executor writes status/steps/result transitions; steps are replaced wholesale. */
export const update = mutation({
  args: { slug: v.string(), id: v.string(), patch: v.any() },
  handler: async (ctx, { slug, id, patch }) => {
    const room = await requireRoom(ctx, slug);
    const task = await ctx.db
      .query('tasks')
      .withIndex('by_room_task', (q) => q.eq('roomId', room._id).eq('taskId', id))
      .unique();
    if (!task) return;
    const p = patch as Record<string, unknown>;
    const allowed: Record<string, unknown> = {};
    for (const k of ['status', 'steps', 'startedAt', 'endedAt', 'result', 'plannerName', 'source', 'layoutBefore'] as const) if (k in p) allowed[k] = p[k];
    await ctx.db.patch(task._id, allowed);
    await ctx.db.patch(room._id, { version: room.version + 1 });
  },
});

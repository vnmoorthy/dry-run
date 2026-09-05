import { v } from 'convex/values';
import { internalMutation, query } from './_generated/server';
import { roomBySlug } from './room';

const status = v.union(v.literal('queued'), v.literal('generating'), v.literal('downloading'), v.literal('ready'), v.literal('errored'));

/** Live panel of sponsor generation jobs (queued → generating → downloading → ready). */
export const list = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const room = await roomBySlug(ctx, slug);
    if (!room) return [];
    const rows = await ctx.db
      .query('jobs')
      .withIndex('by_room', (q) => q.eq('roomId', room._id))
      .order('desc')
      .take(20);
    return rows.map((j) => ({ ...j, url: j.url }));
  },
});

export const create = internalMutation({
  args: { slug: v.optional(v.string()), provider: v.union(v.literal('worldlabs'), v.literal('tripo'), v.literal('mint'), v.literal('anthropic')), kind: v.string(), meta: v.optional(v.any()) },
  handler: async (ctx, { slug, provider, kind, meta }) => {
    const room = slug ? await roomBySlug(ctx, slug) : null;
    const now = Date.now();
    return ctx.db.insert('jobs', { roomId: room?._id, provider, kind, status: 'queued', meta, createdAt: now, updatedAt: now });
  },
});

export const patch = internalMutation({
  args: {
    id: v.id('jobs'),
    status: v.optional(status),
    externalId: v.optional(v.string()),
    progress: v.optional(v.number()),
    storageId: v.optional(v.id('_storage')),
    url: v.optional(v.string()),
    error: v.optional(v.string()),
    meta: v.optional(v.any()),
  },
  handler: async (ctx, { id, ...rest }) => {
    const defined = Object.fromEntries(Object.entries(rest).filter(([, val]) => val !== undefined));
    await ctx.db.patch(id, { ...defined, updatedAt: Date.now() });
  },
});

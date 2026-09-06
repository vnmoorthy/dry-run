'use node';

/**
 * World Labs World API (Marble) from Convex.
 *
 *   POST /marble/v1/worlds:generate  -> { operation_id }
 *   GET  /marble/v1/operations/{id}  -> { done, response: { world_id } }
 *   GET  /marble/v1/worlds/{id}      -> assets.splats.spz_urls, assets.mesh.collider_mesh_url,
 *                                       assets.splats.semantics_metadata.{metric_scale_factor, ground_plane_offset}
 *
 * Key: WORLDLABS_API_KEY (header WLT-Api-Key). Redeem WORLD-MODEL-HACK-API at platform.worldlabs.ai.
 * Generation takes ~5 minutes, so the job is a chain of short scheduled actions
 * (start → poll every 10 s → download → apply). Signed asset URLs expire, so the
 * .spz and collider .glb are copied into Convex file storage.
 */

import { v } from 'convex/values';
import { action, internalAction } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';

const BASE = 'https://api.worldlabs.ai/marble/v1';
const MAX_POLLS = 90; // 15 minutes at 10 s

function headers(): Record<string, string> {
  const key = process.env.WORLDLABS_API_KEY;
  if (!key) throw new Error('WORLDLABS_API_KEY is not set (npx convex env set WORLDLABS_API_KEY ...)');
  return { 'WLT-Api-Key': key, 'content-type': 'application/json' };
}

/** Kick off a world from a text prompt or public image URLs; returns the job id to watch in `jobs.list`. */
export const generateWorld = action({
  args: {
    slug: v.string(),
    prompt: v.optional(v.string()),
    imageUrls: v.optional(v.array(v.string())),
    model: v.optional(v.string()),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<'jobs'>> => {
    const jobId: Id<'jobs'> = await ctx.runMutation(internal.jobs.create, {
      slug: args.slug,
      provider: 'worldlabs',
      kind: 'world',
      meta: { prompt: args.prompt, images: args.imageUrls?.length ?? 0, model: args.model ?? 'marble-1.1' },
    });
    await ctx.scheduler.runAfter(0, internal.worldlabs.startWorldJob, { jobId, ...args });
    return jobId;
  },
});

export const startWorldJob = internalAction({
  args: {
    jobId: v.id('jobs'),
    slug: v.string(),
    prompt: v.optional(v.string()),
    imageUrls: v.optional(v.array(v.string())),
    model: v.optional(v.string()),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, { jobId, slug, prompt, imageUrls, model, displayName }) => {
    try {
      const world_prompt =
        imageUrls && imageUrls.length > 1
          ? {
              type: 'multi-image',
              multi_image_prompt: imageUrls.map((uri) => ({ content: { source: 'uri', uri } })),
              reconstruct_images: true,
              ...(prompt ? { text_prompt: prompt } : {}),
            }
          : imageUrls && imageUrls.length === 1
            ? { type: 'image', image_prompt: { source: 'uri', uri: imageUrls[0] }, is_pano: 'auto', ...(prompt ? { text_prompt: prompt } : {}) }
            : { type: 'text', text_prompt: prompt ?? 'a tidy small apartment kitchen with a counter, a table and lower cabinets with drawers, eye level' };
      const res = await fetch(`${BASE}/worlds:generate`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ model: model ?? 'marble-1.1', display_name: (displayName ?? `Dry Run ${slug}`).slice(0, 64), world_prompt }),
      });
      if (!res.ok) throw new Error(`worlds:generate ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const op = (await res.json()) as { operation_id: string };
      await ctx.runMutation(internal.jobs.patch, { id: jobId, status: 'generating', externalId: op.operation_id, progress: 0.05 });
      await ctx.scheduler.runAfter(10_000, internal.worldlabs.pollWorldJob, { jobId, slug, operationId: op.operation_id, attempt: 1, displayName });
    } catch (e) {
      await ctx.runMutation(internal.jobs.patch, { id: jobId, status: 'errored', error: (e as Error).message });
    }
  },
});

export const pollWorldJob = internalAction({
  args: { jobId: v.id('jobs'), slug: v.string(), operationId: v.string(), attempt: v.number(), displayName: v.optional(v.string()) },
  handler: async (ctx, { jobId, slug, operationId, attempt, displayName }) => {
    try {
      const res = await fetch(`${BASE}/operations/${operationId}`, { headers: headers() });
      if (!res.ok) throw new Error(`operations ${res.status}`);
      const j = (await res.json()) as { done: boolean; error?: { message?: string }; response?: { world_id?: string }; metadata?: { progress?: number } };
      if (j.error) throw new Error(j.error.message ?? 'generation failed');
      if (!j.done) {
        if (attempt >= MAX_POLLS) throw new Error('timed out waiting for the world');
        const raw = Number(j.metadata?.progress);
        const progress = Number.isFinite(raw) ? 0.05 + 0.85 * (raw > 1 ? raw / 100 : raw) : Math.min(0.9, 0.05 + attempt / 40);
        await ctx.runMutation(internal.jobs.patch, { id: jobId, progress });
        await ctx.scheduler.runAfter(10_000, internal.worldlabs.pollWorldJob, { jobId, slug, operationId, attempt: attempt + 1, displayName });
        return;
      }
      const worldId = j.response?.world_id;
      if (!worldId) throw new Error('operation finished without a world id');
      await ctx.runMutation(internal.jobs.patch, { id: jobId, status: 'downloading', progress: 0.92, meta: { worldId } });
      await ctx.scheduler.runAfter(0, internal.worldlabs.downloadWorld, { jobId, slug, worldId, displayName });
    } catch (e) {
      await ctx.runMutation(internal.jobs.patch, { id: jobId, status: 'errored', error: (e as Error).message });
    }
  },
});

export const downloadWorld = internalAction({
  args: { jobId: v.id('jobs'), slug: v.string(), worldId: v.string(), displayName: v.optional(v.string()) },
  handler: async (ctx, { jobId, slug, worldId, displayName }) => {
    try {
      const wres = await fetch(`${BASE}/worlds/${worldId}`, { headers: headers() });
      if (!wres.ok) throw new Error(`worlds/${worldId} ${wres.status}`);
      const world = (await wres.json()) as {
        world_marble_url?: string;
        display_name?: string;
        model?: string;
        assets?: {
          splats?: { spz_urls?: Record<string, string>; semantics_metadata?: { metric_scale_factor?: number; ground_plane_offset?: number } };
          mesh?: { collider_mesh_url?: string };
        };
      };
      const spz = world.assets?.splats?.spz_urls ?? {};
      // Keys are 100k / 500k / full_res; 500k is the right budget for a projector laptop.
      const spzUrl = spz['500k'] ?? spz['full_res'] ?? spz['100k'] ?? Object.values(spz)[0];
      const colliderUrl = world.assets?.mesh?.collider_mesh_url;
      if (!spzUrl || !colliderUrl) throw new Error('world has no spz or collider yet');
      const store = async (url: string, type: string) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`download ${r.status}`);
        const id = await ctx.storage.store(new Blob([await r.arrayBuffer()], { type }));
        return (await ctx.storage.getUrl(id))!;
      };
      const splatStored = await store(spzUrl, 'application/octet-stream');
      const colliderStored = await store(colliderUrl, 'model/gltf-binary');
      const scaleFactor = world.assets?.splats?.semantics_metadata?.metric_scale_factor;
      const APP_SCALE = 5;
      await ctx.runMutation(internal.room.applyWorld, {
        slug,
        world: {
          name: world.display_name ?? displayName ?? 'Marble world',
          splatUrl: splatStored,
          colliderUrl: colliderStored,
          scale: APP_SCALE,
          metersPerUnit: scaleFactor ? Math.max(0.05, Math.min(5, scaleFactor / APP_SCALE)) : 0.4,
          provenance: `World Labs Marble ${world.model ?? 'marble-1.1'} · world ${worldId}${world.world_marble_url ? ` · ${world.world_marble_url}` : ''}${
            world.assets?.splats?.semantics_metadata?.ground_plane_offset !== undefined ? ` · ground offset ${world.assets.splats.semantics_metadata.ground_plane_offset} m` : ''
          }`,
        },
      });
      await ctx.runMutation(internal.jobs.patch, {
        id: jobId,
        status: 'ready',
        progress: 1,
        url: splatStored,
        meta: { worldId, marbleUrl: world.world_marble_url, model: world.model, collider: colliderStored, metricScaleFactor: scaleFactor },
      });
    } catch (e) {
      await ctx.runMutation(internal.jobs.patch, { id: jobId, status: 'errored', error: (e as Error).message });
    }
  },
});

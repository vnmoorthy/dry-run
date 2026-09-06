'use node';

/**
 * Mint REST API from Convex — the "stock the room" and "live SFX" beats.
 *
 *   base  https://api.mint.gg/v1               Authorization: Bearer MINT_API_KEY
 *   POST  /models:generate                     { prompt, name, generationMode, generationPreset }
 *   POST  /asset-packs:generate                { prompt, itemCount, assetPackType, styleGuide, name }
 *   POST  /audio:generate                      { prompt, name, audioKind, durationSeconds }
 *   GET   /operations/{operationId}            { status: queued|running|preview_ready|billing_required|succeeded|partially_succeeded|failed|canceled,
 *                                                resource: { id, type: model|asset_pack|audio|... }, assets?, error? }
 *   GET   /models/{id}                         { assets: { glbUrl, ... , bounds } }
 *   GET   /asset-packs/{id}                    { items: [{ modelId, displayName, status }] }
 *   GET   /assets/{assetType}/{assetId}/artifacts   downloadable files (used for audio)
 *
 * During the hackathon the heavier work (asset packs, animation sets) is
 * driven by Claude Code through Mint MCP (see docs/MINT.md); this module gives
 * the deployed app a server-side path for a short live generation on stage.
 */

import { v } from 'convex/values';
import { action, internalAction } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';

const BASE = 'https://api.mint.gg/v1';

function headers(): Record<string, string> {
  const key = process.env.MINT_API_KEY;
  if (!key) throw new Error('MINT_API_KEY is not set (npx convex env set MINT_API_KEY ...)');
  return { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

type Kind = 'model' | 'audio' | 'asset-pack';

const ENDPOINT: Record<Kind, string> = { model: '/models:generate', audio: '/audio:generate', 'asset-pack': '/asset-packs:generate' };
const ASSET_TYPE: Record<Kind, string> = { model: 'model', audio: 'audio', 'asset-pack': 'asset_pack' };

/** Start a Mint generation; returns the job id (watch `jobs.list`). */
export const generate = action({
  args: {
    slug: v.string(),
    kind: v.union(v.literal('model'), v.literal('audio'), v.literal('asset-pack')),
    prompt: v.string(),
    name: v.optional(v.string()),
    /** audio only */
    audioKind: v.optional(v.union(v.literal('sound_effect'), v.literal('general_audio'))),
    durationSeconds: v.optional(v.number()),
    /** asset packs only */
    itemCount: v.optional(v.number()),
    assetPackType: v.optional(v.string()),
    styleGuide: v.optional(v.string()),
    generationPreset: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<Id<'jobs'>> => {
    const jobId: Id<'jobs'> = await ctx.runMutation(internal.jobs.create, { slug: a.slug, provider: 'mint', kind: a.kind, meta: { prompt: a.prompt } });
    await ctx.scheduler.runAfter(0, internal.mint.start, { jobId, ...a });
    return jobId;
  },
});

export const start = internalAction({
  args: {
    jobId: v.id('jobs'),
    slug: v.string(),
    kind: v.union(v.literal('model'), v.literal('audio'), v.literal('asset-pack')),
    prompt: v.string(),
    name: v.optional(v.string()),
    audioKind: v.optional(v.union(v.literal('sound_effect'), v.literal('general_audio'))),
    durationSeconds: v.optional(v.number()),
    itemCount: v.optional(v.number()),
    assetPackType: v.optional(v.string()),
    styleGuide: v.optional(v.string()),
    generationPreset: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    try {
      const body: Record<string, unknown> = { prompt: a.prompt, name: a.name ?? `Dry Run ${a.kind}` };
      if (a.generationPreset) body.generationPreset = a.generationPreset;
      if (a.kind === 'audio') {
        body.audioKind = a.audioKind ?? 'sound_effect';
        if (a.durationSeconds) body.durationSeconds = a.durationSeconds;
      }
      if (a.kind === 'asset-pack') {
        body.itemCount = a.itemCount ?? 8;
        if (a.assetPackType) body.assetPackType = a.assetPackType;
        if (a.styleGuide) body.styleGuide = a.styleGuide;
      }
      if (a.kind === 'model') body.generationMode = 'auto';
      const res = await fetch(`${BASE}${ENDPOINT[a.kind]}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { id?: string; operationId?: string; name?: string; error?: { message?: string } };
      const operationId = j.id ?? j.operationId;
      if (!res.ok || !operationId) throw new Error(`${ENDPOINT[a.kind]} ${res.status}: ${j.error?.message ?? JSON.stringify(j).slice(0, 200)}`);
      await ctx.runMutation(internal.jobs.patch, { id: a.jobId, status: 'generating', externalId: operationId, progress: 0.1 });
      await ctx.scheduler.runAfter(2000, internal.mint.poll, { jobId: a.jobId, operationId, kind: a.kind, attempt: 1, delayMs: 2000 });
    } catch (e) {
      await ctx.runMutation(internal.jobs.patch, { id: a.jobId, status: 'errored', error: (e as Error).message });
    }
  },
});

interface Operation {
  status?: string;
  resource?: { id?: string; type?: string };
  assets?: { glbUrl?: string; optimizedGlbUrl?: string; url?: string; audioUrl?: string; mp3Url?: string };
  error?: { message?: string };
}

export const poll = internalAction({
  args: { jobId: v.id('jobs'), operationId: v.string(), kind: v.string(), attempt: v.number(), delayMs: v.number() },
  handler: async (ctx, { jobId, operationId, kind, attempt, delayMs }) => {
    try {
      const res = await fetch(`${BASE}/operations/${operationId}`, { headers: headers() });
      const op = (await res.json()) as Operation;
      if (!res.ok) throw new Error(`operations ${res.status}`);
      const status = op.status ?? '';
      if (status === 'failed' || status === 'canceled') throw new Error(op.error?.message ?? `Mint operation ${status}`);
      if (status === 'billing_required') throw new Error('Mint: billing required — add credits (mint.gg/account, code SPATIAL) then resume the operation');
      if (status === 'preview_ready') throw new Error('Mint operation is waiting for preview approval — use automatic workflow (generationMode auto) for live generation');
      const finished = status === 'succeeded' || status === 'partially_succeeded';
      if (!finished) {
        if (attempt > 400) throw new Error('Mint operation timed out');
        const nextDelay = Math.min(15_000, Math.round(delayMs * 1.6));
        await ctx.runMutation(internal.jobs.patch, { id: jobId, progress: Math.min(0.9, 0.1 + attempt / 60) });
        await ctx.scheduler.runAfter(nextDelay, internal.mint.poll, { jobId, operationId, kind, attempt: attempt + 1, delayMs: nextDelay });
        return;
      }
      const assetId = op.resource?.id;
      const assetType = op.resource?.type ?? ASSET_TYPE[kind as Kind];
      if (!assetId) throw new Error('operation finished without a resource id');
      await ctx.runMutation(internal.jobs.patch, { id: jobId, status: 'downloading', progress: 0.95, meta: { assetId, assetType, status } });

      let fileUrl: string | undefined;
      let contentType = 'application/octet-stream';
      if (kind === 'model') {
        fileUrl = op.assets?.glbUrl ?? op.assets?.optimizedGlbUrl;
        if (!fileUrl) {
          const m = (await (await fetch(`${BASE}/models/${assetId}`, { headers: headers() })).json()) as { assets?: { glbUrl?: string; optimizedGlbUrl?: string } };
          fileUrl = m.assets?.glbUrl ?? m.assets?.optimizedGlbUrl;
        }
        contentType = 'model/gltf-binary';
      } else if (kind === 'audio') {
        fileUrl = op.assets?.audioUrl ?? op.assets?.mp3Url ?? op.assets?.url;
        if (!fileUrl) {
          const art = await fetch(`${BASE}/assets/${assetType}/${assetId}/artifacts`, { headers: headers() });
          const list = (await art.json().catch(() => ({}))) as { files?: { url: string; format?: string; contentType?: string }[]; artifacts?: { url: string; format?: string }[] };
          const files = list.files ?? list.artifacts ?? [];
          const pick = files.find((f) => /(mp3|wav|ogg)/i.test(f.format ?? f.url)) ?? files[0];
          fileUrl = pick?.url;
        }
        contentType = 'audio/mpeg';
      } else {
        // Asset pack: items are models; store the pack listing and let scripts/mint-sync.mjs pull each GLB.
        const pack = (await (await fetch(`${BASE}/asset-packs/${assetId}`, { headers: headers() })).json()) as {
          items?: { modelId?: string; displayName?: string; status?: string }[];
        };
        await ctx.runMutation(internal.jobs.patch, {
          id: jobId,
          status: 'ready',
          progress: 1,
          meta: { assetId, assetType, status, items: (pack.items ?? []).map((i) => ({ modelId: i.modelId, name: i.displayName, status: i.status })) },
        });
        return;
      }
      let stored: string | undefined;
      if (fileUrl) {
        const r = await fetch(fileUrl);
        if (r.ok) {
          const id = await ctx.storage.store(new Blob([await r.arrayBuffer()], { type: contentType }));
          stored = (await ctx.storage.getUrl(id))!;
        }
      }
      await ctx.runMutation(internal.jobs.patch, { id: jobId, status: 'ready', progress: 1, url: stored ?? fileUrl, meta: { assetId, assetType, status, source: fileUrl } });
    } catch (e) {
      await ctx.runMutation(internal.jobs.patch, { id: jobId, status: 'errored', error: (e as Error).message });
    }
  },
});

'use node';

/**
 * Mint REST API from Convex — the "stock the room" and "live SFX" beats.
 *
 *   base  https://api.mint.gg/v1               Authorization: Bearer MINT_API_KEY
 *   POST  /models:generate                     { prompt, name, generationMode, generationPreset }
 *   POST  /asset-packs:generate                { prompt, itemCount, assetPackType, styleGuide, name }
 *   POST  /audio:generate                      { prompt, name, audioKind, durationSeconds }
 *   GET   /operations/{operationId}            { status, resource.{id,type}, error }
 *   GET   /assets/{assetType}/{assetId}/artifacts   -> files[].{url, format, size, contentType}
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

export const poll = internalAction({
  args: { jobId: v.id('jobs'), operationId: v.string(), kind: v.string(), attempt: v.number(), delayMs: v.number() },
  handler: async (ctx, { jobId, operationId, kind, attempt, delayMs }) => {
    try {
      const res = await fetch(`${BASE}/operations/${operationId}`, { headers: headers() });
      const op = (await res.json()) as { status?: string; done?: boolean; resource?: { id?: string; type?: string }; error?: { message?: string } };
      if (!res.ok) throw new Error(`operations ${res.status}`);
      const status = (op.status ?? '').toLowerCase();
      if (op.error || status.includes('fail') || status.includes('error')) throw new Error(op.error?.message ?? `operation ${status}`);
      const finished = op.done === true || status === 'succeeded' || status === 'success' || status === 'completed' || status === 'partially_succeeded';
      if (!finished) {
        if (attempt > 400) throw new Error('Mint operation timed out');
        const nextDelay = Math.min(15_000, Math.round(delayMs * 1.6));
        await ctx.runMutation(internal.jobs.patch, { id: jobId, progress: Math.min(0.9, 0.1 + attempt / 60) });
        await ctx.scheduler.runAfter(nextDelay, internal.mint.poll, { jobId, operationId, kind, attempt: attempt + 1, delayMs: nextDelay });
        return;
      }
      const assetId = op.resource?.id;
      const assetType = op.resource?.type ?? (kind === 'audio' ? 'audio' : kind === 'asset-pack' ? 'asset-packs' : 'models');
      if (!assetId) throw new Error('operation finished without a resource id');
      await ctx.runMutation(internal.jobs.patch, { id: jobId, status: 'downloading', progress: 0.95, meta: { assetId, assetType } });
      const art = await fetch(`${BASE}/assets/${assetType}/${assetId}/artifacts`, { headers: headers() });
      const list = (await art.json().catch(() => ({}))) as { files?: { url: string; format?: string; contentType?: string; size?: number }[] };
      if (!art.ok) throw new Error(`artifacts ${art.status}`);
      const files = list.files ?? [];
      const preferred = files.find((f) => (f.format ?? '').toLowerCase() === (kind === 'audio' ? 'mp3' : 'glb')) ?? files[0];
      let stored: string | undefined;
      if (preferred?.url) {
        const r = await fetch(preferred.url);
        if (r.ok) {
          const id = await ctx.storage.store(new Blob([await r.arrayBuffer()], { type: preferred.contentType ?? 'application/octet-stream' }));
          stored = (await ctx.storage.getUrl(id))!;
        }
      }
      await ctx.runMutation(internal.jobs.patch, {
        id: jobId,
        status: 'ready',
        progress: 1,
        url: stored ?? preferred?.url,
        meta: { assetId, assetType, files: files.map((f) => ({ format: f.format, size: f.size })) },
      });
    } catch (e) {
      await ctx.runMutation(internal.jobs.patch, { id: jobId, status: 'errored', error: (e as Error).message });
    }
  },
});

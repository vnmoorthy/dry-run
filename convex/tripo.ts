'use node';

/**
 * Tripo API v3 from Convex: text → 3D → rig-check → auto-rig → retarget
 * (idle + walk) → GLB in Convex file storage.
 *
 *   base  https://openapi.tripo3d.ai/v3      Authorization: Bearer tsk_...
 *   POST  /generation/text-to-model          { prompt, model, face_limit, texture, pbr }
 *   GET   /tasks/{task_id}                   { status, progress, output.model_url, credits_consumed }
 *   POST  /animations/rig-check              { input }              -> riggable, rig_type   (free)
 *   POST  /animations/rig                    { input, model, rig_type, spec, out_format }
 *   POST  /animations/retarget               { input, animations:[...], animate_in_place, out_format }
 *
 * Model URLs expire ~5 minutes after success, so every result is fetched
 * immediately and copied into storage. Key: TRIPO_API_KEY.
 */

import { v } from 'convex/values';
import { action, internalAction } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';

const BASE = 'https://openapi.tripo3d.ai/v3';

function headers(): Record<string, string> {
  const key = process.env.TRIPO_API_KEY;
  if (!key) throw new Error('TRIPO_API_KEY is not set (npx convex env set TRIPO_API_KEY ...)');
  return { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

async function post(path: string, body: unknown): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as { code?: number; data?: { task_id?: string }; message?: string };
  if (!res.ok || j.code !== 0 || !j.data?.task_id) throw new Error(`${path} failed: ${res.status} ${j.message ?? JSON.stringify(j).slice(0, 200)}`);
  return j.data.task_id;
}

interface TaskInfo {
  status: string;
  progress?: number;
  output?: { model_url?: string; pbr_model?: string; rendered_image_url?: string; riggable?: boolean; rig_type?: string };
  credits_consumed?: number;
  error_code?: number;
  error_message?: string;
}

async function getTask(taskId: string): Promise<TaskInfo> {
  const res = await fetch(`${BASE}/tasks/${taskId}`, { headers: headers() });
  const j = (await res.json()) as { code?: number; data?: TaskInfo; message?: string };
  if (!res.ok || j.code !== 0 || !j.data) throw new Error(`tasks/${taskId} ${res.status} ${j.message ?? ''}`);
  return j.data;
}

/** Robot pipeline: returns the job id; watch `jobs.list` for progress and the final GLB url. */
export const generateRobot = action({
  args: {
    slug: v.string(),
    prompt: v.optional(v.string()),
    model: v.optional(v.string()),
    faceLimit: v.optional(v.number()),
    rigType: v.optional(v.string()),
    animations: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<Id<'jobs'>> => {
    const jobId: Id<'jobs'> = await ctx.runMutation(internal.jobs.create, { slug: args.slug, provider: 'tripo', kind: 'robot', meta: { prompt: args.prompt, model: args.model } });
    await ctx.scheduler.runAfter(0, internal.tripo.step, {
      jobId,
      stage: 'generate',
      prompt: args.prompt ?? 'a compact wheeled home-assistant robot with a two-finger gripper arm and a small sensor head, white body with orange accents, symmetrical, standing neutral pose, clean topology, no background',
      model: args.model ?? 'P1-20260311',
      faceLimit: args.faceLimit ?? 8000,
      rigType: args.rigType,
      animations: args.animations ?? ['preset:idle', 'preset:walk'],
      attempt: 0,
    });
    return jobId;
  },
});

/** One state machine step; reschedules itself while Tripo works. */
export const step = internalAction({
  args: {
    jobId: v.id('jobs'),
    stage: v.string(),
    taskId: v.optional(v.string()),
    prompt: v.string(),
    model: v.string(),
    faceLimit: v.number(),
    rigType: v.optional(v.string()),
    animations: v.array(v.string()),
    attempt: v.number(),
    credits: v.optional(v.number()),
    trail: v.optional(v.array(v.string())),
  },
  handler: async (ctx, a) => {
    const patch = (p: Record<string, unknown>) => ctx.runMutation(internal.jobs.patch, { id: a.jobId, ...p });
    const next = (over: Partial<typeof a>, delayMs = 4000) => ctx.scheduler.runAfter(delayMs, internal.tripo.step, { ...a, ...over });
    try {
      if (a.stage === 'generate') {
        const taskId = await post('/generation/text-to-model', { prompt: a.prompt, model: a.model, face_limit: a.faceLimit, texture: true, pbr: true });
        await patch({ status: 'generating', externalId: taskId, progress: 0.05, meta: { stage: 'generate', taskId } });
        await next({ stage: 'wait-generate', taskId, attempt: 0, trail: [taskId] });
        return;
      }
      if (a.stage.startsWith('wait-')) {
        const t = await getTask(a.taskId!);
        if (t.status === 'success') {
          const credits = (a.credits ?? 0) + (t.credits_consumed ?? 0);
          const stage = a.stage.slice(5);
          if (stage === 'generate') {
            const check = await post('/animations/rig-check', { input: a.taskId });
            await patch({ progress: 0.4, meta: { stage: 'rig-check', taskId: check, credits } });
            await next({ stage: 'wait-rigcheck', taskId: check, attempt: 0, credits, trail: [...(a.trail ?? []), check] });
            return;
          }
          if (stage === 'rigcheck') {
            const riggable = t.output?.riggable ?? true;
            const rigType = a.rigType ?? t.output?.rig_type ?? 'biped';
            if (!riggable) {
              // Ship the unrigged model rather than fail the whole job.
              await ctx.scheduler.runAfter(0, internal.tripo.finish, { jobId: a.jobId, taskId: a.trail![0], credits, note: 'not riggable; static model', rigType: 'none' });
              return;
            }
            const rig = await post('/animations/rig', { input: a.trail![0], model: 'v2.5-20260210', rig_type: rigType, spec: 'tripo', out_format: 'glb' });
            await patch({ progress: 0.55, meta: { stage: 'rig', taskId: rig, rigType, credits } });
            await next({ stage: 'wait-rig', taskId: rig, rigType, attempt: 0, credits, trail: [...(a.trail ?? []), rig] });
            return;
          }
          if (stage === 'rig') {
            const presets = a.rigType === 'quadruped' ? ['preset:quadruped:walk'] : a.animations;
            const re = await post('/animations/retarget', { input: a.taskId, animations: presets, animate_in_place: true, out_format: 'glb', bake_animation: true });
            await patch({ progress: 0.75, meta: { stage: 'retarget', taskId: re, credits } });
            await next({ stage: 'wait-retarget', taskId: re, attempt: 0, credits, trail: [...(a.trail ?? []), re] });
            return;
          }
          if (stage === 'retarget') {
            await ctx.scheduler.runAfter(0, internal.tripo.finish, { jobId: a.jobId, taskId: a.taskId!, credits, note: 'rigged + animated', rigType: a.rigType ?? 'biped' });
            return;
          }
        }
        if (t.status === 'failed' || t.status === 'cancelled' || t.status === 'banned' || t.status === 'expired') {
          throw new Error(`Tripo task ${a.taskId} ${t.status}${t.error_message ? `: ${t.error_message}` : ''}${t.error_code ? ` (code ${t.error_code})` : ''}`);
        }
        if (a.attempt > 150) throw new Error('Tripo task timed out');
        await patch({ progress: Math.min(0.9, (a.stage === 'wait-generate' ? 0.05 : 0.55) + ((t.progress ?? 0) / 100) * 0.3) });
        await next({ attempt: a.attempt + 1 });
        return;
      }
      throw new Error(`unknown stage ${a.stage}`);
    } catch (e) {
      await patch({ status: 'errored', error: (e as Error).message });
    }
  },
});

export const finish = internalAction({
  args: { jobId: v.id('jobs'), taskId: v.string(), credits: v.number(), note: v.string(), rigType: v.string() },
  handler: async (ctx, { jobId, taskId, credits, note, rigType }) => {
    try {
      const t = await getTask(taskId);
      const url = t.output?.pbr_model ?? t.output?.model_url;
      if (!url) throw new Error('no model_url on the finished task');
      const r = await fetch(url);
      if (!r.ok) throw new Error(`download ${r.status} (model URLs expire after ~5 minutes)`);
      const id = await ctx.storage.store(new Blob([await r.arrayBuffer()], { type: 'model/gltf-binary' }));
      const stored = (await ctx.storage.getUrl(id))!;
      await ctx.runMutation(internal.jobs.patch, {
        id: jobId,
        status: 'ready',
        progress: 1,
        storageId: id,
        url: stored,
        meta: { taskId, credits, note, rigType, preview: t.output?.rendered_image_url },
      });
    } catch (e) {
      await ctx.runMutation(internal.jobs.patch, { id: jobId, status: 'errored', error: (e as Error).message });
    }
  },
});

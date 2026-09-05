#!/usr/bin/env node
/**
 * Generate the robot with Tripo: text → 3D (P1, game-ready) → rig-check → auto-rig → retarget idle+walk.
 *
 *   export TRIPO_API_KEY=tsk_...             # platform.tripo3d.ai
 *   node scripts/tripo-robot.mjs
 *   node scripts/tripo-robot.mjs --prompt "quadruped inspection robot dog, matte grey, yellow accents, neutral standing pose" --rig quadruped
 *   node scripts/tripo-robot.mjs --static      # skip rigging (just the mesh)
 *   node scripts/tripo-robot.mjs --prop "ceramic coffee mug" --key mug   # a prop instead of the robot
 *
 * Model URLs expire ~5 minutes after success, so each result is downloaded immediately.
 * Output: public/assets/generated/robot.glb (+ manifest.robot) or props/<key>.glb (+ manifest.props[]).
 */
import { arg, download, readManifest, requireEnv, sleep, stamp, writeManifest } from './lib.mjs';

const BASE = 'https://openapi.tripo3d.ai/v3';
const KEY = requireEnv('TRIPO_API_KEY');
const H = { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

async function post(p, body) {
  const res = await fetch(`${BASE}${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.code !== 0 || !j.data?.task_id) throw new Error(`${p} → ${res.status} ${j.message ?? JSON.stringify(j).slice(0, 300)}`);
  return j.data.task_id;
}

async function waitTask(taskId, label) {
  const t0 = Date.now();
  for (;;) {
    const res = await fetch(`${BASE}/tasks/${taskId}`, { headers: H });
    const j = await res.json();
    const d = j.data ?? {};
    process.stdout.write(`\r   ${label}: ${d.status ?? '?'} ${d.progress ?? 0}% (${Math.round((Date.now() - t0) / 1000)} s)   `);
    if (d.status === 'success') {
      console.log(`\n✔ ${label} done (credits ${d.credits_consumed ?? '?'})`);
      return d;
    }
    if (['failed', 'cancelled', 'banned', 'expired', 'unknown'].includes(d.status)) throw new Error(`${label} ${d.status}`);
    if (Date.now() - t0 > 15 * 60_000) throw new Error(`${label} timed out`);
    await sleep(3000);
  }
}

async function main() {
  const prop = arg('prop', null);
  const key = arg('key', prop ? 'prop' : 'robot');
  const prompt = prop ?? arg('prompt', 'a compact wheeled home-assistant robot with a two-finger gripper arm and a small sensor head, white body with orange accents, symmetrical, standing neutral pose, clean topology, no background');
  const model = arg('model', 'P1-20260311');
  const faceLimit = Number(arg('face', prop ? 6000 : 8000));
  const isStatic = !!prop || arg('static', false) === true;
  const rigOverride = arg('rig', null);
  const taskIds = [];
  let credits = 0;

  const gen = await post('/generation/text-to-model', { prompt, model, face_limit: faceLimit, texture: true, pbr: true });
  taskIds.push(gen);
  let finalTask = await waitTask(gen, 'text-to-model');
  credits += finalTask.credits_consumed ?? 0;
  let rigType = 'none';
  let clips = {};

  if (!isStatic) {
    const check = await post('/animations/rig-check', { input: gen });
    const c = await waitTask(check, 'rig-check');
    const riggable = c.output?.riggable ?? true;
    rigType = rigOverride ?? c.output?.rig_type ?? 'biped';
    if (!riggable) console.log('! not riggable per rig-check; shipping the static mesh');
    else {
      const rig = await post('/animations/rig', { input: gen, model: 'v2.5-20260210', rig_type: rigType, spec: 'tripo', out_format: 'glb' });
      taskIds.push(rig);
      const r = await waitTask(rig, `rig (${rigType})`);
      credits += r.credits_consumed ?? 0;
      const presets = rigType === 'quadruped' ? ['preset:quadruped:walk'] : ['preset:idle', 'preset:walk'];
      const re = await post('/animations/retarget', { input: rig, animations: presets, animate_in_place: true, out_format: 'glb', bake_animation: true });
      taskIds.push(re);
      finalTask = await waitTask(re, `retarget ${presets.join(',')}`);
      credits += finalTask.credits_consumed ?? 0;
      clips = rigType === 'quadruped' ? { walk: 'preset:quadruped:walk' } : { idle: 'preset:idle', walk: 'preset:walk' };
    }
  }

  const url = finalTask.output?.pbr_model ?? finalTask.output?.model_url;
  if (!url) throw new Error('no model_url on the final task');
  const file = prop ? `props/${key}.glb` : 'robot.glb';
  if (prop) (await import('node:fs/promises')).mkdir(new URL('../public/assets/generated/props/', import.meta.url), { recursive: true });
  const localUrl = await download(url, file);
  if (prop) {
    const m = await readManifest();
    const props = (m.props ?? []).filter((p) => p.key !== key);
    props.push({ key, name: prop, glbUrl: localUrl, provider: 'tripo', id: gen, tags: [key], heightUnits: Number(arg('height', 0.6)) });
    await writeManifest({ props });
  } else {
    await writeManifest({
      robot: { glbUrl: localUrl, provider: 'tripo', model, taskIds, rig: rigType, clips, credits, heightUnits: 2.4, generatedAt: stamp(), note: `prompt: ${prompt}` },
    });
  }
  console.log('\nNext: npm run dev — the app logs the GLB clip names on load; set manifest.robot.clips if they differ.');
}

main().catch((e) => {
  console.error('\n✖', e.message);
  process.exit(1);
});

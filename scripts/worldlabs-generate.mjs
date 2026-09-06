#!/usr/bin/env node
/**
 * Generate the room twin with the World Labs World API and drop it into public/assets.
 *
 *   export WORLDLABS_API_KEY=...            # platform.worldlabs.ai → redeem WORLD-MODEL-HACK-API
 *   node scripts/worldlabs-generate.mjs --prompt "small apartment kitchen, counter, table, drawers, eye level"
 *   node scripts/worldlabs-generate.mjs --images room1.jpg room2.jpg room3.jpg room4.jpg   # 4–8 same-aspect, overlapping photos
 *   node scripts/worldlabs-generate.mjs --world <existing world id>                          # just download
 *
 * Options: --model marble-1.1 | marble-1.1-plus | marble-1.0-draft (20 s, cheap for prompt iteration)
 *          --name "Fort Mason lounge"   --res 500k|100k|full_res   (500k is right for a laptop; 100k for phones)
 *
 * Output: public/assets/generated/world.spz + world-collider.glb and manifest.json → the app
 * loads it automatically (receipts panel shows model + world id).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { arg, args, download, requireEnv, sleep, stamp, writeManifest } from './lib.mjs';

const BASE = 'https://api.worldlabs.ai/marble/v1';
const KEY = requireEnv('WORLDLABS_API_KEY');
const H = { 'WLT-Api-Key': KEY, 'content-type': 'application/json' };

async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

async function uploadImage(file) {
  const bytes = await readFile(file);
  const rawExt = path.extname(file).slice(1).toLowerCase();
  const extension = rawExt === 'jpeg' ? 'jpg' : rawExt;
  // Contract: request { file_name, kind, extension }, response { media_asset: { media_asset_id }, upload_info: { upload_url, required_headers } }
  const prep = await api('POST', '/media-assets:prepare_upload', { kind: 'image', file_name: path.basename(file), extension });
  const info = prep.upload_info ?? prep;
  const uploadUrl = info.upload_url ?? info.uploadUrl;
  const headers = info.required_headers ?? info.requiredHeaders ?? {};
  if (!uploadUrl) throw new Error(`prepare_upload returned no upload_url: ${JSON.stringify(prep).slice(0, 300)}`);
  const put = await fetch(uploadUrl, { method: 'PUT', headers, body: bytes });
  if (!put.ok) throw new Error(`upload ${file}: ${put.status}`);
  const id = prep.media_asset?.media_asset_id ?? prep.media_asset_id ?? prep.id;
  if (!id) throw new Error(`prepare_upload returned no media_asset_id: ${JSON.stringify(prep).slice(0, 300)}`);
  console.log(`✔ uploaded ${path.basename(file)} → ${id}`);
  return id;
}

async function main() {
  const model = arg('model', 'marble-1.1');
  const name = arg('name', 'Dry Run room');
  const res = arg('res', '500k');
  let worldId = arg('world', null);
  const images = args('images');
  const prompt = arg('prompt', null);

  if (!worldId) {
    let world_prompt;
    if (images.length > 1) {
      const ids = [];
      for (const f of images) ids.push(await uploadImage(f));
      world_prompt = { type: 'multi-image', multi_image_prompt: ids.map((media_asset_id) => ({ content: { source: 'media_asset', media_asset_id } })), reconstruct_images: true };
      if (prompt) world_prompt.text_prompt = prompt;
    } else if (images.length === 1) {
      const id = await uploadImage(images[0]);
      world_prompt = { type: 'image', image_prompt: { source: 'media_asset', media_asset_id: id }, is_pano: 'auto' };
      if (prompt) world_prompt.text_prompt = prompt;
    } else {
      world_prompt = { type: 'text', text_prompt: prompt ?? 'a tidy small apartment kitchen with a counter, a table, and lower cabinets with drawers, eye level, soft daylight' };
    }
    const op = await api('POST', '/worlds:generate', { model, display_name: String(name).slice(0, 64), world_prompt });
    console.log(`… generation started: operation ${op.operation_id} (model ${model}). Marble takes ~5 min.`);
    const t0 = Date.now();
    for (;;) {
      await sleep(10_000);
      const s = await api('GET', `/operations/${op.operation_id}`);
      if (s.error) throw new Error(s.error.message ?? JSON.stringify(s.error));
      const pct = Number(s.metadata?.progress);
      const pctText = Number.isFinite(pct) ? ` · ${Math.round(pct > 1 ? pct : pct * 100)}%` : '';
      process.stdout.write(`\r   ${Math.round((Date.now() - t0) / 1000)} s elapsed${pctText}…`);
      if (s.done) {
        worldId = s.response?.world_id;
        console.log(`\n✔ world ready: ${worldId}`);
        break;
      }
      if (Date.now() - t0 > 20 * 60_000) throw new Error('timed out');
    }
  }

  const world = await api('GET', `/worlds/${worldId}`);
  const spz = world.assets?.splats?.spz_urls ?? {};
  if (!spz[res]) console.log(`! no "${res}" spz on this world (keys: ${Object.keys(spz).join(', ')}) — falling back`);
  const spzUrl = spz[res] ?? spz['500k'] ?? spz['full_res'] ?? spz['100k'] ?? Object.values(spz)[0];
  const colliderUrl = world.assets?.mesh?.collider_mesh_url;
  if (!spzUrl) throw new Error(`no spz url on world (keys: ${Object.keys(spz).join(', ')})`);
  if (!colliderUrl) throw new Error('no collider_mesh_url on world yet — open it in Marble and export the collider, or retry in a minute');
  const splatPath = await download(spzUrl, 'world.spz');
  const colliderPath = await download(colliderUrl, 'world-collider.glb');
  const meta = world.assets?.splats?.semantics_metadata ?? {};
  const APP_SCALE = 5;
  await writeManifest({
    world: {
      name: world.display_name ?? name,
      splatUrl: splatPath,
      colliderUrl: colliderPath,
      scale: APP_SCALE,
      metersPerUnit: meta.metric_scale_factor ? Math.max(0.05, Math.min(5, meta.metric_scale_factor / APP_SCALE)) : 0.4,
      provider: 'worldlabs',
      model: world.model ?? model,
      worldId,
      marbleUrl: world.world_marble_url,
      inputs: images.length ? `${images.length} photo(s), reconstruct_images` : 'text prompt',
      generatedAt: stamp(),
      note: [meta.ground_plane_offset !== undefined ? `ground_plane_offset ${meta.ground_plane_offset} m` : null, 'frame marble_raw_opencv (rotate 180° about X if upside-down)'].filter(Boolean).join(' · '),
    },
  });
  console.log('\nNext: npm run dev — if the robot floats or sinks, tune metersPerUnit/scale in public/assets/manifest.json.');
  console.log('If the world is upside-down (marble_raw_opencv), rotate the splat 180° about X in src/world/world.ts.');
}

main().catch((e) => {
  console.error('✖', e.message);
  process.exit(1);
});

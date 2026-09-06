#!/usr/bin/env node
/**
 * Pull Mint assets into public/assets so the app can use them as props and SFX.
 *
 * Two ways in:
 *  A) From a Claude Code + Mint MCP session (the "agent stocked the room" beat):
 *       ask the agent for `get_asset_artifact_manifests` on the pack items and save the JSON to mint-assets.json, then
 *       node scripts/mint-sync.mjs --from mint-assets.json
 *     Accepts any JSON that contains objects with { id, name?, type?, files:[{url, format}] } anywhere inside.
 *  B) Straight from the REST API with a key (platform.mint.gg):
 *       export MINT_API_KEY=...
 *       node scripts/mint-sync.mjs --pack "household objects: mug, bottle, book, plant, box, can" --count 6
 *       node scripts/mint-sync.mjs --sfx "small servo whir" --key pick
 *       node scripts/mint-sync.mjs --model "ceramic coffee mug" --key mug
 *
 * Output: public/assets/generated/mint/*.glb|mp3 + manifest.props[] / manifest.audio[].
 */
import { readFile, mkdir } from 'node:fs/promises';
import { arg, download, readManifest, sleep, stamp, writeManifest } from './lib.mjs';

const BASE = 'https://api.mint.gg/v1';
const H = () => ({ Authorization: `Bearer ${process.env.MINT_API_KEY}`, 'content-type': 'application/json' });

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'asset';
}

/** Walk any JSON and collect things that look like Mint artifact manifests. */
function collect(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collect(n, out));
  else if (node && typeof node === 'object') {
    if (Array.isArray(node.files) && node.files.some((f) => f && f.url)) out.push(node);
    for (const v of Object.values(node)) collect(v, out);
  }
  return out;
}

async function ingest(manifests, label = 'mint') {
  await mkdir(new URL('../public/assets/generated/mint/', import.meta.url), { recursive: true });
  const m = await readManifest();
  const props = m.props ?? [];
  const audio = m.audio ?? [];
  for (const a of manifests) {
    const files = a.files ?? [];
    const glb = files.find((f) => /glb$/i.test(f.format ?? f.url));
    const mp3 = files.find((f) => /(mp3|wav|ogg)$/i.test(f.format ?? f.url));
    const name = a.name ?? a.displayName ?? a.id ?? 'asset';
    const key = manifests.length === 1 && arg('key', null) ? arg('key') : slug(name);
    if (glb) {
      const local = await download(glb.url, `mint/${key}.glb`);
      const idx = props.findIndex((p) => p.key === key);
      const entry = { key, name, glbUrl: local, provider: 'mint', id: a.id, tags: [key, ...name.toLowerCase().split(/\s+/)], heightUnits: Number(arg('height', 0.6)) };
      if (idx >= 0) props[idx] = entry;
      else props.push(entry);
    }
    if (mp3) {
      const local = await download(mp3.url, `mint/${key}.${(mp3.format ?? 'mp3').toLowerCase()}`);
      const idx = audio.findIndex((p) => p.key === key);
      const entry = { key, url: local, provider: 'mint', id: a.id };
      if (idx >= 0) audio[idx] = entry;
      else audio.push(entry);
    }
    if (!glb && !mp3) console.log(`! ${name}: no glb/mp3 in files (${files.map((f) => f.format).join(', ')})`);
  }
  await writeManifest({ props, audio, mintSyncedAt: stamp(), mintSource: label });
}

async function op(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: H(), body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  const id = j.id ?? j.operationId;
  if (!res.ok || !id) throw new Error(`${path} → ${res.status} ${JSON.stringify(j).slice(0, 300)}`);
  console.log(`… operation ${id}`);
  let delay = 2000;
  for (let i = 0; i < 400; i++) {
    await sleep(delay);
    delay = Math.min(15_000, Math.round(delay * 1.6));
    const s = await (await fetch(`${BASE}/operations/${id}`, { headers: H() })).json();
    // Statuses: queued | running | preview_ready | billing_required | succeeded | partially_succeeded | failed | canceled
    const status = String(s.status ?? '');
    process.stdout.write(`\r   ${status || 'running'}   `);
    if (status === 'failed' || status === 'canceled') throw new Error(s.error?.message ?? `operation ${status}`);
    if (status === 'billing_required') throw new Error('billing required — redeem SPATIAL at mint.gg/account, then retry');
    if (status === 'preview_ready') throw new Error('operation is waiting for preview approval — use generationMode auto');
    if (status === 'succeeded' || status === 'partially_succeeded') {
      console.log('');
      return { ...s.resource, assets: s.assets };
    }
  }
  throw new Error('timed out');
}

/** Resolve a finished resource into { id, name, type, files:[{url, format}] } using the typed asset endpoints. */
async function artifacts(resource) {
  const files = [];
  if (resource.type === 'model' || resource.assets?.glbUrl) {
    const m = resource.assets?.glbUrl ? resource : await (await fetch(`${BASE}/models/${resource.id}`, { headers: H() })).json();
    const url = m.assets?.glbUrl ?? m.assets?.optimizedGlbUrl;
    if (url) files.push({ url, format: 'glb' });
    return { id: resource.id, name: m.name ?? resource.id, type: 'model', files };
  }
  const r = await fetch(`${BASE}/assets/${resource.type}/${resource.id}/artifacts`, { headers: H() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`artifacts → ${r.status}`);
  const list = j.files ?? j.artifacts ?? [];
  return { id: resource.id, name: j.name ?? resource.id, type: resource.type, files: list };
}

/** An asset pack is a list of models: GET /asset-packs/{id}.items[].modelId → GET /models/{modelId}.assets.glbUrl */
async function packItems(packId) {
  const pack = await (await fetch(`${BASE}/asset-packs/${packId}`, { headers: H() })).json();
  const out = [];
  for (const it of pack.items ?? []) {
    if (!it.modelId) continue;
    const m = await (await fetch(`${BASE}/models/${it.modelId}`, { headers: H() })).json();
    const url = m.assets?.glbUrl ?? m.assets?.optimizedGlbUrl;
    if (!url) {
      console.log(`! ${it.displayName ?? it.modelId}: no glbUrl yet (${it.status ?? m.status ?? '?'})`);
      continue;
    }
    out.push({ id: it.modelId, name: it.displayName ?? m.name ?? it.modelId, type: 'model', files: [{ url, format: 'glb' }] });
  }
  return out;
}

async function main() {
  const from = arg('from', null);
  if (from) {
    const json = JSON.parse(await readFile(from, 'utf8'));
    const found = collect(json);
    if (!found.length) throw new Error('no artifact manifests found in that JSON');
    await ingest(found, `mcp:${from}`);
    return;
  }
  if (!process.env.MINT_API_KEY) throw new Error('set MINT_API_KEY or pass --from mint-assets.json');
  if (arg('sfx', null)) {
    const res = await op('/audio:generate', { prompt: arg('sfx'), name: arg('key', 'sfx'), audioKind: 'sound_effect', durationSeconds: Number(arg('seconds', 2)) });
    await ingest([await artifacts(res)], 'api:audio');
  } else if (arg('model', null)) {
    const res = await op('/models:generate', { prompt: arg('model'), name: arg('key', 'model'), generationMode: 'auto' });
    await ingest([await artifacts(res)], 'api:model');
  } else if (arg('pack', null)) {
    const res = await op('/asset-packs:generate', { prompt: arg('pack'), itemCount: Number(arg('count', 6)), name: 'Dry Run pack', styleGuide: arg('style', 'realistic household objects, real-world scale, clean topology') });
    const items = await packItems(res.id);
    if (!items.length) throw new Error('the pack finished without downloadable items');
    await ingest(items, 'api:pack');
  } else {
    console.log('nothing to do — see the header of this script for usage');
  }
}

main().catch((e) => {
  console.error('\n✖', e.message);
  process.exit(1);
});

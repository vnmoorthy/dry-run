// Shared helpers for the pre-generation scripts (no dependencies beyond Node 18+).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
export const ASSET_DIR = path.join(ROOT, 'public', 'assets');
export const GEN_DIR = path.join(ASSET_DIR, 'generated');
export const MANIFEST = path.join(ASSET_DIR, 'manifest.json');

export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const val = process.argv[i + 1];
  return val === undefined || val.startsWith('--') ? true : val;
}

export function args(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}`) {
      for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith('--'); j++) out.push(process.argv[j]);
    }
  }
  return out;
}

export async function readManifest() {
  if (!existsSync(MANIFEST)) return {};
  return JSON.parse(await readFile(MANIFEST, 'utf8'));
}

export async function writeManifest(patch) {
  await mkdir(ASSET_DIR, { recursive: true });
  const current = await readManifest();
  const next = { ...current, ...patch };
  await writeFile(MANIFEST, JSON.stringify(next, null, 2));
  console.log(`✔ wrote ${path.relative(ROOT, MANIFEST)}`);
  return next;
}

export async function download(url, filename, headers = {}) {
  await mkdir(GEN_DIR, { recursive: true });
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`download ${filename}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const out = path.join(GEN_DIR, filename);
  await writeFile(out, buf);
  console.log(`✔ ${filename} (${(buf.length / 1e6).toFixed(1)} MB)`);
  return `/assets/generated/${filename}`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`✖ ${name} is not set. export ${name}=... and retry.`);
    process.exit(1);
  }
  return v;
}

export function stamp() {
  return new Date().toISOString();
}

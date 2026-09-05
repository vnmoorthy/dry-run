/**
 * Sound effects. Uses Mint-generated audio from the asset manifest when
 * present (`manifest.audio[]` keys: pick, place, open, close, pass, fail, start);
 * otherwise falls back to tiny WebAudio synth cues so the demo is never silent.
 */

import type { AssetManifest } from '../sim/types';

type Key = 'pick' | 'place' | 'open' | 'close' | 'pass' | 'fail' | 'start';

export class Sfx {
  private ctx: AudioContext | null = null;
  private buffers = new Map<Key, AudioBuffer>();
  private urls = new Map<Key, string>();
  enabled = true;

  constructor(manifest: AssetManifest | null) {
    for (const a of manifest?.audio ?? []) this.urls.set(a.key as Key, a.url);
    const unlock = () => {
      this.ensure();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  private ensure(): AudioContext | null {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        for (const [k, url] of this.urls) void this.load(k, url);
      } catch {
        this.ctx = null;
      }
    }
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private async load(key: Key, url: string): Promise<void> {
    if (!this.ctx) return;
    try {
      const buf = await (await fetch(url)).arrayBuffer();
      this.buffers.set(key, await this.ctx.decodeAudioData(buf));
    } catch (e) {
      console.warn('sfx load failed', key, e);
    }
  }

  private play(key: Key, synth: (ctx: AudioContext, t: number) => void): void {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const buf = this.buffers.get(key);
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = 0.7;
      src.connect(g).connect(ctx.destination);
      src.start();
      return;
    }
    synth(ctx, ctx.currentTime);
  }

  private tone(ctx: AudioContext, t: number, f0: number, f1: number, dur: number, type: OscillatorType = 'sine', vol = 0.18): void {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  pick(): void {
    this.play('pick', (c, t) => this.tone(c, t, 520, 780, 0.12, 'triangle'));
  }
  place(): void {
    this.play('place', (c, t) => this.tone(c, t, 420, 240, 0.16, 'triangle'));
  }
  open(): void {
    this.play('open', (c, t) => this.tone(c, t, 180, 320, 0.5, 'sawtooth', 0.06));
  }
  close(): void {
    this.play('close', (c, t) => this.tone(c, t, 320, 150, 0.4, 'sawtooth', 0.06));
  }
  pass(): void {
    this.play('pass', (c, t) => {
      this.tone(c, t, 660, 660, 0.12);
      this.tone(c, t + 0.14, 880, 880, 0.12);
      this.tone(c, t + 0.28, 1320, 1320, 0.22);
    });
  }
  fail(): void {
    this.play('fail', (c, t) => {
      this.tone(c, t, 300, 220, 0.25, 'square', 0.08);
      this.tone(c, t + 0.28, 220, 140, 0.35, 'square', 0.08);
    });
  }
  start(): void {
    this.play('start', (c, t) => this.tone(c, t, 440, 660, 0.1));
  }
}

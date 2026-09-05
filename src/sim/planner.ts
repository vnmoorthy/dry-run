/**
 * Chore planner: plain English -> ordered robot steps.
 *
 * Two planners share one contract:
 *  - `planTaskLocal`  : deterministic grammar over the room's named entities.
 *                       Always available, runs in the browser and in Node.
 *  - Convex `planner.plan` action (LLM) : optional, used when a key is set;
 *                       falls back to this one on any failure.
 *
 * The plan is deliberately transparent: every step names its target so the
 * ledger can show "navigate → red mug", "pick red mug", "open top drawer"...
 */

import type { Entity, Fixture, Item, RobotPose, Step, Zone } from './types';
import { newId } from './types';

export type PlanResult =
  | { ok: true; steps: Step[]; summary: string; plannerName: string }
  | { ok: false; reason: string; plannerName: string };

const STOP = new Set([
  'the', 'a', 'an', 'my', 'your', 'our', 'that', 'this', 'those', 'these', 'please', 'go', 'ahead', 'now',
  'then', 'and', 'to', 'of', 'me', 'up', 'it', 'them', 'kitchen', 'room',
]);

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t && !STOP.has(t))
    .map(singular);
}

function singular(t: string): string {
  if (t.length > 4 && t.endsWith('es') && !t.endsWith('ses')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

export interface Match<T extends Entity = Entity> {
  entity: T;
  score: number;
}

/** Score how well a phrase refers to an entity. */
export function matchEntities<T extends Entity>(phrase: string, entities: T[]): Match<T>[] {
  const pt = tokens(phrase);
  if (pt.length === 0) return [];
  const out: Match<T>[] = [];
  for (const e of entities) {
    const nameTokens = tokens(e.name);
    const tagTokens = e.tags.flatMap((t) => tokens(t));
    let score = 0;
    for (const t of pt) {
      if (nameTokens.includes(t)) score += 2;
      else if (tagTokens.includes(t)) score += 1;
      else if (nameTokens.some((n) => n.startsWith(t) || t.startsWith(n))) score += 0.5;
    }
    if (score > 0) {
      // Exact full-name match wins ties.
      if (nameTokens.join(' ') === pt.join(' ')) score += 3;
      // Penalize entities with many extra tokens that were not mentioned (so "mug" prefers "mug" over "red mug" only when both exist).
      score -= 0.1 * Math.max(0, nameTokens.length - pt.length);
      out.push({ entity: e, score });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function best<T extends Entity>(phrase: string, entities: T[]): T | null {
  const m = matchEntities(phrase, entities);
  return m.length ? m[0].entity : null;
}

function mkStep(kind: Step['kind'], target: Entity): Step {
  return { id: newId('s'), kind, targetId: target.id, targetName: target.name, status: 'queued' };
}

const PUT_RE =
  /^(?:please\s+)?(?:put|place|move|bring|take|carry|set|drop|return|deliver|stash|leave)\s+(?:the\s+|a\s+|my\s+)?(.+?)\s+(?:on(?:to)?|in(?:to|side)?|to|at|by|near|next to|onto|over to|back (?:on|in|to))\s+(?:the\s+|my\s+)?(.+)$/i;
const OPEN_RE = /^(?:please\s+)?(open|close|shut|pull open|push shut|slide open|slide shut)\s+(?:the\s+|my\s+)?(.+)$/i;
const GO_RE = /^(?:please\s+)?(?:go|walk|drive|navigate|head|come|roll)\s+(?:over\s+)?(?:to|near|toward|towards|by)\s+(?:the\s+|my\s+)?(.+)$/i;
const FETCH_RE = /^(?:please\s+)?(?:fetch|get|grab|pick up|pick|hold|lift|collect|find)\s+(?:me\s+)?(?:the\s+|a\s+|my\s+)?(.+?)(?:\s+(?:for me|please))?$/i;
const TIDY_RE = /^(?:please\s+)?(?:tidy|clean|clear)\s+(?:up\s+)?(?:the\s+)?(.+)$/i;

export function splitClauses(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/\s*(?:,|;|\.|\bthen\b|\band then\b|\bafter that\b|\bfinally\b|\band\b(?=\s+(?:put|place|move|bring|take|carry|set|drop|open|close|shut|go|walk|drive|fetch|get|grab|pick|tidy|clean|clear|return)))\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

export function planTaskLocal(text: string, entities: Entity[], _robot: RobotPose): PlanResult {
  const plannerName = 'rule-based planner';
  const items = entities.filter((e): e is Item => e.kind === 'item' && !e.clutter);
  const fixtures = entities.filter((e): e is Fixture => e.kind === 'fixture');
  const zones = entities.filter((e): e is Zone => e.kind === 'zone');
  const targets: Entity[] = [...zones, ...fixtures, ...items];
  const clauses = splitClauses(text);
  if (clauses.length === 0) return { ok: false, reason: 'Empty chore.', plannerName };

  const steps: Step[] = [];
  const summaryParts: string[] = [];
  /** Track what the robot is holding across clauses ("get the mug, put it on the shelf"). */
  let holding: Item | null = null;
  /** Track fixtures we opened so "close it" resolves. */
  let lastFixture: Fixture | null = null;

  for (const clause of clauses) {
    let m: RegExpMatchArray | null;
    if ((m = clause.match(PUT_RE))) {
      const itemPhrase = m[1];
      const targetPhrase = m[2];
      let item: Item | null;
      if (/^(it|that|this|them)$/i.test(itemPhrase.trim()) && holding) item = holding;
      else item = best(itemPhrase, items);
      if (!item) return { ok: false, reason: `I don't see "${itemPhrase}" in this room.`, plannerName };
      const target = best(targetPhrase, targets.filter((t) => t.id !== item!.id));
      if (!target) return { ok: false, reason: `No place called "${targetPhrase}" in this room.`, plannerName };
      if (holding?.id !== item.id) {
        steps.push(mkStep('navigate', item), mkStep('pick', item));
      }
      steps.push(mkStep('navigate', target));
      if (target.kind === 'fixture' && target.openness < 0.5) {
        steps.push(mkStep('open', target));
        lastFixture = target;
      }
      steps.push(mkStep('place', target));
      holding = null;
      summaryParts.push(`${item.name} → ${target.name}`);
      continue;
    }
    if ((m = clause.match(OPEN_RE))) {
      const verb = m[1].toLowerCase();
      const phrase = m[2];
      let fixture: Fixture | null;
      if (/^(it|that|this)$/i.test(phrase.trim()) && lastFixture) fixture = lastFixture;
      else fixture = best(phrase, fixtures);
      if (!fixture) return { ok: false, reason: `There is no drawer or door called "${phrase}". Tap a surface to add one.`, plannerName };
      const closing = /close|shut/.test(verb);
      steps.push(mkStep('navigate', fixture), mkStep(closing ? 'close' : 'open', fixture));
      lastFixture = fixture;
      summaryParts.push(`${closing ? 'close' : 'open'} ${fixture.name}`);
      continue;
    }
    if ((m = clause.match(GO_RE))) {
      const target = best(m[1], targets);
      if (!target) return { ok: false, reason: `I don't know where "${m[1]}" is.`, plannerName };
      steps.push(mkStep('navigate', target));
      summaryParts.push(`go to ${target.name}`);
      continue;
    }
    if ((m = clause.match(FETCH_RE))) {
      const item = best(m[1], items);
      if (!item) return { ok: false, reason: `I don't see "${m[1]}" in this room.`, plannerName };
      steps.push(mkStep('navigate', item), mkStep('pick', item));
      holding = item;
      summaryParts.push(`fetch ${item.name}`);
      continue;
    }
    if ((m = clause.match(TIDY_RE))) {
      // "tidy the table": every idle item on the table goes to the first zone tagged storage/shelf, else the first zone.
      const store = zones.find((z) => z.tags.some((t) => /shelf|storage|bin|cupboard|counter/i.test(t))) ?? zones[0];
      if (!store) return { ok: false, reason: 'Add a zone (e.g. "shelf") to tidy into.', plannerName };
      const loose = items.filter((i) => i.state !== 'placed' && i.zoneId !== store.id);
      if (loose.length === 0) return { ok: false, reason: 'Nothing loose to tidy.', plannerName };
      for (const it of loose) {
        steps.push(mkStep('navigate', it), mkStep('pick', it), mkStep('navigate', store), mkStep('place', store));
      }
      summaryParts.push(`tidy ${loose.length} item(s) → ${store.name}`);
      continue;
    }
    return {
      ok: false,
      reason: `I can't parse "${clause}". Try: "put the red mug on the shelf", "open the top drawer", "go to the table".`,
      plannerName,
    };
  }
  if (steps.length === 0) return { ok: false, reason: 'Nothing to do.', plannerName };
  return { ok: true, steps, summary: summaryParts.join('; '), plannerName };
}

/** Coerce an LLM-produced plan into Steps, validating every reference. */
export function stepsFromLlm(
  raw: { kind: string; target: string }[],
  entities: Entity[],
): { steps: Step[] } | { error: string } {
  const steps: Step[] = [];
  for (const r of raw) {
    const kind = r.kind as Step['kind'];
    if (!['navigate', 'pick', 'place', 'open', 'close'].includes(kind)) return { error: `unknown step kind ${r.kind}` };
    const pool =
      kind === 'pick'
        ? entities.filter((e) => e.kind === 'item')
        : kind === 'open' || kind === 'close'
          ? entities.filter((e) => e.kind === 'fixture')
          : entities;
    const target = best(r.target, pool);
    if (!target) return { error: `unknown target ${r.target}` };
    steps.push(mkStep(kind, target));
  }
  return { steps };
}

/**
 * Chore planner: plain English -> ordered robot steps.
 *
 * Two planners share one contract:
 *  - `planTaskLocal`  : deterministic grammar over the room's named entities.
 *                       Always available, runs in the browser and in Node.
 *  - Convex `planner.plan` action (LLM) : optional, used when a key is set;
 *                       falls back to this one on any failure or empty plan.
 *
 * The plan is deliberately transparent: every step names its target so the
 * ledger can show "navigate → red mug", "pick red mug", "open top drawer"...
 */

import type { Entity, Fixture, Item, RobotPose, Step, Zone } from './types';
import { dist2d, newId } from './types';

export type PlanResult =
  | { ok: true; steps: Step[]; summary: string; plannerName: string }
  | { ok: false; reason: string; plannerName: string };

const STOP = new Set([
  'the', 'a', 'an', 'my', 'your', 'our', 'that', 'this', 'those', 'these', 'please', 'go', 'ahead', 'now',
  'then', 'and', 'to', 'of', 'me', 'up', 'it', 'them', 'kitchen', 'room', 'some', 'one',
]);

export function singular(t: string): string {
  if (t.length > 4 && /(ss|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith('ves')) return t.slice(0, -3) + 'f';
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us')) return t.slice(0, -1);
  return t;
}

function rawTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t && !STOP.has(t));
}

export function tokens(s: string): string[] {
  return rawTokens(s).map(singular);
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
      else if (t.length >= 3 && nameTokens.some((n) => n.startsWith(t))) score += 0.5;
    }
    if (score > 0) {
      // Exact full-name match wins ties.
      if (nameTokens.join(' ') === pt.join(' ')) score += 3;
      // Small penalty for unmentioned extra tokens ("mug" prefers "mug" over "red mug" only when both exist).
      score -= 0.1 * Math.max(0, nameTokens.length - pt.length);
      out.push({ entity: e, score });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

type Pick<T extends Entity> = { entity: T } | { ambiguous: string[] } | { none: true };

/** Best match, but refuse to guess between equally good candidates. */
export function pickEntity<T extends Entity>(phrase: string, entities: T[]): Pick<T> {
  const m = matchEntities(phrase, entities);
  if (m.length === 0) return { none: true };
  if (m.length > 1 && m[0].score - m[1].score < 0.05) {
    return { ambiguous: m.filter((x) => m[0].score - x.score < 0.05).slice(0, 3).map((x) => x.entity.name) };
  }
  return { entity: m[0].entity };
}

function best<T extends Entity>(phrase: string, entities: T[]): T | null {
  const p = pickEntity(phrase, entities);
  return 'entity' in p ? p.entity : null;
}

function mkStep(kind: Step['kind'], target: Entity): Step {
  return { id: newId('s'), kind, targetId: target.id, targetName: target.name, status: 'queued' };
}

const PUT_RE =
  /^(?:please\s+)?(?:put|place|move|bring|take|carry|set|drop|return|deliver|stash|leave|stick)\s+(?:the\s+|a\s+|my\s+|all\s+(?:of\s+)?(?:the\s+)?|every\s+|both\s+(?:of\s+)?(?:the\s+)?)?(.+?)\s+(?:on(?:to)?|in(?:to|side)?|to|at|by|near|next to|onto|over to|back (?:on|in|to))\s+(?:the\s+|my\s+)?(.+)$/i;
const OPEN_RE = /^(?:please\s+)?(open|close|shut|pull open|push shut|slide open|slide shut)\s+(?:the\s+|my\s+)?(.+)$/i;
const GO_RE = /^(?:please\s+)?(?:go|walk|drive|navigate|head|come|roll)\s+(?:over\s+)?(?:to|near|toward|towards|by)\s+(?:the\s+|my\s+)?(.+)$/i;
const FETCH_RE =
  /^(?:please\s+)?(?:fetch|get|grab|pick up|pick|hold|lift|collect|find|bring me|hand me|give me|pass me|bring|hand|give|pass)\s+(?:me\s+)?(?:the\s+|a\s+|my\s+|all\s+(?:of\s+)?(?:the\s+)?|every\s+|both\s+(?:of\s+)?(?:the\s+)?)?(.+?)(?:\s+(?:for me|to me|here|over here|please))?$/i;
const TIDY_RE = /^(?:please\s+)?(?:tidy|clean|clear)\s+(?:up\s+)?(?:the\s+)?(.+)$/i;
const PRONOUN_RE = /^(it|that|this|them|these|those)$/i;
const HERE_RE = /^(me|here|you|us|over here|over|my hand|hand)$/i;
const ALL_RE = /^(all|everything|every item|all the items|all items|all of them|both|the items|the things|things|stuff|all the stuff)$/i;

export function splitClauses(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(
      /\s*(?:,|;|\.|\bthen\b|\band then\b|\bafter that\b|\bfinally\b|\band\b(?=\s+(?:put|place|move|bring|take|carry|set|drop|open|close|shut|go|walk|drive|fetch|get|grab|pick|tidy|clean|clear|return|hand|give|pass|find|lift|collect|deliver)))\s*/i,
    )
    .map((c) => c.trim())
    .filter(Boolean);
}

export function planTaskLocal(text: string, entities: Entity[], robot: RobotPose): PlanResult {
  const plannerName = 'rule-based planner';
  const items = entities.filter((e): e is Item => e.kind === 'item' && !e.clutter);
  const fixtures = entities.filter((e): e is Fixture => e.kind === 'fixture');
  const zones = entities.filter((e): e is Zone => e.kind === 'zone');
  const targets: Entity[] = [...zones, ...fixtures, ...items];
  const clauses = splitClauses(text);
  if (clauses.length === 0) return { ok: false, reason: 'Empty chore.', plannerName };

  const steps: Step[] = [];
  const summaryParts: string[] = [];
  /** What the robot is holding, across clauses and across chores ("get the mug", then "put it on the table"). */
  let holding: Item | null = robot.carrying ? (items.find((i) => i.id === robot.carrying) ?? null) : null;
  /** Fixture state as the plan evolves ("open the drawer, put the mug in it, close it"). */
  const openness = new Map<string, number>(fixtures.map((f) => [f.id, f.openness]));
  let lastFixture: Fixture | null = null;
  let lastTarget: Entity | null = null;

  const fail = (reason: string): PlanResult => ({ ok: false, reason, plannerName });

  /** Resolve an item phrase to one or more items; handles pronouns, conjunctions, plurals and "all". */
  const resolveItems = (phrase: string): Item[] | PlanResult => {
    const p = phrase.trim();
    if (PRONOUN_RE.test(p)) {
      if (holding) return [holding];
      return fail(`"${p}" — I'm not holding anything. Name the item.`);
    }
    if (ALL_RE.test(p)) {
      const loose = items.filter((i) => i.state !== 'held');
      return loose.length ? loose : fail('There are no items to move.');
    }
    const parts = p.split(/\s*(?:,|\band\b|&|\bplus\b)\s*/i).map((s) => s.replace(/^(the|a|my)\s+/i, '').trim()).filter(Boolean);
    const out: Item[] = [];
    for (const part of parts) {
      // Plural noun ("mugs", "bottles") or "both mugs" → every matching item.
      const raw = rawTokens(part);
      const lastRaw = raw[raw.length - 1] ?? '';
      const plural = lastRaw.length > 3 && lastRaw.endsWith('s') && singular(lastRaw) !== lastRaw;
      if (plural) {
        const all = matchEntities(part, items).filter((m) => m.score >= 1);
        if (all.length >= 2) {
          for (const m of all) if (!out.some((o) => o.id === m.entity.id)) out.push(m.entity);
          continue;
        }
      }
      const pick = pickEntity(part, items);
      if ('ambiguous' in pick) return fail(`Which one: ${pick.ambiguous.join(' or ')}?`);
      if ('none' in pick) return fail(`I don't see "${part}" in this room.`);
      if (!out.some((o) => o.id === pick.entity.id)) out.push(pick.entity);
    }
    return out.length ? out : fail(`I don't see "${p}" in this room.`);
  };

  const resolveTarget = (phrase: string, exclude: Set<string>): Entity | PlanResult => {
    const p = phrase.trim();
    if (PRONOUN_RE.test(p)) {
      const t = lastFixture ?? lastTarget;
      return t ?? fail(`"${p}" — which place do you mean?`);
    }
    const pick = pickEntity(p, targets.filter((t) => !exclude.has(t.id)));
    if ('ambiguous' in pick) return fail(`Which one: ${pick.ambiguous.join(' or ')}?`);
    if ('none' in pick) return fail(`No place called "${p}" in this room.`);
    return pick.entity;
  };

  const emitFetch = (item: Item): PlanResult | null => {
    if (holding && holding.id !== item.id) return fail(`I'm holding ${holding.name} — tell me where to put it first.`);
    if (holding?.id === item.id) return null;
    steps.push(mkStep('navigate', item), mkStep('pick', item));
    holding = item;
    lastTarget = item;
    return null;
  };

  const emitPlace = (item: Item, target: Entity): PlanResult | null => {
    const err = emitFetch(item);
    if (err) return err;
    steps.push(mkStep('navigate', target));
    if (target.kind === 'fixture' && (openness.get(target.id) ?? target.openness) < 0.5) {
      steps.push(mkStep('open', target));
      openness.set(target.id, 1);
      lastFixture = target;
    }
    steps.push(mkStep('place', target));
    holding = null;
    lastTarget = target;
    return null;
  };

  for (const clause of clauses) {
    let m: RegExpMatchArray | null;
    if ((m = clause.match(PUT_RE)) && !HERE_RE.test(m[2].trim())) {
      const resolved = resolveItems(m[1]);
      if (!Array.isArray(resolved)) return resolved;
      const target = resolveTarget(m[2], new Set(resolved.map((r) => r.id)));
      if (!('kind' in target)) return target;
      for (const item of resolved) {
        const err = emitPlace(item, target);
        if (err) return err;
      }
      summaryParts.push(`${resolved.map((r) => r.name).join(' + ')} → ${target.name}`);
      continue;
    }
    if ((m = clause.match(OPEN_RE))) {
      const verb = m[1].toLowerCase();
      const phrase = m[2];
      let fixture: Fixture | null;
      if (PRONOUN_RE.test(phrase.trim())) fixture = lastFixture;
      else {
        const pick = pickEntity(phrase, fixtures);
        if ('ambiguous' in pick) return fail(`Which one: ${pick.ambiguous.join(' or ')}?`);
        fixture = 'entity' in pick ? pick.entity : null;
      }
      if (!fixture) return fail(`There is no drawer or door called "${phrase}". Tap a surface to add one.`);
      const closing = /close|shut/.test(verb);
      steps.push(mkStep('navigate', fixture), mkStep(closing ? 'close' : 'open', fixture));
      openness.set(fixture.id, closing ? 0 : 1);
      lastFixture = fixture;
      lastTarget = fixture;
      summaryParts.push(`${closing ? 'close' : 'open'} ${fixture.name}`);
      continue;
    }
    if ((m = clause.match(GO_RE))) {
      const target = resolveTarget(m[1], new Set());
      if (!('kind' in target)) return target;
      steps.push(mkStep('navigate', target));
      lastTarget = target;
      summaryParts.push(`go to ${target.name}`);
      continue;
    }
    // "bring the mug to me" / "put the bottle here" → a fetch.
    const putHere = clause.match(PUT_RE);
    const fetchPhrase = putHere && HERE_RE.test(putHere[2].trim()) ? putHere[1] : (m = clause.match(FETCH_RE)) ? m[1] : null;
    if (fetchPhrase !== null) {
      const resolved = resolveItems(fetchPhrase);
      if (!Array.isArray(resolved)) return resolved;
      if (resolved.length > 1) return fail(`I can carry one thing at a time — say where to put ${resolved[0].name} first.`);
      const err = emitFetch(resolved[0]);
      if (err) return err;
      summaryParts.push(`fetch ${resolved[0].name}`);
      continue;
    }
    if ((m = clause.match(TIDY_RE))) {
      // "tidy the table": everything on/near that zone goes to storage; "tidy the room": every loose item.
      const phrase = m[1];
      const storeZone = zones.find((z) => z.tags.some((t) => /shelf|storage|bin|cupboard|counter|rack/i.test(t))) ?? zones[0];
      if (!storeZone) return fail('Add a zone (e.g. "shelf") to tidy into.');
      const where = /room|up|everything|floor|place|here/i.test(phrase) ? null : best(phrase, zones.filter((z) => z.id !== storeZone.id) as Zone[]);
      const loose = where
        ? items.filter((i) => i.state !== 'held' && (i.zoneId === where.id || dist2d(i.pos, where.pos) < where.radius + 0.5))
        : items.filter((i) => i.state !== 'held' && i.zoneId !== storeZone.id);
      if (loose.length === 0) return fail(where ? `Nothing on ${where.name} to tidy.` : 'Nothing loose to tidy.');
      for (const it of loose) {
        const err = emitPlace(it, storeZone);
        if (err) return err;
      }
      summaryParts.push(`tidy ${loose.length} item(s) → ${storeZone.name}`);
      continue;
    }
    return fail(`I can't parse "${clause}". Try: "put the red mug on the shelf", "open the top drawer", "bring me the bottle".`);
  }
  if (steps.length === 0) return fail(holding ? `Already holding ${holding.name}.` : 'Nothing to do.');
  return { ok: true, steps, summary: summaryParts.join('; '), plannerName };
}

/** Coerce an LLM-produced plan into Steps, validating every reference. An empty plan is an error. */
export function stepsFromLlm(
  raw: { kind: string; target: string }[],
  entities: Entity[],
): { steps: Step[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'empty plan' };
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

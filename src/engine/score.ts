/**
 * Scoring engine. Port of WW engine/score.py (commit 6f01c29) with the app's rules:
 * D20 (combineFactors), D21 (date kinds), D33 (explicit members, quick-win flag, no enables/tracks).
 * Priority = 100 · cod · U · C / size, cod per combineFactors (HANDOFF D20)
 * Every scale is absolutely anchored; the clock is injected (asOf).
 */
import { daysBetween, toDayNumber, type IsoDate } from './dates';
import { nextMoves } from './nextMoves';
import { pyRound } from './round';
import {
  FORCED_NOW_DAYS,
  SATISFIES_STATUSES,
  SCORED_STATUSES,
  type Band,
  type Criterion,
  type EngineConfig,
  type NonNegotiable,
  type ProjectInput,
  type ScoredProject,
  type Weights,
} from './types';

const BAND_RANK: Record<Band, number> = { NOW: 0, NEXT: 1, SOON: 2, SOMEDAY: 3 };

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** R = 10 · (P × Cq) / 25 */
export function scoreRisk(p: ProjectInput): number {
  return (10 * (p.probability * p.consequence)) / 25;
}

/** V = mean over people of min(10, reach × impact / 3). */
export function scoreValue(
  p: ProjectInput,
  people: readonly string[],
): { V: number; perPerson: Record<string, number>; spread: number } {
  const perPerson: Record<string, number> = {};
  const vals: number[] = [];
  for (const who of people) {
    const imp = hasOwn(p.impacts, who) ? (p.impacts[who] as number) : 1.0;
    const v = Math.min(10, (p.reach * imp) / 3);
    perPerson[who] = v;
    vals.push(v);
  }
  const list = vals.length ? vals : [0];
  const V = list.reduce((a, b) => a + b, 0) / list.length;
  return { V, perPerson, spread: Math.max(...list) - Math.min(...list) };
}

/** Piecewise-anchored payback ratio → 0–10. */
export function scoreFinance(p: ProjectInput, cfg: EngineConfig): { F: number; fpr: number } {
  const cost = Math.max(p.cost, 1);
  const netAnnual = (p.annualSavings ?? 0) - (p.annualCarryingCost ?? 0);
  const fpr = (cost * (p.recoupPct ?? 0) + cfg.horizonYears * netAnnual) / cost;
  const anchors = cfg.fprAnchors;
  const x = Math.max(0, fpr);
  const last = anchors[anchors.length - 1]!;
  if (x >= last[0]) return { F: last[1], fpr };
  for (let i = 0; i + 1 < anchors.length; i++) {
    const [x0, y0] = anchors[i]!;
    const [x1, y1] = anchors[i + 1]!;
    if (x <= x1) return { F: y0 + ((y1 - y0) * (x - x0)) / (x1 - x0), fpr };
  }
  return { F: last[1], fpr };
}

export function scoreEnablement(nDependents: number): number {
  if (nDependents >= 2) return 10;
  if (nDependents === 1) return 7;
  return 0;
}

/** Years since identified, never negative: a future date must not lower urgency (or reach 0). */
function yearsSince(p: ProjectInput, asOf: IsoDate): number {
  return Math.max(0, daysBetween(p.identified ?? asOf, asOf) / 365.25);
}

/** null/undefined mean "no date"; anything else, "" included, must be a real YYYY-MM-DD. */
function checkDates(p: ProjectInput): void {
  for (const field of ['identified', 'deadline'] as const) {
    const value = p[field];
    if (value == null) continue;
    try {
      toDayNumber(value);
    } catch (e) {
      throw new Error(
        `Project "${p.id}": invalid ${field} date — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/** U evaluated `yearsAhead` from asOf. U today is urgencyAt(p, asOf, 0). */
export function urgencyAt(p: ProjectInput, asOf: IsoDate, yearsAhead: number): number {
  const years = yearsSince(p, asOf) + yearsAhead;
  switch (p.urgency ?? 'standard') {
    case 'expedite':
      return 2.0;
    case 'hard_deadline':
    case 'target_date': {
      // D21: replaces WW's fixed_date.
      if (!p.deadline) return 1.0;
      const months = daysBetween(asOf, p.deadline) / 30.44 - yearsAhead * 12;
      if (p.urgency === 'hard_deadline') {
        if (months <= 0) return 2.5; // never less urgent once passed (WW dropped to 1.0)
        return 1.0 + 1.5 * Math.max(0, 1 - months / 6);
      }
      if (months <= 0) return 1.5;
      return 1.0 + 0.5 * Math.max(0, 1 - months / 3);
    }
    case 'intangible':
      return Math.min(2.5, 1.0 + 0.08 * years);
    case 'constant_benefit':
      return Math.min(1.5, 1.0 + 0.05 * years);
    default:
      return 1.0;
  }
}

/** D21: overdue / past-target flags and the forced-Now window. */
export function dateFlags(
  p: ProjectInput,
  asOf: IsoDate,
): { overdue: boolean; pastTarget: boolean; forcedNow: boolean } {
  if (!p.deadline) return { overdue: false, pastTarget: false, forcedNow: false };
  const days = daysBetween(asOf, p.deadline);
  const hard = p.urgency === 'hard_deadline';
  const target = p.urgency === 'target_date';
  return {
    overdue: hard && days < 0,
    pastTarget: target && days < 0,
    forcedNow: hard && days <= FORCED_NOW_DAYS,
  };
}

export function bandOf(
  priority: number,
  nonNegotiable: NonNegotiable | null,
  forcedNow: boolean,
  cfg: EngineConfig,
): Band {
  if (nonNegotiable || forcedNow) return 'NOW';
  if (priority >= cfg.bands.NOW) return 'NOW';
  if (priority >= cfg.bands.NEXT) return 'NEXT';
  if (priority >= cfg.bands.SOON) return 'SOON';
  return 'SOMEDAY';
}

const mapValues = (o: Record<string, number>, f: (v: number) => number) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));

/** D20: R and V always count; F and E count only when they raise the weighted average. */
export function combineFactors(f: Record<Criterion, number>, w: Weights): number {
  let num = w.risk * f.risk + w.value * f.value;
  let den = w.risk + w.value;
  const optional = (['finance', 'enablement'] as const)
    .map((k) => ({ k, v: f[k] }))
    .sort((a, b) => b.v - a.v);
  for (const { k, v } of optional) {
    if (den > 0 && v > num / den) {
      num += w[k] * v;
      den += w[k];
    }
  }
  return den > 0 ? num / den : 0;
}

/** Costs below this rank as the "Under $50" chip amount (P5c-6): $0 and $30 are alike. */
export const SMALL_COST = 50;
export const SMALL_COST_AS = 30;

/** The cost the size term uses; the shown cost and every other rule keep the entered amount. */
export function sizeCost(cost: number): number {
  return cost < SMALL_COST ? SMALL_COST_AS : cost;
}

/**
 * Score every project in a scored status. Dependencies resolve against the whole list.
 * Every project's dates are validated first (a bad one throws, naming project and field).
 * Sort order: non-negotiable first, then band (NOW, NEXT, SOON, SOMEDAY), then priority
 * descending, cost ascending, id. Band before priority keeps a forced-Now deadline above
 * Next and Soon even when its priority is low.
 */
export function scoreAll(
  projects: readonly ProjectInput[],
  cfg: EngineConfig,
  asOf: IsoDate,
): ScoredProject[] {
  for (const p of projects) checkDates(p);
  const statusOf = (p: ProjectInput) => p.status ?? 'open';
  const active = projects.filter((p) => SCORED_STATUSES.has(statusOf(p)));
  const activeIds = new Set(active.map((p) => p.id));
  const doneIds = new Set(
    projects.filter((p) => SATISFIES_STATUSES.has(statusOf(p))).map((p) => p.id),
  );
  const titles = new Map(active.map((p) => [p.id, p.title || p.id]));

  // Reverse dependency index over active projects.
  const dependents = new Map<string, string[]>();
  const addDependent = (of: string, dep: string) => {
    const list = dependents.get(of) ?? [];
    if (!list.includes(dep)) list.push(dep);
    dependents.set(of, list);
  };
  for (const p of active) {
    for (const dep of p.dependsOn ?? []) if (activeIds.has(dep)) addDependent(dep, p.id);
  }

  const w = cfg.weights;
  const out = active.map((p): ScoredProject => {
    const R = scoreRisk(p);
    const { V, perPerson, spread } = scoreValue(p, cfg.members);
    const { F, fpr } = scoreFinance(p, cfg);
    const blocks = dependents.get(p.id) ?? [];
    const E = scoreEnablement(blocks.length);
    const U = urgencyAt(p, asOf, 0);
    const C = p.costConfidence ? cfg.confidence[p.costConfidence] : cfg.confidenceFallback;
    const cod = combineFactors({ risk: R, value: V, finance: F, enablement: E }, w); // D20
    const codAdj = cod * U * C;
    const size = Math.log10(sizeCost(p.cost) + 10) * (1 + cfg.effortK * p.effort);
    const priority = size > 0 ? pyRound((100 * codAdj) / size, 1) : 0;
    const blockedBy = (p.dependsOn ?? []).filter((d) => activeIds.has(d) && !doneIds.has(d));
    const nonNegotiable = p.nonNegotiable ?? null;
    const flags = dateFlags(p, asOf);
    const project = (n: number) => pyRound((priority * urgencyAt(p, asOf, n)) / U, 1);

    const rec: ScoredProject = {
      id: p.id,
      title: p.title || p.id,
      cost: p.cost,
      effort: p.effort,
      R: pyRound(R, 2),
      V: pyRound(V, 2),
      F: pyRound(F, 2),
      E: pyRound(E, 2),
      U: pyRound(U, 3),
      C,
      perPerson: mapValues(perPerson, (v) => pyRound(v, 2)),
      disagreement: pyRound(spread, 2),
      fpr: pyRound(fpr, 3),
      cod: pyRound(cod, 3),
      codAdj: pyRound(codAdj, 3),
      size: pyRound(size, 3),
      priority,
      quickWin: p.cost < cfg.quickWinCost && p.effort <= cfg.quickWinEffort,
      nonNegotiable,
      band: bandOf(priority, nonNegotiable, flags.forcedNow, cfg),
      urgency: p.urgency ?? 'standard',
      costConfidence: p.costConfidence ?? null,
      status: statusOf(p),
      dependsOn: [...(p.dependsOn ?? [])],
      blocks: [...blocks],
      blockedBy,
      blocked: blockedBy.length > 0,
      ...flags,
      projection: { y0: project(0), y1: project(1), y3: project(3), y5: project(5) },
      nextMoves: [],
    };
    rec.nextMoves = nextMoves(
      rec,
      blockedBy.map((d) => titles.get(d) ?? d),
    );
    return rec;
  });

  out.sort(
    (a, b) =>
      Number(Boolean(b.nonNegotiable)) - Number(Boolean(a.nonNegotiable)) ||
      BAND_RANK[a.band] - BAND_RANK[b.band] ||
      b.priority - a.priority ||
      a.cost - b.cost ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return out;
}

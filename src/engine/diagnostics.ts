/** Port of WW engine/diagnostics.py: sensitivity and correlation only (HANDOFF §6.5). */
import type { IsoDate } from './dates';
import { pyRound } from './round';
import { scoreAll } from './score';
import type { EngineConfig, ProjectInput, ScoredProject } from './types';

const PERTURB = [
  ['probability', 1, 5],
  ['consequence', 1, 5],
  ['reach', 1, 10],
] as const;

/** Nudge P, Cq and reach one step each way. A band change means "on the edge". */
export function sensitivity(
  projects: readonly ProjectInput[],
  cfg: EngineConfig,
  asOf: IsoDate,
): Record<string, boolean> {
  const base = new Map(scoreAll(projects, cfg, asOf).map((r) => [r.id, r.band]));
  const unstable: Record<string, boolean> = {};
  for (const id of base.keys()) unstable[id] = false;
  for (const delta of [-1, 1]) {
    for (const [field, lo, hi] of PERTURB) {
      const trial = projects.map((p) => ({
        ...p,
        [field]: Math.max(lo, Math.min(hi, p[field] + delta)),
      }));
      for (const r of scoreAll(trial, cfg, asOf)) {
        if (base.has(r.id) && r.band !== base.get(r.id)) unstable[r.id] = true;
      }
    }
  }
  return unstable;
}

function rank(xs: readonly number[]): number[] {
  const order = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
  const r = new Array<number>(xs.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && xs[order[j + 1]!] === xs[order[i]!]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k]!] = avg;
    i = j + 1;
  }
  return r;
}

export function spearman(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  if (b.length !== n) throw new Error('spearman: inputs differ in length');
  const ra = rank(a);
  const rb = rank(b);
  const ma = ra.reduce((s, x) => s + x, 0) / n;
  const mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    const da = ra[i]! - ma;
    const db = rb[i]! - mb;
    num += da * db;
    sa += da * da;
    sb += db * db;
  }
  const den = Math.sqrt(sa * sb);
  return den ? num / den : 0;
}

export interface CorrelationFlag {
  pair: string;
  rho: number;
  flag: boolean;
}

/** Fewer projects than this and a rank correlation says nothing (HANDOFF §6.5). */
export const MIN_CORRELATION_PROJECTS = 5;

/** |rho| ≥ 0.8 means two criteria are measuring the same thing. [] below 5 projects. */
export function correlationCheck(
  recs: readonly Pick<ScoredProject, 'R' | 'V' | 'F' | 'E'>[],
): CorrelationFlag[] {
  if (recs.length < MIN_CORRELATION_PROJECTS) return [];
  const keys = ['R', 'V', 'F', 'E'] as const;
  const out: CorrelationFlag[] = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i]!;
      const b = keys[j]!;
      const rho = spearman(
        recs.map((r) => r[a]),
        recs.map((r) => r[b]),
      );
      out.push({ pair: `${a}~${b}`, rho: pyRound(rho, 3), flag: Math.abs(rho) >= 0.8 });
    }
  }
  return out;
}

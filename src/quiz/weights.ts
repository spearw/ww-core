/**
 * Quiz answers → priorities (HANDOFF §5.5). Pure. Mirrored operation for operation by
 * tools/oracle/quiz.py, which generates src/quiz/__fixtures__/weights-golden.json.
 */
import type { Criterion, Weights } from '../engine';

export const CRITERIA: readonly Criterion[] = ['risk', 'value', 'finance', 'enablement'];

export type Answer = 'definitelyA' | 'leanA' | 'tossUp' | 'leanB' | 'definitelyB';
export const ANSWERS: readonly Answer[] = [
  'definitelyA',
  'leanA',
  'tossUp',
  'leanB',
  'definitelyB',
];
export const ANSWER_RATIO: Readonly<Record<Answer, number>> = {
  definitelyA: 4,
  leanA: 2,
  tossUp: 1,
  leanB: 0.5,
  definitelyB: 0.25,
};

/** How much a line's impact matters: 0 low, 1 medium, 2 high. */
export type Tier = 0 | 1 | 2;
export const TIERS: readonly Tier[] = [0, 1, 2];
/** Each tier up counts for this many times as much as the one below. */
export const TIER_STEP = 2;

export const LAMBDA = 0.75;
export const FLOOR = 0.05;
export const CAP = 0.5;
export const RECHECK_THRESHOLD = Math.log(4);
export const FLAVOUR_MARGIN = 0.08;
export const BALANCER_SPREAD = 0.1;
export const DEFAULT_WEIGHTS: Readonly<Weights> = {
  risk: 0.4,
  value: 0.3,
  finance: 0.2,
  enablement: 0.1,
};

export interface CardRanking {
  best: Criterion;
  worst: Criterion;
}

export interface DuelObservation {
  a: Criterion;
  b: Criterion;
  answer: Answer;
  /** Impact tiers of the two lines shown. A missing tier is read as 0; give both or neither. */
  tierA?: Tier;
  tierB?: Tier;
}

export interface Estimate {
  prior: Weights;
  /** Log-utilities from the solve. */
  v: Weights;
  weights: Weights;
  residuals: number[];
  worstIndex: number;
  maxResidual: number;
}

/** ln(answer ratio) minus the tier gap: the target for v_a − v_b. */
export function duelTarget(d: DuelObservation): number {
  return Math.log(ANSWER_RATIO[d.answer]) - ((d.tierA ?? 0) - (d.tierB ?? 0)) * Math.log(TIER_STEP);
}

const toRecord = (xs: readonly number[]): Weights => ({
  risk: xs[0]!,
  value: xs[1]!,
  finance: xs[2]!,
  enablement: xs[3]!,
});

function addAt(M: number[][], i: number, j: number, x: number): void {
  const row = M[i]!;
  row[j] = row[j]! + x;
}

export function priorFromCards({ best, worst }: CardRanking): Weights {
  if (best === worst) throw new Error('best and worst must differ');
  return toRecord(CRITERIA.map((c) => (c === best ? 0.44 : c === worst ? 0.11 : 0.225)));
}

/** Solve A·x = b by Gaussian elimination with partial pivoting. */
export function solveLinear(A: readonly (readonly number[])[], b: readonly number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    }
    const tmp = M[col]!;
    M[col] = M[piv]!;
    M[piv] = tmp;
    const pr = M[col]!;
    for (let r = col + 1; r < n; r++) {
      const row = M[r]!;
      const f = row[col]! / pr[col]!;
      for (let k = col; k <= n; k++) row[k] = row[k]! - f * pr[k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const row = M[i]!;
    let s = row[n]!;
    for (let k = i + 1; k < n; k++) s = s - row[k]! * x[k]!;
    x[i] = s / row[i]!;
  }
  return x;
}

/** Find t ≥ 0 with Σ clamp(t·vᵢ, lo, hi) = total, and return the clamped values. */
export function scaleClamp(
  values: readonly number[],
  total: number,
  lo = FLOOR,
  hi = CAP,
): number[] {
  const n = values.length;
  if (values.some((v) => !(v > 0))) throw new RangeError('scaleClamp: values must be > 0');
  if (total < n * lo - 1e-9 || total > n * hi + 1e-9) {
    throw new RangeError(`scaleClamp: total ${total} out of range`);
  }
  const bps = [...new Set([...values.map((v) => lo / v), ...values.map((v) => hi / v)])].sort(
    (x, y) => x - y,
  );
  const edges = [0, ...bps, Infinity];
  for (let k = 0; k + 1 < edges.length; k++) {
    const t0 = edges[k]!;
    const t1 = edges[k + 1]!;
    const mid = (t0 + (t1 === Infinity ? t0 + 1 : t1)) / 2;
    let fixed = 0;
    let slope = 0;
    for (const v of values) {
      const x = mid * v;
      if (x <= lo) fixed += lo;
      else if (x >= hi) fixed += hi;
      else slope += v;
    }
    if (slope === 0) continue;
    const t = (total - fixed) / slope;
    if (t >= t0 - 1e-12 && t <= t1 + 1e-12)
      return values.map((v) => Math.min(hi, Math.max(lo, t * v)));
  }
  throw new Error('scaleClamp: no solution');
}

export function clampWeights(w: Weights): Weights {
  return toRecord(
    scaleClamp(
      CRITERIA.map((c) => w[c]),
      1,
    ),
  );
}

export function estimate(cards: CardRanking, duels: readonly DuelObservation[]): Estimate {
  const prior = priorFromCards(cards);
  const mu = CRITERIA.map((c) => Math.log(prior[c]));
  const A = CRITERIA.map(() => CRITERIA.map(() => 0));
  const rhs = CRITERIA.map(() => 0);
  for (const d of duels) {
    const i = CRITERIA.indexOf(d.a);
    const j = CRITERIA.indexOf(d.b);
    if (i === j) throw new Error('a duel needs two different criteria');
    const y = duelTarget(d);
    addAt(A, i, i, 1);
    addAt(A, j, j, 1);
    addAt(A, i, j, -1);
    addAt(A, j, i, -1);
    rhs[i] = rhs[i]! + y;
    rhs[j] = rhs[j]! - y;
  }
  for (let i = 0; i < CRITERIA.length; i++) {
    addAt(A, i, i, LAMBDA);
    rhs[i] = rhs[i]! + LAMBDA * mu[i]!;
  }
  const v = solveLinear(A, rhs);
  const m = Math.max(...v);
  const e = v.map((x) => Math.exp(x - m));
  let s = 0;
  for (const x of e) s += x;
  const weights = toRecord(
    scaleClamp(
      e.map((x) => x / s),
      1,
    ),
  );
  const residuals = duels.map(
    (d) => v[CRITERIA.indexOf(d.a)]! - v[CRITERIA.indexOf(d.b)]! - duelTarget(d),
  );
  let worstIndex = -1;
  let maxResidual = 0;
  residuals.forEach((r, k) => {
    if (worstIndex === -1 || Math.abs(r) > maxResidual) {
      worstIndex = k;
      maxResidual = Math.abs(r);
    }
  });
  return { prior, v: toRecord(v), weights, residuals, worstIndex, maxResidual };
}

export function needsRecheck(e: Estimate): boolean {
  return e.worstIndex >= 0 && e.maxResidual > RECHECK_THRESHOLD;
}

export function snapTarget(target: number): number {
  return Math.min(CAP, Math.max(FLOOR, Math.floor(target * 20 + 0.5) / 20));
}

/** Set one priority (5% steps, 5–50%); the other three share the rest in proportion. */
export function adjust(weights: Weights, criterion: Criterion, target: number): Weights {
  const t = snapTarget(target);
  const others = CRITERIA.filter((c) => c !== criterion);
  const vals = scaleClamp(
    others.map((c) => weights[c]),
    1 - t,
  );
  const out: Weights = { ...weights, [criterion]: t };
  others.forEach((c, k) => {
    out[c] = vals[k]!;
  });
  return out;
}

export type ArchetypeKey = 'firefighter' | 'enjoyer' | 'investor' | 'builder' | 'balancer';
export type LeaningKey = Exclude<ArchetypeKey, 'balancer'>;
export const ARCHETYPE_OF: Readonly<Record<Criterion, LeaningKey>> = {
  risk: 'firefighter',
  value: 'enjoyer',
  finance: 'investor',
  enablement: 'builder',
};

export interface Archetype {
  key: ArchetypeKey;
  flavour: LeaningKey | null;
}

export function archetypeOf(w: Weights, skipped = false): Archetype {
  const vals = CRITERIA.map((c) => w[c]);
  if (skipped || Math.max(...vals) - Math.min(...vals) < BALANCER_SPREAD) {
    return { key: 'balancer', flavour: null };
  }
  const order = [...CRITERIA].sort(
    (x, y) => w[y] - w[x] || CRITERIA.indexOf(x) - CRITERIA.indexOf(y),
  );
  const top = order[0]!;
  const second = order[1]!;
  return {
    key: ARCHETYPE_OF[top],
    flavour: w[top] - w[second] <= FLAVOUR_MARGIN + 1e-9 ? ARCHETYPE_OF[second] : null,
  };
}

const sameWeights = (x: Weights, y: Weights) => CRITERIA.every((c) => Math.abs(x[c] - y[c]) < 1e-9);

/**
 * The archetype to show. A skipped quiz is the All-Rounder (key `balancer`) only while the
 * priorities are still the defaults it gave (`quizWeights`); once a bar moves, the priorities decide.
 */
export function currentArchetype(
  w: Weights,
  quiz: { skipped: boolean; quizWeights: Weights | null } | null | undefined,
): Archetype {
  const untouched = quiz?.quizWeights ? sameWeights(w, quiz.quizWeights) : false;
  return archetypeOf(w, quiz?.skipped === true && untouched);
}

export function archetypeId(a: Archetype): string {
  return a.flavour ? `${a.key}:${a.flavour}` : a.key;
}

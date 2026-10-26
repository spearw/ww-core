import type {
  CostConfidence,
  NonNegotiable,
  ProjectInput,
  ScoredProject,
  Status,
  Urgency,
} from '../types';

export interface AppInput {
  id: string;
  title?: string;
  cost: number;
  cost_confidence: string | null;
  effort: number;
  risk: { probability: number; consequence: number };
  value: { reach: number; impact: Record<string, number> };
  finance: { recoup_pct: number; annual_savings: number; annual_carrying_cost: number };
  urgency?: string;
  identified?: string | null;
  deadline?: string | null;
  non_negotiable?: string | null;
  status?: string;
  depends_on?: string[];
}

export interface AppCase {
  id: string;
  what: string;
  input: AppInput;
  expect: Record<string, unknown>;
}

export interface AppSuite {
  name: string;
  members: string[];
  cases: AppCase[];
}

export interface AppFixture {
  as_of: string;
  weights: { risk: number; value: number; finance: number; enablement: number };
  horizon_years: number;
  bands?: { NOW: number; NEXT: number; SOON: number };
  suites: AppSuite[];
}

export function fromApp(c: AppInput): ProjectInput {
  return {
    id: c.id,
    title: c.title ?? '',
    cost: c.cost,
    costConfidence: (c.cost_confidence ?? null) as CostConfidence | null,
    effort: c.effort,
    probability: c.risk.probability,
    consequence: c.risk.consequence,
    reach: c.value.reach,
    impacts: { ...c.value.impact },
    recoupPct: c.finance.recoup_pct,
    annualSavings: c.finance.annual_savings,
    annualCarryingCost: c.finance.annual_carrying_cost,
    urgency: (c.urgency ?? 'standard') as Urgency,
    identified: c.identified ?? null,
    deadline: c.deadline ?? null,
    nonNegotiable: (c.non_negotiable ?? null) as NonNegotiable | null,
    dependsOn: c.depends_on ?? [],
    status: (c.status ?? 'open') as Status,
  };
}

const TOL: Record<string, number> = {
  R: 0.01,
  V: 0.01,
  split: 0.01,
  fpr: 0.01,
  F: 0.01,
  E: 0.01,
  U: 0.005,
  C: 0.005,
  cod: 0.01,
  cod_adj: 0.01,
  size: 0.005,
  priority: 0.06,
};
const PROJECTION_TOL = 0.06;

// Fixture key → value on the scored project.
const FIELD: Record<string, (r: ScoredProject) => unknown> = {
  R: (r) => r.R,
  V: (r) => r.V,
  split: (r) => r.disagreement,
  fpr: (r) => r.fpr,
  F: (r) => r.F,
  E: (r) => r.E,
  U: (r) => r.U,
  C: (r) => r.C,
  cod: (r) => r.cod,
  cod_adj: (r) => r.codAdj,
  size: (r) => r.size,
  priority: (r) => r.priority,
  band: (r) => r.band,
  blocked: (r) => r.blocked,
  blocks: (r) => [...r.blocks].sort(),
  projection: (r) => r.projection,
  next_moves: (r) => r.nextMoves.map((m) => m.kind),
  overdue: (r) => r.overdue,
  past_target: (r) => r.pastTarget,
  forced_now: (r) => r.forcedNow,
  quick_win: (r) => r.quickWin,
};

export function mismatches(want: Record<string, unknown>, rec: ScoredProject): string[] {
  const out: string[] = [];
  for (const [key, w] of Object.entries(want)) {
    const get = FIELD[key];
    if (!get) {
      out.push(`${key}: not checked by this engine yet`);
      continue;
    }
    const g = get(rec);
    if (key in TOL) {
      if (Math.abs((g as number) - (w as number)) > TOL[key]! + 1e-9) {
        out.push(`${key}: got ${String(g)}, want ${String(w)}`);
      }
    } else if (key === 'projection') {
      for (const [n, wv] of Object.entries(w as Record<string, number>)) {
        const gv = (g as Record<string, number>)[n]!;
        if (Math.abs(gv - wv) > PROJECTION_TOL + 1e-9)
          out.push(`projection.${n}: got ${gv}, want ${wv}`);
      }
    } else if (JSON.stringify(g) !== JSON.stringify(w)) {
      out.push(`${key}: got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`);
    }
  }
  return out;
}

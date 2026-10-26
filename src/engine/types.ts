import type { IsoDate } from './dates';
import type { NextMove } from './nextMoves';

export type Criterion = 'risk' | 'value' | 'finance' | 'enablement';
export type Weights = Record<Criterion, number>;
export type CostConfidence = 'quoted' | 'estimate' | 'guess';
export type NonNegotiable = 'safety' | 'health' | 'legal';
export type Status = 'open' | 'deferred' | 'in_progress' | 'done' | 'dropped';
export type Urgency =
  'standard' | 'intangible' | 'constant_benefit' | 'expedite' | 'hard_deadline' | 'target_date';
export type Band = 'NOW' | 'NEXT' | 'SOON' | 'SOMEDAY';

/** D21: a real deadline this close (or passed) is forced into Now. */
export const FORCED_NOW_DAYS = 30;

export const SCORED_STATUSES: ReadonlySet<Status> = new Set(['open', 'deferred', 'in_progress']);
export const SATISFIES_STATUSES: ReadonlySet<Status> = new Set(['done']);

export interface ProjectInput {
  id: string;
  title?: string;
  cost: number;
  /** null = unknown, scored with `confidenceFallback`. */
  costConfidence: CostConfidence | null;
  effort: number;
  probability: number;
  consequence: number;
  reach: number;
  /** Impact per person id. A person with no entry counts as 1. */
  impacts: Record<string, number>;
  recoupPct?: number;
  annualSavings?: number;
  annualCarryingCost?: number;
  urgency?: Urgency;
  /** Set once at creation; drives escalation. Missing = asOf. */
  identified?: IsoDate | null;
  deadline?: IsoDate | null;
  nonNegotiable?: NonNegotiable | null;
  /** "Do first" project ids. */
  dependsOn?: string[];
  status?: Status;
}

export interface EngineConfig {
  /** Everyone on the list. Each gets a V entry; a missing impact counts as 1 (D33). */
  members: readonly string[];
  weights: Weights;
  horizonYears: number;
  bands: { NOW: number; NEXT: number; SOON: number };
  // v1: effortK, confidence, confidenceFallback, quickWinCost, quickWinEffort and fprAnchors
  // are fixed constants. The oracle hard-codes them, so only their defaults are contract-tested;
  // changing one here without changing the oracle breaks lockstep.
  effortK: number;
  confidence: Record<CostConfidence, number>;
  confidenceFallback: number;
  quickWinCost: number;
  quickWinEffort: number;
  fprAnchors: readonly (readonly [number, number])[];
}

export interface Projection {
  y0: number;
  y1: number;
  y3: number;
  y5: number;
}

export interface ScoredProject {
  id: string;
  title: string;
  cost: number;
  effort: number;
  R: number;
  V: number;
  F: number;
  E: number;
  U: number;
  C: number;
  perPerson: Record<string, number>;
  disagreement: number;
  fpr: number;
  cod: number;
  codAdj: number;
  size: number;
  priority: number;
  /** Cost under quickWinCost and effort ≤ quickWinEffort. */
  quickWin: boolean;
  nonNegotiable: NonNegotiable | null;
  band: Band;
  urgency: Urgency;
  costConfidence: CostConfidence | null;
  status: Status;
  dependsOn: string[];
  blocks: string[];
  blockedBy: string[];
  blocked: boolean;
  /** D21: a real deadline has passed. */
  overdue: boolean;
  /** D21: a target date has passed. */
  pastTarget: boolean;
  /** D21: a real deadline is within FORCED_NOW_DAYS or passed. */
  forcedNow: boolean;
  projection: Projection;
  nextMoves: NextMove[];
}

export function defaultConfig(members: readonly string[]): EngineConfig {
  return {
    members: [...members],
    weights: { risk: 0.4, value: 0.3, finance: 0.2, enablement: 0.1 },
    horizonYears: 10,
    bands: { NOW: 121.5, NEXT: 85.5, SOON: 45 }, // Calibrated against WW's bands (tools/oracle/calibration-report.md), HANDOFF D20.
    effortK: 0.15,
    confidence: { quoted: 1.0, estimate: 0.85, guess: 0.7 },
    confidenceFallback: 0.85,
    quickWinCost: 200,
    quickWinEffort: 2,
    fprAnchors: [
      [0, 0],
      [0.25, 1.5],
      [0.5, 3],
      [0.75, 4.5],
      [1, 6],
      [1.5, 7.5],
      [2, 8.5],
      [3, 10],
    ],
  };
}

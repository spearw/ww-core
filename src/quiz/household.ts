import type { Weights } from '../engine';
import { CRITERIA, DEFAULT_WEIGHTS } from './weights';

export interface MemberWeights {
  memberId: string;
  weights: Weights;
}

/**
 * The household's weights: the arithmetic mean of each current member's profile (HANDOFF A1).
 * A convex combination of valid weights is valid, so no re-clamp. Profiles of people who have
 * left are ignored; with none left, DEFAULT_WEIGHTS.
 */
export function householdWeights(
  profiles: readonly MemberWeights[],
  memberIds: readonly string[],
): Weights {
  const current = profiles.filter((p) => memberIds.includes(p.memberId));
  if (current.length === 0) return { ...DEFAULT_WEIGHTS };
  const out = { ...DEFAULT_WEIGHTS };
  for (const c of CRITERIA) {
    out[c] = current.reduce((s, p) => s + p.weights[c], 0) / current.length;
  }
  return out;
}

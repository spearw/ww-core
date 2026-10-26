import type { ScoredProject } from './types';

/** Plain-language suggestions as codes. The app owns all wording (HANDOFF D23). */
export type NextMove =
  | { kind: 'get_real_price'; cost: number }
  | { kind: 'blocked_by'; titles: string[] }
  | { kind: 'unblocks_many'; count: number }
  | { kind: 'disagree' }
  | { kind: 'spending_not_investing' }
  | { kind: 'escalating' }
  | { kind: 'overdue' }
  | { kind: 'past_target' };

export type NextMoveInput = Pick<
  ScoredProject,
  | 'costConfidence'
  | 'cost'
  | 'blockedBy'
  | 'blocks'
  | 'disagreement'
  | 'fpr'
  | 'urgency'
  | 'U'
  | 'overdue'
  | 'pastTarget'
>;

/** Port of WW next_actions: same conditions, same order, codes instead of sentences. */
export function nextMoves(r: NextMoveInput, blockedByTitles: readonly string[]): NextMove[] {
  const out: NextMove[] = [];
  if (r.costConfidence === 'guess' && r.cost > 5000)
    out.push({ kind: 'get_real_price', cost: r.cost });
  if (r.blockedBy.length) out.push({ kind: 'blocked_by', titles: [...blockedByTitles] });
  if (r.blocks.length >= 2) out.push({ kind: 'unblocks_many', count: r.blocks.length });
  if (r.disagreement >= 3) out.push({ kind: 'disagree' });
  if (r.fpr < 0.5 && r.cost > 10_000) out.push({ kind: 'spending_not_investing' });
  if (r.urgency === 'intangible' && r.U > 1.3) out.push({ kind: 'escalating' });
  if (r.overdue) out.push({ kind: 'overdue' }); // D21
  if (r.pastTarget) out.push({ kind: 'past_target' }); // D21
  return out;
}

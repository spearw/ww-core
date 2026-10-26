export type Assignee = string | 'together' | null;

/** Members who have not set their own impact (a row set by someone else does not count). */
export function notWeighedIn(
  impacts: readonly { memberId: string; setBy: string }[],
  memberIds: readonly string[],
): string[] {
  const own = new Set(impacts.filter((i) => i.memberId === i.setBy).map((i) => i.memberId));
  return memberIds.filter((m) => !own.has(m));
}

/** Who a step goes to: its assignee if still a member, otherwise everyone. */
export function recipientsFor(assignee: Assignee, memberIds: readonly string[]): string[] {
  if (assignee !== null && assignee !== 'together' && memberIds.includes(assignee)) {
    return [assignee];
  }
  return [...memberIds];
}

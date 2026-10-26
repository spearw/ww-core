export interface Positioned {
  id: string;
  position: number;
}

/** Sort by position, ties broken by id, so every device agrees. */
export function stableOrder<T extends Positioned>(rows: readonly T[]): T[] {
  return [...rows].sort((x, y) =>
    x.position !== y.position ? x.position - y.position : x.id < y.id ? -1 : x.id > y.id ? 1 : 0,
  );
}

function diffDense(rows: readonly Positioned[], ordered: readonly Positioned[]): Positioned[] {
  const old = new Map(rows.map((r) => [r.id, r.position]));
  const writes: Positioned[] = [];
  ordered.forEach((r, position) => {
    if (old.get(r.id) !== position) writes.push({ id: r.id, position });
  });
  return writes;
}

/** Rows that must change for positions to be 0..n-1 in stable order. */
export function renumber(rows: readonly Positioned[]): Positioned[] {
  return diffDense(rows, stableOrder(rows));
}

/** Move `id` to `toIndex` (clamped); returns only the rows whose position changes. */
export function moveWrites(rows: readonly Positioned[], id: string, toIndex: number): Positioned[] {
  const ordered = stableOrder(rows);
  const from = ordered.findIndex((r) => r.id === id);
  if (from < 0) return [];
  const [moved] = ordered.splice(from, 1);
  if (!moved) return [];
  ordered.splice(Math.max(0, Math.min(toIndex, ordered.length)), 0, moved);
  return diffDense(rows, ordered);
}

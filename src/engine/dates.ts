/** A calendar date, `YYYY-MM-DD`. No time of day and no time zone. */
export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Days since 1970-01-01. Throws on malformed or impossible dates. */
export function toDayNumber(date: IsoDate): number {
  const m = ISO_DATE.exec(date);
  if (!m) throw new Error(`Invalid date "${date}": expected YYYY-MM-DD`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new Error(`Invalid date "${date}": no such day`);
  }
  return ms / MS_PER_DAY;
}

/** Whole days from `from` to `to`, negative if `to` is earlier. Python: `(to - from).days`. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return toDayNumber(to) - toDayNumber(from);
}

import { getTableConfig } from 'drizzle-orm/sqlite-core';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { WireRow } from './types';

const SERVER_SET = new Set(['updated_at', 'updated_by']);

/** Postgres answers uuids lowercase; both directions lowercase `id` so the answer matches. */
const normaliseId = (v: unknown): string => String(v).toLowerCase();

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * A server timestamp (`2026-10-26 10:00:00.123456+00`, `…T…+00:00`, `…Z`) → ISO milliseconds.
 * Parsed by hand: Hermes' Date parser refuses more than 3 fractional digits.
 */
export function isoMillis(v: string): string {
  const m = TIMESTAMP.exec(v);
  if (!m) throw new Error(`ww_sync: not a timestamp: ${v}`);
  const [, y, mo, d, h, mi, s, frac, zone] = m as unknown as string[];
  const ms = Number(((frac ?? '') + '000').slice(0, 3));
  let offset = 0;
  if (zone!.toUpperCase() !== 'Z') {
    const sign = zone!.startsWith('-') ? -1 : 1;
    const digits = zone!.slice(1).replace(':', '');
    offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0'));
  }
  const utc =
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms) -
    offset * 60_000;
  return new Date(utc).toISOString();
}

/**
 * Local SQLite row (SQL column names) → JSON wire row. Every column PRESENT in the row is sent
 * (a full row read from SQLite sends every column the phone's schema has, which is how schema
 * drift reaches the server); the server-set `updated_at`/`updated_by` are always omitted; a
 * partial row sends only its own keys (rule R7). `id` is sent lowercase.
 */
export function toWire(table: SQLiteTable, raw: Record<string, unknown>): WireRow {
  const out: WireRow = {};
  for (const col of getTableConfig(table).columns) {
    const name = col.name;
    if (SERVER_SET.has(name) || !(name in raw)) continue;
    const v = raw[name];
    if (v === null || v === undefined) {
      out[name] = null;
    } else if (name === 'id') {
      out[name] = normaliseId(v);
    } else if (col.columnType === 'SQLiteBoolean') {
      out[name] = typeof v === 'number' ? v !== 0 : Boolean(v);
    } else if (col.columnType === 'SQLiteTextJson') {
      out[name] = typeof v === 'string' ? JSON.parse(v) : v;
    } else {
      out[name] = v;
    }
  }
  return out;
}

/** JSON wire row → local SQLite row. Keys the table lacks (e.g. `ww_seq`) are dropped; `id` is
 *  lowercased and `updated_at`/`deleted_at` become ISO milliseconds. */
export function fromWire(table: SQLiteTable, row: WireRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of getTableConfig(table).columns) {
    const name = col.name;
    if (!(name in row)) continue;
    const v = row[name];
    if (v === null || v === undefined) {
      out[name] = null;
    } else if (name === 'id') {
      out[name] = normaliseId(v);
    } else if (col.columnType === 'SQLiteBoolean') {
      out[name] = v === true || v === 1 ? 1 : 0;
    } else if (col.columnType === 'SQLiteTextJson') {
      out[name] = JSON.stringify(v);
    } else if (name === 'updated_at' || name === 'deleted_at') {
      out[name] = isoMillis(String(v));
    } else {
      out[name] = v;
    }
  }
  return out;
}

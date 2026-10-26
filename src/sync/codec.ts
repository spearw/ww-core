import { getTableConfig } from 'drizzle-orm/sqlite-core';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { WireRow } from './types';

const SERVER_SET = new Set(['updated_at', 'updated_by']);

/**
 * Local SQLite row (SQL column names) → JSON wire row. Every column PRESENT in the row is sent
 * (a full row read from SQLite sends every column the phone's schema has, which is how schema
 * drift reaches the server); the server-set `updated_at`/`updated_by` are always omitted; a
 * partial row sends only its own keys (rule R7).
 */
export function toWire(table: SQLiteTable, raw: Record<string, unknown>): WireRow {
  const out: WireRow = {};
  for (const col of getTableConfig(table).columns) {
    const name = col.name;
    if (SERVER_SET.has(name) || !(name in raw)) continue;
    const v = raw[name];
    if (v === null || v === undefined) {
      out[name] = null;
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

/** JSON wire row → local SQLite row. Keys the table lacks (e.g. `ww_seq`) are dropped. */
export function fromWire(table: SQLiteTable, row: WireRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of getTableConfig(table).columns) {
    const name = col.name;
    if (!(name in row)) continue;
    const v = row[name];
    if (v === null || v === undefined) {
      out[name] = null;
    } else if (col.columnType === 'SQLiteBoolean') {
      out[name] = v === true || v === 1 ? 1 : 0;
    } else if (col.columnType === 'SQLiteTextJson') {
      out[name] = JSON.stringify(v);
    } else if (name === 'updated_at' || name === 'deleted_at') {
      out[name] = new Date(v as string).toISOString();
    } else {
      out[name] = v;
    }
  }
  return out;
}

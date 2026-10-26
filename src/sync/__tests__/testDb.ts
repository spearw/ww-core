import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';

import type { SyncDb } from '../types';

/** In-memory better-sqlite3 database with the DDL drizzle-kit makes for `schema`. Async: drizzle-kit is. */
export async function freshDb(schema: Record<string, unknown>): Promise<SyncDb> {
  const empty = await generateSQLiteDrizzleJson({});
  const next = await generateSQLiteDrizzleJson(schema, empty.id);
  const statements = await generateSQLiteMigration(empty, next);
  const sqlite = new Database(':memory:');
  for (const s of statements) sqlite.exec(s);
  return drizzle(sqlite);
}

type Row = Record<string, unknown>;

export function insertItem(
  db: SyncDb,
  o: { id: string; title?: string; listId?: string; position?: number },
): void {
  db.run(
    sql`insert into ww_test_item (id, title, position, list_id, updated_at)
        values (${o.id}, ${o.title ?? 't'}, ${o.position ?? 0}, ${o.listId ?? 'L1'}, '2026-01-01T00:00:00.000Z')`,
  );
}

export function updateTitle(db: SyncDb, id: string, title: string): void {
  db.run(sql`update ww_test_item set title = ${title} where id = ${id}`);
}

export function softDelete(db: SyncDb, id: string): void {
  db.run(sql`update ww_test_item set deleted_at = '2026-01-02T00:00:00.000Z' where id = ${id}`);
}

export function outbox(db: SyncDb): { table_name: string; row_id: string; seq: number }[] {
  return db.all(sql`select table_name, row_id, seq from ww_outbox order by seq`) as {
    table_name: string;
    row_id: string;
    seq: number;
  }[];
}

export function setApplying(db: SyncDb, v: 0 | 1): void {
  db.run(sql`update ww_sync_flag set applying = ${v} where id = 1`);
}

export function countItems(db: SyncDb): number {
  const r = db.get(sql`select count(*) as n from ww_test_item where deleted_at is null`) as Row;
  return Number(r.n);
}

export function cursorOf(db: SyncDb, listId: string): number | undefined {
  const r = db.get(sql`select seq from ww_cursor where list_id = ${listId}`) as Row | undefined;
  return r ? Number(r.seq) : undefined;
}

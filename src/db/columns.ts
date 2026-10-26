import { getTableColumns, getTableName } from 'drizzle-orm';
import type {
  AnySQLiteColumn,
  AnySQLiteTable,
  SQLiteColumnBuilderBase,
  SQLiteTableExtraConfigValue,
  SQLiteTable,
} from 'drizzle-orm/sqlite-core';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Columns every synced table shares. Fresh builders each call: a builder belongs to one table. */
export function syncColumns() {
  return {
    listId: text('list_id').notNull(),
    updatedAt: text('updated_at').notNull(),
    updatedBy: text('updated_by'),
    deletedAt: text('deleted_at'),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Extra = (self: any) => SQLiteTableExtraConfigValue[];

/** A table that syncs: client UUID `id`, the caller's columns, then the shared sync columns. */
export function syncedTable<C extends Record<string, SQLiteColumnBuilderBase>>(
  name: string,
  columns: C,
  extra?: Extra,
) {
  return sqliteTable(name, { id: text('id').primaryKey(), ...columns, ...syncColumns() }, extra);
}

export const SYNCED_TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

const REQUIRED = ['id', 'list_id', 'updated_at', 'updated_by', 'deleted_at'] as const;

/** Throws unless `t` has a safe name, the five sync columns and no timestamp-mode columns. */
export function assertSyncedTable(t: SQLiteTable | AnySQLiteTable): void {
  const name = getTableName(t);
  if (!SYNCED_TABLE_NAME.test(name)) {
    throw new Error(`ww_sync: bad table name ${JSON.stringify(name)}`);
  }
  const cols = Object.values(getTableColumns(t)) as AnySQLiteColumn[];
  const names = new Set(cols.map((c) => c.name));
  for (const req of REQUIRED) {
    if (!names.has(req)) throw new Error(`ww_sync: ${name} needs ${req}`);
  }
  for (const c of cols) {
    if (c.columnType === 'SQLiteTimestamp') {
      throw new Error(`ww_sync: ${name}.${c.name} is a timestamp column; store ISO text`);
    }
  }
}

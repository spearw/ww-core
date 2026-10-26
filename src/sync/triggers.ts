import { getTableName, sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

import { assertSyncedTable } from '../db/columns';
import { WW_LOCAL_TABLE_NAMES } from '../db/tables';
import type { SyncDb } from './types';

const NOT_APPLYING = '(SELECT applying FROM ww_sync_flag WHERE id = 1) = 0';

/** Idempotent: the applying flag row and, per synced table, three outbox triggers. */
export function installSync(db: SyncDb, synced: readonly SQLiteTable[]): void {
  for (const t of synced) {
    const name = getTableName(t);
    if (WW_LOCAL_TABLE_NAMES.has(name)) {
      throw new Error(`ww_sync: ${name} is a package bookkeeping table, not a synced table`);
    }
    assertSyncedTable(t);
  }
  db.run(sql`INSERT OR IGNORE INTO ww_sync_flag (id, applying) VALUES (1, 0)`);
  for (const t of synced) {
    const n = getTableName(t);
    const capture = (suffix: 'ins' | 'upd', event: 'INSERT' | 'UPDATE') =>
      `CREATE TRIGGER IF NOT EXISTS "ww_out_${n}_${suffix}" AFTER ${event} ON "${n}" ` +
      `WHEN ${NOT_APPLYING} BEGIN ` +
      `DELETE FROM ww_outbox WHERE table_name = '${n}' AND row_id = NEW.id; ` +
      `INSERT INTO ww_outbox (table_name, row_id) VALUES ('${n}', NEW.id); END`;
    db.run(sql.raw(capture('ins', 'INSERT')));
    db.run(sql.raw(capture('upd', 'UPDATE')));
    db.run(
      sql.raw(
        `CREATE TRIGGER IF NOT EXISTS "ww_out_${n}_del" BEFORE DELETE ON "${n}" ` +
          `WHEN ${NOT_APPLYING} BEGIN SELECT RAISE(ABORT, 'ww_sync: use deleted_at on ${n}'); END`,
      ),
    );
  }
}

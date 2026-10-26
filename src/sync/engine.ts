import { getTableName, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

import { assertSyncedTable } from '../db/columns';
import { WW_LOCAL_TABLE_NAMES } from '../db/tables';
import { fromWire, toWire } from './codec';
import type { ListSnapshot, PullPage, PulledRow, SyncDb, SyncTransport, WireChange } from './types';

export const PUSH_BATCH = 200;
export const PULL_LIMIT = 500;
export const MAX_PULL_PAGES = 50;
export const MAX_ROUNDS = 5;

export interface SyncReport {
  pushed: number;
  rejected: number;
  pulled: number;
  skipped: number; // pulled live rows not applied because a newer local edit is pending
  tombstoned: number; // pulled deletions applied over a pending local edit (rule below)
  rounds: number;
  listsLost: string[];
  settled: boolean; // false: MAX_ROUNDS ran out with work left; the next run carries on
}

export interface Sync {
  run(): Promise<SyncReport>;
}

/** Tests only; defaults PULL_LIMIT, MAX_PULL_PAGES, MAX_ROUNDS. */
export interface SyncLimits {
  pullLimit?: number;
  maxPullPages?: number;
  maxRounds?: number;
}

type Row = Record<string, unknown>;
interface OutboxEntry {
  seq: number;
  table_name: string;
  row_id: string;
}
interface Sent {
  seq: number;
  rowId: string; // the local id, as the outbox holds it (the wire id is lowercase)
  table: SQLiteTable;
  change: WireChange;
}

/** A double-quoted SQL identifier (names already passed SYNCED_TABLE_NAME or come from Drizzle). */
const ident = (name: string): SQL => sql.raw(`"${name.replace(/"/g, '""')}"`);
const keyOf = (table: string, id: string) => `${table}\u0000${id}`;

/** insert … on conflict(id) do update every column present in `local`. */
function upsert(db: SyncDb, table: SQLiteTable, local: Row): void {
  const cols = Object.keys(local);
  if (!cols.includes('id')) throw new Error(`ww_sync: a ${getTableName(table)} row without id`);
  const names = sql.join(
    cols.map((c) => ident(c)),
    sql`, `,
  );
  const values = sql.join(
    cols.map((c) => sql`${local[c]}`),
    sql`, `,
  );
  const sets = cols.filter((c) => c !== 'id').map((c) => sql`${ident(c)} = excluded.${ident(c)}`);
  const onConflict =
    sets.length > 0 ? sql`DO UPDATE SET ${sql.join(sets, sql`, `)}` : sql`DO NOTHING`;
  db.run(
    sql`INSERT INTO ${ident(getTableName(table))} (${names}) VALUES (${values})
        ON CONFLICT ("id") ${onConflict}`,
  );
}

/** `tables`: synced tables only (wwSyncedTables + the app's); bookkeeping tables are refused. */
export function createSync(opts: {
  db: SyncDb;
  tables: readonly SQLiteTable[];
  transport: SyncTransport;
  /** Tests only; defaults PULL_LIMIT, MAX_PULL_PAGES, MAX_ROUNDS. */
  limits?: SyncLimits;
}): Sync {
  const { db, transport } = opts;
  const byName = new Map<string, SQLiteTable>();
  for (const t of opts.tables) {
    const name = getTableName(t);
    if (WW_LOCAL_TABLE_NAMES.has(name)) {
      throw new Error(`ww_sync: ${name} is a package bookkeeping table, not a synced table`);
    }
    assertSyncedTable(t);
    byName.set(name, t);
  }
  let installed: unknown;
  try {
    installed = db.get(sql`SELECT applying FROM ww_sync_flag WHERE id = 1`);
  } catch {
    installed = undefined;
  }
  if (installed === undefined) throw new Error('ww_sync: installSync has not run');
  const pullLimit = opts.limits?.pullLimit ?? PULL_LIMIT;
  const maxPullPages = opts.limits?.maxPullPages ?? MAX_PULL_PAGES;
  const maxRounds = opts.limits?.maxRounds ?? MAX_ROUNDS;

  /** Runs `fn` in one synchronous transaction with the applying flag set (and reset inside it). */
  function applying<T>(fn: (tx: SyncDb) => T): T {
    return db.transaction((tx) => {
      tx.run(sql`UPDATE ww_sync_flag SET applying = 1 WHERE id = 1`);
      tx.run(sql`PRAGMA defer_foreign_keys = ON`);
      const out = fn(tx);
      tx.run(sql`UPDATE ww_sync_flag SET applying = 0 WHERE id = 1`);
      return out;
    });
  }

  /** Outbox entries whose row exists and whose list is a shared list in ww_list, oldest seq
   *  first. A personal list (`is_personal = 1`) is phone-only: its rows are never pushable and
   *  wait in the outbox (the server does not know the list either, so it would refuse them). */
  function pushable(q: SyncDb, limit: number): OutboxEntry[] {
    if (byName.size === 0) return [];
    const parts = [...byName.keys()].map(
      (n) =>
        sql`SELECT o.seq AS seq, o.table_name AS table_name, o.row_id AS row_id
            FROM ww_outbox o JOIN ${ident(n)} r ON r."id" = o.row_id
            WHERE o.table_name = ${n}
              AND r."list_id" IN (SELECT id FROM ww_list WHERE is_personal = 0)`,
    );
    const rows = q.all(
      sql`${sql.join(parts, sql` UNION ALL `)} ORDER BY seq LIMIT ${limit}`,
    ) as OutboxEntry[];
    return rows.map((r) => ({ seq: Number(r.seq), table_name: r.table_name, row_id: r.row_id }));
  }

  function outboxSeq(q: SyncDb, table: string, id: string): number | undefined {
    const r = q.get(
      sql`SELECT seq FROM ww_outbox WHERE table_name = ${table} AND row_id = ${id}`,
    ) as { seq: number } | undefined;
    return r === undefined ? undefined : Number(r.seq);
  }

  /** The pending entry of a pulled (lowercase) id, also when the local row is uppercase. */
  function pendingEntry(q: SyncDb, table: string, id: string): { rowId: string } | undefined {
    const r = q.get(
      sql`SELECT row_id FROM ww_outbox WHERE table_name = ${table}
          AND row_id IN (${id}, ${id.toUpperCase()}) ORDER BY row_id = ${id} DESC LIMIT 1`,
    ) as { row_id: string } | undefined;
    return r === undefined ? undefined : { rowId: r.row_id };
  }

  /** Inside `applying`: a local row whose id differs from the server's lowercase id takes the
   *  server's id (and its outbox entry with it), so the answer never lands as a second row. */
  function adoptId(tx: SyncDb, table: string, localId: string, id: string): void {
    if (localId === id) return;
    tx.run(sql`UPDATE OR REPLACE ${ident(table)} SET "id" = ${id} WHERE "id" = ${localId}`);
    tx.run(
      sql`UPDATE OR REPLACE ww_outbox SET row_id = ${id}
          WHERE table_name = ${table} AND row_id = ${localId}`,
    );
  }

  async function pushAll(report: SyncReport): Promise<void> {
    for (;;) {
      const batch = db.transaction((tx) => {
        for (const n of byName.keys()) {
          tx.run(
            sql`DELETE FROM ww_outbox WHERE table_name = ${n}
                AND row_id NOT IN (SELECT "id" FROM ${ident(n)})`,
          );
        }
        const sent = new Map<string, Sent>();
        for (const e of pushable(tx, PUSH_BATCH)) {
          const table = byName.get(e.table_name)!;
          const raw = tx.get(
            sql`SELECT * FROM ${ident(e.table_name)} WHERE "id" = ${e.row_id}`,
          ) as Row;
          const row = toWire(table, raw);
          sent.set(keyOf(e.table_name, String(row['id'])), {
            seq: e.seq,
            rowId: e.row_id,
            table,
            change: { table: e.table_name, row },
          });
        }
        return sent;
      });
      if (batch.size === 0) return;
      const result = await transport.push([...batch.values()].map((s) => s.change));
      // Liveness: a batch that removes no outbox entry (answers missing, or every entry
      // rewritten meanwhile) would be re-sent forever; stop, and leave them pending for the round.
      const progressed = applying((tx) => {
        let deleted = 0;
        for (const a of result.accepted) {
          const s = batch.get(keyOf(a.table, a.id));
          if (!s) continue;
          report.pushed += 1;
          // The entry still has the seq that was sent: no local write since, so the server's
          // answer wins (a write refused by deletion-wins comes back as the tombstone at once).
          // Otherwise keep the entry and the local row; it pushes next round.
          if (outboxSeq(tx, a.table, s.rowId) === s.seq) {
            tx.run(sql`DELETE FROM ww_outbox WHERE seq = ${s.seq}`);
            deleted += 1;
            adoptId(tx, a.table, s.rowId, a.id);
            upsert(tx, s.table, fromWire(s.table, a.row));
          }
        }
        const at = new Date().toISOString();
        for (const r of result.rejected) {
          const s = batch.get(keyOf(r.table, r.id));
          if (!s) continue;
          report.rejected += 1;
          if (outboxSeq(tx, r.table, s.rowId) === s.seq) deleted += 1;
          tx.run(sql`DELETE FROM ww_outbox WHERE seq = ${s.seq}`);
          tx.run(
            sql`INSERT INTO ww_reject (table_name, row_id, reason, at)
                VALUES (${r.table}, ${s.rowId}, ${r.reason}, ${at})`,
          );
        }
        return deleted > 0;
      });
      if (!progressed || batch.size < PUSH_BATCH) return;
    }
  }

  /** false: stopped at maxPullPages with `more` left. */
  async function pullAll(report: SyncReport): Promise<boolean> {
    const cursors: Record<string, number> = {};
    for (const r of db.all(sql`SELECT list_id, seq FROM ww_cursor`) as {
      list_id: string;
      seq: number;
    }[]) {
      cursors[r.list_id] = Number(r.seq);
    }
    const pages: PullPage[] = [];
    let complete = false;
    for (let i = 0; i < maxPullPages; i++) {
      const page = await transport.pull({ ...cursors }, pullLimit); // a throw: nothing applied
      pages.push(page);
      for (const c of page.changes) cursors[c.listId] = c.cursor;
      if (!page.changes.some((c) => c.more)) {
        complete = true;
        break;
      }
    }
    const lists = pages[pages.length - 1]?.lists ?? [];
    const listIds = new Set(lists.map((l) => l.id));

    applying((tx) => {
      // A personal list (is_personal = 1) is phone-only: never lost, never replaced by the pull.
      const known = (
        tx.all(sql`SELECT id FROM ww_list WHERE is_personal = 0`) as { id: string }[]
      ).map((r) => r.id);
      const personal = new Set(
        (tx.all(sql`SELECT id FROM ww_list WHERE is_personal = 1`) as { id: string }[]).map(
          (r) => r.id,
        ),
      );
      const shared = lists.filter((l) => !personal.has(l.id));
      const sharedIds = new Set(shared.map((l) => l.id));
      for (const lost of known.filter((id) => !listIds.has(id))) {
        for (const n of byName.keys()) {
          tx.run(sql`DELETE FROM ${ident(n)} WHERE "list_id" = ${lost}`);
        }
        tx.run(sql`DELETE FROM ww_cursor WHERE list_id = ${lost}`);
        report.listsLost.push(lost);
      }

      // Replace the shared lists and their members with `lists`; personal ones stay as they are.
      for (const id of known) {
        if (!listIds.has(id)) tx.run(sql`DELETE FROM ww_list WHERE id = ${id}`);
      }
      tx.run(
        sql`DELETE FROM ww_list_member
            WHERE list_id NOT IN (SELECT id FROM ww_list WHERE is_personal = 1)`,
      );
      for (const l of shared) {
        tx.run(
          sql`INSERT INTO ww_list (id, name, owner_id) VALUES (${l.id}, ${l.name}, ${l.ownerId})
              ON CONFLICT (id) DO UPDATE SET name = excluded.name, owner_id = excluded.owner_id`,
        );
        for (const m of l.members) {
          tx.run(
            sql`INSERT INTO ww_list_member (list_id, user_id, display_name, joined_at)
                VALUES (${l.id}, ${m.userId}, ${m.displayName}, ${m.joinedAt})`,
          );
        }
      }

      for (const page of pages) {
        const rows: PulledRow[] = page.changes
          .filter((c) => sharedIds.has(c.listId))
          .flatMap((c) => c.rows)
          .sort((x, y) => x.seq - y.seq);
        for (const pulled of rows) {
          const table = byName.get(pulled.table);
          if (!table) continue; // a newer server's table
          const rawId = pulled.row['id'];
          if (typeof rawId !== 'string') continue;
          const id = rawId.toLowerCase();
          const entry = pendingEntry(tx, pulled.table, id);
          const pending = entry !== undefined;
          if (entry) adoptId(tx, pulled.table, entry.rowId, id);
          if (pulled.row['deleted_at'] != null) {
            // A deletion is final (R6): a pending local edit of a deleted row can never win, so
            // it is dropped rather than pushed back forever.
            upsert(tx, table, fromWire(table, pulled.row));
            if (pending) {
              tx.run(
                sql`DELETE FROM ww_outbox WHERE table_name = ${pulled.table} AND row_id = ${id}`,
              );
              report.tombstoned += 1;
            }
            report.pulled += 1;
          } else if (pending) {
            report.skipped += 1; // keep the local row; it pushes next round
          } else {
            upsert(tx, table, fromWire(table, pulled.row));
            report.pulled += 1;
          }
        }
      }

      for (const l of shared) {
        const seq = cursors[l.id];
        if (seq === undefined) continue;
        tx.run(
          sql`INSERT INTO ww_cursor (list_id, seq) VALUES (${l.id}, ${seq})
              ON CONFLICT (list_id) DO UPDATE SET seq = excluded.seq`,
        );
      }
    });
    return complete;
  }

  async function runOnce(): Promise<SyncReport> {
    const report: SyncReport = {
      pushed: 0,
      rejected: 0,
      pulled: 0,
      skipped: 0,
      tombstoned: 0,
      rounds: 0,
      listsLost: [],
      settled: false,
    };
    for (let round = 1; round <= maxRounds; round++) {
      report.rounds = round;
      await pushAll(report);
      const skippedBefore = report.skipped;
      const complete = await pullAll(report);
      if (complete && report.skipped === skippedBefore && pushable(db, 1).length === 0) {
        report.settled = true;
        break;
      }
    }
    return report;
  }

  let inFlight: Promise<SyncReport> | null = null;
  return {
    run() {
      if (inFlight) return inFlight;
      const p = runOnce().finally(() => {
        if (inFlight === p) inFlight = null;
      });
      inFlight = p;
      return p;
    },
  };
}

/** The lists (and their members) the phone knows from its last pull. */
export function listsOnPhone(db: SyncDb): ListSnapshot[] {
  const lists = db.all(sql`SELECT id, name, owner_id FROM ww_list ORDER BY id`) as {
    id: string;
    name: string;
    owner_id: string;
  }[];
  const members = db.all(
    sql`SELECT list_id, user_id, display_name, joined_at FROM ww_list_member
        ORDER BY joined_at, user_id`,
  ) as { list_id: string; user_id: string; display_name: string; joined_at: string }[];
  return lists.map((l) => ({
    id: l.id,
    name: l.name,
    ownerId: l.owner_id,
    members: members
      .filter((m) => m.list_id === l.id)
      .map((m) => ({ userId: m.user_id, displayName: m.display_name, joinedAt: m.joined_at })),
  }));
}

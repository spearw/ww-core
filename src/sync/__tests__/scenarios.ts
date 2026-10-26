import { sql } from 'drizzle-orm';

import { moveWrites, pairId, renumber, stableOrder } from '../../household';
import type { Positioned } from '../../household';
import type { Sync, SyncReport } from '../index';
import type { PushResult, SyncDb, SyncTransport, WireRow } from '../types';
import { countItems, cursorOf, insertItem, outbox, softDelete, updateTitle } from './testDb';

/** `onPushSent` and `failAfterPush` fire once and clear themselves; `onEveryPush` and
 *  `failOnPullPage` stay until the test clears them. `failOnPullPage = n` fails the n-th pull
 *  call counted from when the value was set (the count restarts after each failure). */
export interface TransportHooks {
  onPushSent?: () => void;
  onEveryPush?: () => void;
  failAfterPush?: boolean;
  failOnPullPage?: number;
}

/** Each step's report with ids and times normalised (lists → 'household'/'other', users →
 *  'will'/'katie'), plus both phones' final rows without `updated_at`. Task 12 compares them. */
export interface Transcript {
  steps: SyncReport[]; // every run's report, in order
  pushAnswers: PushResult[]; // every push call's answer, both phones, in order,
  // with seq and timestamps removed from rows
  rejects: { will: unknown[]; katie: unknown[] }; // ww_reject rows (table, row_id, reason)
  finalRows: { will: unknown[]; katie: unknown[] }; // every synced row, without updated_at
}

export interface Scenario {
  name: string;
  play(world: World): Promise<Transcript>;
}

export interface Device {
  userId: string;
  db: SyncDb;
  sync: Sync;
  hooks: TransportHooks;
  pushLog: PushResult[]; // filled by hookedTransport with every push answer
}

export interface World {
  will: Device;
  katie: Device;
  listId: string; // the household: Will (owner) and Katie
  otherListId: string; // a second list with Katie only (for S11)
  removeMember(userId: string): Promise<void>;
  serverRow(table: string, id: string): Promise<WireRow | null>;
  dispose(): Promise<void>;
}

/** Wraps a transport with the test hooks; every push answer is appended to `pushLog` (the
 *  answer is logged even when `failAfterPush` then loses it on the way back to the phone). */
export function hookedTransport(
  inner: SyncTransport,
  hooks: TransportHooks,
  pushLog?: PushResult[],
): SyncTransport {
  let failAt: number | undefined;
  let pulls = 0;
  return {
    async push(changes) {
      const res = await inner.push(changes);
      pushLog?.push(structuredClone(res));
      const once = hooks.onPushSent;
      hooks.onPushSent = undefined;
      once?.();
      hooks.onEveryPush?.();
      if (hooks.failAfterPush) {
        hooks.failAfterPush = false;
        throw new Error('test: the push answer was lost');
      }
      return res;
    },
    async pull(cursors, limit) {
      if (hooks.failOnPullPage !== failAt) {
        failAt = hooks.failOnPullPage;
        pulls = 0;
      }
      if (failAt !== undefined) {
        pulls += 1;
        if (pulls === failAt) {
          pulls = 0;
          throw new Error(`test: pull page ${failAt} failed`);
        }
      }
      return inner.pull(cursors, limit);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Fixed row ids (UUIDs, so the same scenarios run against Postgres).

export const sid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const I1 = sid(1);
const I2 = sid(2);
const T = 'ww_test_item';
const SYNCED = ['ww_member_profile', 'ww_test_item', 'ww_test_pair'] as const;

type Who = 'will' | 'katie';
type Row = Record<string, unknown>;

function item(db: SyncDb, id: string): Row | undefined {
  return db.get(sql`select * from ww_test_item where id = ${id}`) as Row | undefined;
}

function positions(db: SyncDb, listId: string): Positioned[] {
  return (
    db.all(
      sql`select id, position from ww_test_item where list_id = ${listId} and deleted_at is null`,
    ) as { id: string; position: number }[]
  ).map((r) => ({ id: r.id, position: Number(r.position) }));
}

function writePositions(db: SyncDb, writes: readonly Positioned[]): void {
  for (const w of writes) {
    db.run(sql`update ww_test_item set position = ${w.position} where id = ${w.id}`);
  }
}

function rejectsOf(db: SyncDb): unknown[] {
  return db.all(sql`select table_name, row_id, reason from ww_reject order by id`);
}

function rowsOf(db: SyncDb): unknown[] {
  const out: unknown[] = [];
  for (const t of SYNCED) {
    for (const r of db.all(sql.raw(`select * from "${t}" order by id`)) as Row[]) {
      out.push({ table: t, ...r });
    }
  }
  return out;
}

/** Replaces the world's ids (lists, users, pair ids made from them) with stable names, drops
 *  `updated_at` and normalises `deleted_at` to ISO, so two servers' transcripts compare. */
function normaliser(world: World): (v: unknown) => unknown {
  const names = new Map<string, string>([
    [world.listId, 'household'],
    [world.otherListId, 'other'],
    [world.will.userId, 'will'],
    [world.katie.userId, 'katie'],
  ]);
  const firsts: [string, string][] = [
    [world.listId, 'household'],
    [world.otherListId, 'other'],
    ['p1', 'p1'],
  ];
  const seconds: [string, string][] = [
    [world.will.userId, 'will'],
    [world.katie.userId, 'katie'],
  ];
  for (const [a, an] of firsts) {
    for (const [b, bn] of seconds) names.set(pairId(a, b), `pair(${an},${bn})`);
  }
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if (key === 'deleted_at') return new Date(v).toISOString();
      return names.get(v) ?? v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v !== null && typeof v === 'object') {
      const out: Row = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === 'updated_at') continue;
        out[k] = walk(x, k);
      }
      return out;
    }
    return v;
  };
  return (v) => walk(v);
}

/** Runs phones in order and keeps what a transcript needs. */
class Recorder {
  private steps: SyncReport[] = [];
  private answers: PushResult[] = [];
  private seen = { will: 0, katie: 0 };
  constructor(private readonly world: World) {}

  private drain(who: Who): void {
    const log = this.world[who].pushLog;
    this.answers.push(...log.slice(this.seen[who]));
    this.seen[who] = log.length;
  }

  async run(who: Who): Promise<SyncReport> {
    try {
      const report = await this.world[who].sync.run();
      this.steps.push(report);
      return report;
    } finally {
      this.drain(who);
    }
  }

  transcript(): Transcript {
    const n = normaliser(this.world);
    const { will, katie } = this.world;
    return {
      steps: this.steps.map((s) => n(s) as SyncReport),
      pushAnswers: this.answers.map(
        (a) =>
          n({
            accepted: a.accepted.map(({ table, id, row }) => ({ table, id, row })),
            rejected: a.rejected,
          }) as PushResult,
      ),
      rejects: {
        will: n(rejectsOf(will.db)) as unknown[],
        katie: n(rejectsOf(katie.db)) as unknown[],
      },
      finalRows: { will: n(rowsOf(will.db)) as unknown[], katie: n(rowsOf(katie.db)) as unknown[] },
    };
  }
}

/** Will makes I1 ('start') and both phones sync, so both know the list and hold the row. */
async function shared(world: World, rec: Recorder, ids: readonly string[] = [I1]): Promise<void> {
  for (const id of ids) insertItem(world.will.db, { id, title: 'start', listId: world.listId });
  await rec.run('will');
  await rec.run('katie');
  for (const id of ids) expect(item(world.katie.db, id)).toMatchObject({ title: 'start' });
}

function scenario(name: string, body: (w: World, rec: Recorder) => Promise<void>): Scenario {
  return {
    name,
    async play(world) {
      const rec = new Recorder(world);
      await body(world, rec);
      return rec.transcript();
    },
  };
}

export const SCENARIOS: readonly Scenario[] = [
  scenario('S1 a row made on one phone reaches the other', async (w, rec) => {
    insertItem(w.will.db, { id: I1, title: 'hello', listId: w.listId });
    await rec.run('will');
    await rec.run('katie');
    expect(item(w.katie.db, I1)).toMatchObject({ title: 'hello', list_id: w.listId });
    expect(item(w.katie.db, I1)!['deleted_at']).toBeNull();
    expect(await w.serverRow(T, I1)).toMatchObject({ title: 'hello', updated_by: w.will.userId });
    expect(outbox(w.will.db)).toEqual([]);
    expect(outbox(w.katie.db)).toEqual([]);
  }),

  scenario('S2 edit vs edit: the later push wins', async (w, rec) => {
    await shared(w, rec);
    updateTitle(w.will.db, I1, 'A');
    updateTitle(w.katie.db, I1, 'B');
    await rec.run('will');
    await rec.run('katie');
    await rec.run('will');
    expect(item(w.will.db, I1)).toMatchObject({ title: 'B' });
    expect(item(w.katie.db, I1)).toMatchObject({ title: 'B' });
    expect(await w.serverRow(T, I1)).toMatchObject({ title: 'B', updated_by: w.katie.userId });
  }),

  scenario('S3 delete then edit: the deletion wins in one run', async (w, rec) => {
    await shared(w, rec);
    softDelete(w.will.db, I1);
    await rec.run('will');
    updateTitle(w.katie.db, I1, 'K');
    const r = await rec.run('katie');
    expect(r.settled).toBe(true);
    const server = await w.serverRow(T, I1);
    expect(server!['deleted_at']).not.toBeNull();
    expect(server).toMatchObject({ title: 'start' });
    expect(item(w.katie.db, I1)!['deleted_at']).not.toBeNull();
    expect(item(w.katie.db, I1)).toMatchObject({ title: 'start' });
    expect(outbox(w.katie.db)).toEqual([]);
    const again = await rec.run('katie');
    expect(again.pushed).toBe(0);
    expect(again.rejected).toBe(0);
  }),

  scenario('S3b delete during an edit: the pending edit is dropped', async (w, rec) => {
    await shared(w, rec);
    softDelete(w.will.db, I1);
    await rec.run('will');
    updateTitle(w.katie.db, I1, 'K1');
    w.katie.hooks.onPushSent = () => updateTitle(w.katie.db, I1, 'K2');
    const r = await rec.run('katie');
    expect(r.tombstoned).toBe(1);
    expect(r.settled).toBe(true);
    expect(item(w.katie.db, I1)!['deleted_at']).not.toBeNull();
    expect(item(w.katie.db, I1)).toMatchObject({ title: 'start' });
    expect(outbox(w.katie.db)).toEqual([]);
    expect((await w.serverRow(T, I1))!['deleted_at']).not.toBeNull();
  }),

  scenario('S4 edit then delete: an edit after the deletion loses', async (w, rec) => {
    await shared(w, rec);
    updateTitle(w.katie.db, I1, 'K1');
    await rec.run('katie');
    softDelete(w.will.db, I1);
    await rec.run('will');
    updateTitle(w.katie.db, I1, 'K2');
    const r = await rec.run('katie');
    expect(r.settled).toBe(true);
    expect((await w.serverRow(T, I1))!['deleted_at']).not.toBeNull();
    expect(item(w.will.db, I1)!['deleted_at']).not.toBeNull();
    expect(item(w.katie.db, I1)!['deleted_at']).not.toBeNull();
    expect(item(w.katie.db, I1)!['title']).not.toBe('K2');
    expect(outbox(w.katie.db)).toEqual([]);
  }),

  scenario('S5 a write during a sync is kept', async (w, rec) => {
    await shared(w, rec);
    updateTitle(w.katie.db, I1, 'K1');
    w.katie.hooks.onPushSent = () => updateTitle(w.katie.db, I1, 'K2');
    const r = await rec.run('katie');
    expect(r.rounds).toBe(2);
    expect(r.settled).toBe(true);
    expect(r.skipped).toBe(1);
    expect(outbox(w.katie.db)).toEqual([]);
    expect(item(w.katie.db, I1)).toMatchObject({ title: 'K2' });
    expect(await w.serverRow(T, I1)).toMatchObject({ title: 'K2' });
    await rec.run('will');
    expect(item(w.will.db, I1)).toMatchObject({ title: 'K2' });
  }),

  scenario('S6 a lost push answer', async (w, rec) => {
    await shared(w, rec);
    insertItem(w.katie.db, { id: I2, title: 'mine', listId: w.listId });
    w.katie.hooks.failAfterPush = true;
    await expect(rec.run('katie')).rejects.toThrow('the push answer was lost');
    expect(await w.serverRow(T, I2)).toMatchObject({ title: 'mine' });
    expect(outbox(w.katie.db).map((e) => e.row_id)).toEqual([I2]);
    const r = await rec.run('katie');
    expect(r.rejected).toBe(0);
    expect(r.pushed).toBe(1);
    expect(outbox(w.katie.db)).toEqual([]);
    expect(await w.serverRow(T, I2)).toMatchObject({
      id: I2,
      title: 'mine',
      list_id: w.listId,
      updated_by: w.katie.userId,
    });
  }),

  scenario('S7 paging: 1,200 rows arrive in three pages', async (w, rec) => {
    w.will.db.transaction((tx) => {
      for (let i = 0; i < 1200; i++) {
        insertItem(tx, { id: sid(1000 + i), title: `r${i}`, listId: w.listId, position: i });
      }
    });
    await rec.run('will');
    expect(outbox(w.will.db)).toEqual([]);
    w.katie.hooks.failOnPullPage = 4; // a fourth page would fail the run
    const r = await rec.run('katie');
    w.katie.hooks.failOnPullPage = undefined;
    expect(r.pulled).toBe(1200);
    expect(r.settled).toBe(true);
    expect(countItems(w.katie.db)).toBe(1200);
    const highest = Math.max(...w.will.pushLog.flatMap((p) => p.accepted.map((a) => a.seq)));
    expect(cursorOf(w.katie.db, w.listId)).toBe(highest);
  }),

  scenario('S8 concurrent reorders converge', async (w, rec) => {
    const [a, b, c, d, e] = [11, 12, 13, 14, 15].map(sid) as [
      string,
      string,
      string,
      string,
      string,
    ];
    [a, b, c, d, e].forEach((id, i) =>
      insertItem(w.will.db, { id, title: id, listId: w.listId, position: i }),
    );
    await rec.run('will');
    await rec.run('katie');
    writePositions(w.will.db, moveWrites(positions(w.will.db, w.listId), d, 1));
    writePositions(w.katie.db, moveWrites(positions(w.katie.db, w.listId), a, 2));
    await rec.run('will');
    await rec.run('katie');
    await rec.run('will');
    const order = (db: SyncDb) => stableOrder(positions(db, w.listId)).map((r) => r.id);
    expect(order(w.will.db)).toEqual(order(w.katie.db));
    expect(order(w.will.db)).toHaveLength(5);
    writePositions(w.will.db, renumber(positions(w.will.db, w.listId)));
    await rec.run('will');
    await rec.run('katie');
    const dense = (db: SyncDb) =>
      stableOrder(positions(db, w.listId)).map((r) => [r.id, r.position]);
    expect(dense(w.will.db)).toEqual(dense(w.katie.db));
    expect(dense(w.will.db).map(([, p]) => p)).toEqual([0, 1, 2, 3, 4]);
  }),

  scenario("S9 someone else's profile is refused", async (w, rec) => {
    await rec.run('katie'); // learns the lists
    const id = pairId(w.listId, w.will.userId);
    w.katie.db.run(
      sql`insert into ww_member_profile (id, list_id, member_id, weights, archetype, updated_at)
          values (${id}, ${w.listId}, ${w.will.userId}, ${'{"reliability":1}'}, 'planner',
                  '2026-01-01T00:00:00.000Z')`,
    );
    const r = await rec.run('katie');
    expect(r.rejected).toBe(1);
    expect(rejectsOf(w.katie.db)).toEqual([
      { table_name: 'ww_member_profile', row_id: id, reason: 'not_allowed' },
    ]);
    expect(outbox(w.katie.db)).toEqual([]);
    expect(await w.serverRow('ww_member_profile', id)).toBeNull();
  }),

  scenario('S10 leaving removes the list from the phone', async (w, rec) => {
    await shared(w, rec, [I1, I2]);
    expect(countItems(w.katie.db)).toBe(2);
    await w.removeMember(w.katie.userId);
    const r = await rec.run('katie');
    expect(r.listsLost).toEqual([w.listId]);
    const k = w.katie.db;
    expect(k.all(sql`select id from ww_test_item where list_id = ${w.listId}`)).toEqual([]);
    expect(k.all(sql`select id from ww_list where id = ${w.listId}`)).toEqual([]);
    expect(k.all(sql`select list_id from ww_list_member where list_id = ${w.listId}`)).toEqual([]);
    expect(cursorOf(k, w.listId)).toBeUndefined();
    expect(k.all(sql`select id from ww_list where id = ${w.otherListId}`)).toHaveLength(1);
    expect(countItems(w.will.db)).toBe(2);
    expect(await w.serverRow(T, I1)).toMatchObject({ title: 'start' });
    expect(await w.serverRow(T, I2)).toMatchObject({ title: 'start' });
  }),

  scenario('S11 a row cannot change list', async (w, rec) => {
    await rec.run('katie'); // learns both lists
    insertItem(w.katie.db, { id: I1, title: 'k', listId: w.listId });
    await rec.run('katie');
    expect(await w.serverRow(T, I1)).toMatchObject({ list_id: w.listId });
    w.katie.db.run(sql`update ww_test_item set list_id = ${w.otherListId} where id = ${I1}`);
    const r = await rec.run('katie');
    expect(r.rejected).toBe(1);
    expect(rejectsOf(w.katie.db)).toEqual([{ table_name: T, row_id: I1, reason: 'list_moved' }]);
    expect(outbox(w.katie.db)).toEqual([]);
    expect(await w.serverRow(T, I1)).toMatchObject({ list_id: w.listId });
  }),

  scenario('S12 offline edits to different rows merge', async (w, rec) => {
    await shared(w, rec, [I1, I2]);
    updateTitle(w.will.db, I1, 'W');
    updateTitle(w.katie.db, I2, 'K');
    await rec.run('will');
    await rec.run('katie');
    await rec.run('will');
    for (const db of [w.will.db, w.katie.db]) {
      expect(item(db, I1)).toMatchObject({ title: 'W' });
      expect(item(db, I2)).toMatchObject({ title: 'K' });
    }
    expect(await w.serverRow(T, I1)).toMatchObject({ title: 'W' });
    expect(await w.serverRow(T, I2)).toMatchObject({ title: 'K' });
  }),

  scenario('S13 one pair row', async (w, rec) => {
    await rec.run('will');
    await rec.run('katie');
    const id = pairId('p1', w.will.userId);
    const write = (db: SyncDb, value: number) =>
      db.run(
        sql`insert into ww_test_pair (id, a_id, b_id, value, list_id, updated_at)
            values (${id}, 'p1', ${w.will.userId}, ${value}, ${w.listId},
                    '2026-01-01T00:00:00.000Z')`,
      );
    write(w.will.db, 1);
    write(w.katie.db, 2);
    await rec.run('will');
    await rec.run('katie');
    await rec.run('will');
    expect(await w.serverRow('ww_test_pair', id)).toMatchObject({ value: 2 });
    for (const db of [w.will.db, w.katie.db]) {
      const rows = db.all(sql`select id, value from ww_test_pair`) as Row[];
      expect(rows).toEqual([{ id, value: 2 }]);
    }
  }),
];

export function runScenarios(label: string, makeWorld: () => Promise<World>): void {
  describe(label, () => {
    for (const s of SCENARIOS) {
      it(s.name, async () => {
        const world = await makeWorld();
        try {
          await s.play(world);
        } finally {
          await world.dispose();
        }
      });
    }
  });
}

export async function collectTranscripts(
  makeWorld: () => Promise<World>,
): Promise<Record<string, Transcript>> {
  const out: Record<string, Transcript> = {};
  for (const s of SCENARIOS) {
    const world = await makeWorld();
    try {
      out[s.name] = await s.play(world);
    } finally {
      await world.dispose();
    }
  }
  return out;
}

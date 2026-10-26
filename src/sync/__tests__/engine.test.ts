import { sql } from 'drizzle-orm';

import { wwLocalTables, wwMemberProfile, wwOutbox, wwSyncedTables } from '../../db';
import { createFakeServer, serverColumnsOf } from '../fakeServer';
import {
  MAX_PULL_PAGES,
  MAX_ROUNDS,
  PULL_LIMIT,
  PUSH_BATCH,
  createSync,
  installSync,
  listsOnPhone,
} from '../index';
import type { SyncDb } from '../types';
import { makeFakeWorld } from './fakeWorld';
import { collectTranscripts, sid } from './scenarios';
import type { World } from './scenarios';
import { countItems, cursorOf, freshDb, insertItem, outbox, updateTitle } from './testDb';
import { testItem, testPair } from './testSchema';

let world: World | undefined;
afterEach(async () => {
  await world?.dispose();
  world = undefined;
});

function bulk(db: SyncDb, listId: string, n: number): void {
  db.transaction((tx) => {
    for (let i = 0; i < n; i++) insertItem(tx, { id: sid(5000 + i), listId, position: i });
  });
}

it('exports the limits', () => {
  expect([PUSH_BATCH, PULL_LIMIT, MAX_PULL_PAGES, MAX_ROUNDS]).toEqual([200, 500, 50, 5]);
});

it('two runs at once send one push and share a report', async () => {
  world = await makeFakeWorld();
  const { will, listId } = world;
  await will.sync.run();
  insertItem(will.db, { id: sid(1), listId });
  let pushCalls = 0;
  will.hooks.onEveryPush = () => {
    pushCalls += 1;
  };
  const [a, b] = await Promise.all([will.sync.run(), will.sync.run()]);
  expect(pushCalls).toBe(1);
  expect(a).toBe(b);
  // and the next run is a new one
  const c = await will.sync.run();
  expect(c).not.toBe(a);
  expect(pushCalls).toBe(1);
});

it('a pull that fails on page 2 applies nothing and keeps the cursor', async () => {
  world = await makeFakeWorld();
  const { will, katie, listId } = world;
  bulk(will.db, listId, 1200);
  await will.sync.run();
  katie.hooks.failOnPullPage = 2; // 1,200 rows waiting on the server
  await expect(katie.sync.run()).rejects.toThrow('pull page 2 failed');
  expect(countItems(katie.db)).toBe(0);
  expect(cursorOf(katie.db, listId)).toBeUndefined();
  expect(listsOnPhone(katie.db)).toEqual([]);
  katie.hooks.failOnPullPage = undefined;
  await katie.sync.run();
  expect(countItems(katie.db)).toBe(1200);
});

it('a push that fails leaves the outbox untouched', async () => {
  world = await makeFakeWorld();
  const { will, listId } = world;
  await will.sync.run();
  insertItem(will.db, { id: sid(1), listId });
  const before = outbox(will.db);
  will.hooks.failAfterPush = true;
  await expect(will.sync.run()).rejects.toThrow();
  expect(outbox(will.db)).toEqual(before);
  expect(will.db.get(sql`select applying from ww_sync_flag where id = 1`)).toEqual({
    applying: 0,
  });
});

it('reports settled false when MAX_ROUNDS runs out', async () => {
  world = await makeFakeWorld();
  const { will, listId } = world;
  const db = will.db;
  await will.sync.run();
  insertItem(db, { id: 'i1', listId });
  will.hooks.onEveryPush = () => updateTitle(db, 'i1', `t${Math.random()}`); // writes every round
  const r = await will.sync.run();
  expect(r.rounds).toBe(MAX_ROUNDS);
  expect(r.settled).toBe(false);
  expect(outbox(db)).toHaveLength(1);
});

it('a pull cut off by the page cap is not settled, and the next run finishes it', async () => {
  // 20 rows a round, 100 a run
  world = await makeFakeWorld({
    limits: { katie: { pullLimit: 10, maxPullPages: 2, maxRounds: 5 } },
  });
  const { will, katie, listId } = world;
  bulk(will.db, listId, 120);
  await will.sync.run();
  const first = await katie.sync.run();
  expect(first.settled).toBe(false);
  expect(first.rounds).toBe(5);
  expect(countItems(katie.db)).toBe(100);
  const second = await katie.sync.run();
  expect(second.settled).toBe(true);
  expect(countItems(katie.db)).toBe(120);
});

it('a pull that needs three capped rounds still settles in one run', async () => {
  world = await makeFakeWorld({
    limits: { katie: { pullLimit: 10, maxPullPages: 2, maxRounds: 5 } },
  });
  const { will, katie, listId } = world;
  bulk(will.db, listId, 50);
  await will.sync.run();
  const r = await katie.sync.run();
  expect(r.rounds).toBe(3);
  expect(r.settled).toBe(true);
  expect(r.pulled).toBe(50);
  expect(countItems(katie.db)).toBe(50);
});

it("a phone's first run pushes rows made before its first pull, in round 2", async () => {
  world = await makeFakeWorld();
  const { will, listId } = world;
  insertItem(will.db, { id: sid(1), listId });
  const r = await will.sync.run(); // ww_list empty before this run
  expect(r.rounds).toBe(2);
  expect(r.pushed).toBe(1);
  expect(r.settled).toBe(true);
  expect(outbox(will.db)).toEqual([]);
});

it('rows of a list the phone does not know yet wait in the outbox', async () => {
  world = await makeFakeWorld();
  const { will } = world;
  insertItem(will.db, { id: 'x', listId: 'personal' });
  const r = await will.sync.run();
  expect(r.pushed).toBe(0);
  expect(r.settled).toBe(true);
  expect(outbox(will.db).map((e) => e.row_id)).toEqual(['x']);
});

it('an outbox entry whose row is gone is dropped before a push', async () => {
  world = await makeFakeWorld();
  const { will } = world;
  will.db.run(sql`insert into ww_outbox (table_name, row_id) values ('ww_test_item', 'ghost')`);
  await will.sync.run();
  expect(outbox(will.db)).toEqual([]);
});

it('applies the push answer itself, before any pull (server updated_at and updated_by)', async () => {
  world = await makeFakeWorld();
  const { will, listId } = world;
  await will.sync.run();
  insertItem(will.db, { id: sid(1), listId });
  will.hooks.failOnPullPage = 1; // the echo never arrives
  await expect(will.sync.run()).rejects.toThrow('pull page 1 failed');
  will.hooks.failOnPullPage = undefined;
  const row = will.db.get(sql`select updated_by, updated_at from ww_test_item`) as {
    updated_by: string;
    updated_at: string;
  };
  const server = (await world.serverRow('ww_test_item', sid(1)))!;
  expect(row.updated_by).toBe('w');
  expect(row.updated_at).toBe(server['updated_at']);
  expect(outbox(will.db)).toEqual([]);
});

it('listsOnPhone reads the lists and members the last pull brought', async () => {
  world = await makeFakeWorld();
  const { katie, listId, otherListId } = world;
  await katie.sync.run();
  const lists = listsOnPhone(katie.db);
  expect(lists.map((l) => l.id).sort()).toEqual([listId, otherListId].sort());
  const home = lists.find((l) => l.id === listId)!;
  expect(home).toMatchObject({ name: 'Home', ownerId: 'w' });
  expect(home.members.map((m) => [m.userId, m.displayName]).sort()).toEqual([
    ['k', 'Katie'],
    ['w', 'Will'],
  ]);
});

it('ignores pulled rows of tables the phone does not register', async () => {
  const server = createFakeServer({
    tables: {
      ww_test_item: serverColumnsOf(testItem),
      ww_test_pair: serverColumnsOf(testPair),
      ww_member_profile: serverColumnsOf(wwMemberProfile),
    },
  });
  const L = server.createList('w', 'Home', [
    { userId: 'w', displayName: 'Will' },
    { userId: 'k', displayName: 'Katie' },
  ]);
  const willDb = await freshDb({ ...wwLocalTables, ...wwSyncedTables, testItem, testPair });
  installSync(willDb, [testItem, testPair]);
  const will = createSync({
    db: willDb,
    tables: [testItem, testPair],
    transport: server.transportFor('w'),
  });
  // Katie's phone is older: it has no ww_test_pair table at all.
  const katieDb = await freshDb({ ...wwLocalTables, testItem });
  installSync(katieDb, [testItem]);
  const katie = createSync({
    db: katieDb,
    tables: [testItem],
    transport: server.transportFor('k'),
  });

  insertItem(willDb, { id: sid(1), listId: L });
  willDb.run(
    sql`insert into ww_test_pair (id, a_id, b_id, value, list_id, updated_at)
        values (${sid(2)}, 'a', 'b', 1, ${L}, '2026-01-01T00:00:00.000Z')`,
  );
  const w = await will.run();
  expect(w.pushed).toBe(2);
  const k = await katie.run();
  expect(k.pulled).toBe(1);
  expect(k.settled).toBe(true);
  expect(countItems(katieDb)).toBe(1);
  expect(cursorOf(katieDb, L)).toBeGreaterThan(0);
});

it('refuses a bookkeeping table as a synced table', async () => {
  const db = await freshDb({ ...wwLocalTables, testItem });
  expect(() =>
    createSync({
      db,
      tables: [testItem, wwOutbox],
      transport: { push: jest.fn(), pull: jest.fn() },
    }),
  ).toThrow('ww_sync: ww_outbox is a package bookkeeping table');
});

it('two fake worlds give identical, normalised transcripts', async () => {
  const a = await collectTranscripts(() => makeFakeWorld());
  const b = await collectTranscripts(() => makeFakeWorld());
  expect(Object.keys(a)).toHaveLength(14);
  expect(b).toEqual(a);
  const s9 = a["S9 someone else's profile is refused"]!;
  expect(s9.rejects.katie).toEqual([
    { table_name: 'ww_member_profile', row_id: 'pair(household,will)', reason: 'not_allowed' },
  ]);
  expect(JSON.stringify(a)).not.toContain('updated_at');
});

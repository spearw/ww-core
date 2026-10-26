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
import { collectTranscripts, hookedTransport, normaliser, sid } from './scenarios';
import type { TransportHooks } from './scenarios';
import type { World } from './scenarios';
import {
  countItems,
  cursorOf,
  freshDb,
  insertItem,
  outbox,
  softDelete,
  updateTitle,
} from './testDb';
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

it('a push that makes no progress ends the run unsettled instead of looping', async () => {
  const server = createFakeServer({ tables: { ww_test_item: serverColumnsOf(testItem) } });
  const L = server.createList('w', 'Home', [{ userId: 'w', displayName: 'Will' }]);
  const inner = server.transportFor('w');
  let pushCalls = 0;
  const db = await freshDb({ ...wwLocalTables, testItem });
  installSync(db, [testItem]);
  const sync = createSync({
    db,
    tables: [testItem],
    transport: {
      push: async () => {
        pushCalls += 1;
        return { accepted: [], rejected: [] }; // answers nothing for the batch
      },
      pull: (cursors, limit) => inner.pull(cursors, limit),
    },
  });
  bulk(db, L, PUSH_BATCH); // a full batch, so only the guard can stop the push loop
  const r = await sync.run();
  expect(r.settled).toBe(false);
  expect(r.rounds).toBe(MAX_ROUNDS);
  expect(pushCalls).toBe(MAX_ROUNDS - 1); // round 1 learns the list; one push a round after
  expect(outbox(db)).toHaveLength(PUSH_BATCH);
});

it('hookedTransport with two arguments logs every push answer in hooks.pushLog', async () => {
  const server = createFakeServer({ tables: { ww_test_item: serverColumnsOf(testItem) } });
  const L = server.createList('w', 'Home', [{ userId: 'w', displayName: 'Will' }]);
  const hooks: TransportHooks = {};
  const t = hookedTransport(server.transportFor('w'), hooks);
  await t.push([{ table: 'ww_test_item', row: { id: 'a', list_id: L, title: 'A' } }]);
  await t.push([{ table: 'nope', row: { id: 'b', list_id: L } }]);
  expect(hooks.pushLog).toHaveLength(2);
  expect(hooks.pushLog![0]!.accepted.map((a) => a.id)).toEqual(['a']);
  expect(hooks.pushLog![1]!.rejected).toEqual([
    { table: 'nope', id: 'b', reason: 'unknown_table' },
  ]);
});

it('the transcript normaliser rewrites ids only, never free text', () => {
  const n = normaliser({
    listId: 'L',
    otherListId: 'O',
    will: { userId: 'w' },
    katie: { userId: 'k' },
  });
  expect(n({ id: 'k', title: 'k', updated_by: 'k' })).toEqual({
    id: 'katie',
    title: 'k',
    updated_by: 'katie',
  });
  expect(
    n({ listsLost: ['L'], tags: ['k', 'L'], list_id: 'O', row_id: 'w', member_id: 'w' }),
  ).toEqual({
    listsLost: ['household'],
    tags: ['k', 'L'],
    list_id: 'other',
    row_id: 'will',
    member_id: 'will',
  });
  expect(n({ updated_at: 'x', deleted_at: '2026-01-02T00:00:00+00:00' })).toEqual({
    deleted_at: '2026-01-02T00:00:00.000Z',
  });
});

it('a personal list is never lost, never replaced, and its rows never push', async () => {
  world = await makeFakeWorld();
  const { will, listId } = world;
  will.db.run(
    sql`insert into ww_list (id, name, owner_id, is_personal) values ('personal', 'Me', 'w', 1)`,
  );
  insertItem(will.db, { id: sid(1), listId: 'personal' });
  insertItem(will.db, { id: sid(2), listId: 'personal' });
  insertItem(will.db, { id: sid(3), listId });
  const r = await will.sync.run();
  expect(r.listsLost).toEqual([]);
  expect(r.settled).toBe(true);
  const personal = will.db.all(
    sql`select id from ww_test_item where list_id = 'personal' order by id`,
  ) as { id: string }[];
  expect(personal.map((p) => p.id)).toEqual([sid(1), sid(2)]);
  expect(will.db.get(sql`select name, is_personal from ww_list where id = 'personal'`)).toEqual({
    name: 'Me',
    is_personal: 1,
  });
  const sent = will.pushLog.flatMap((p) => [...p.accepted, ...p.rejected]).map((c) => c.id);
  expect(sent).toEqual([sid(3)]);
  expect(outbox(will.db).map((e) => e.row_id)).toEqual([sid(1), sid(2)]);
  expect(await world.serverRow('ww_test_item', sid(3))).not.toBeNull();
  expect(await world.serverRow('ww_test_item', sid(1))).toBeNull();
});

it('an uppercase local id is pushed lowercase and becomes the one lowercase row', async () => {
  world = await makeFakeWorld();
  const { will, katie, listId } = world;
  await will.sync.run();
  const upper = 'AAAAAAAA-0000-4000-8000-0000000000BB';
  insertItem(will.db, { id: upper, listId });
  const r = await will.sync.run();
  expect(r.pushed).toBe(1);
  expect(r.settled).toBe(true);
  expect(will.db.all(sql`select id from ww_test_item`)).toEqual([{ id: upper.toLowerCase() }]);
  expect(outbox(will.db)).toEqual([]);
  expect(await world.serverRow('ww_test_item', upper.toLowerCase())).not.toBeNull();
  await katie.sync.run();
  expect(katie.db.all(sql`select id from ww_test_item`)).toEqual([{ id: upper.toLowerCase() }]);
});

it('createSync refuses a database installSync has not prepared', async () => {
  const db = await freshDb({ ...wwLocalTables, testItem });
  expect(() =>
    createSync({ db, tables: [testItem], transport: { push: jest.fn(), pull: jest.fn() } }),
  ).toThrow('ww_sync: installSync has not run');
});

it('a pulled row whose id a pending uppercase local row holds is adopted, not duplicated', async () => {
  world = await makeFakeWorld();
  const { will, katie, listId } = world;
  const upper = 'AAAAAAAA-0000-4000-8000-0000000000CC';
  insertItem(katie.db, { id: upper.toLowerCase(), listId, title: 'katie' });
  await katie.sync.run();
  insertItem(will.db, { id: upper, listId, title: 'will' }); // waits: Will knows no list yet
  const r = await will.sync.run();
  expect(r.skipped).toBe(1);
  expect(r.settled).toBe(true);
  expect(will.db.all(sql`select id, title from ww_test_item`)).toEqual([
    { id: upper.toLowerCase(), title: 'will' },
  ]);
  expect(outbox(will.db)).toEqual([]);
  expect((await world.serverRow('ww_test_item', upper.toLowerCase()))!['title']).toBe('will');
});

it('a pulled tombstone over a pending uppercase local row leaves one deleted row', async () => {
  world = await makeFakeWorld();
  const { will, katie, listId } = world;
  const upper = 'AAAAAAAA-0000-4000-8000-0000000000DD';
  insertItem(katie.db, { id: upper.toLowerCase(), listId });
  softDelete(katie.db, upper.toLowerCase());
  await katie.sync.run();
  insertItem(will.db, { id: upper, listId, title: 'will' });
  const r = await will.sync.run();
  expect(r.tombstoned).toBe(1);
  expect(will.pushLog.flatMap((p) => p.accepted)).toEqual([]); // dropped, never pushed back
  expect(will.db.all(sql`select id, deleted_at is not null as gone from ww_test_item`)).toEqual([
    { id: upper.toLowerCase(), gone: 1 },
  ]);
  expect(outbox(will.db)).toEqual([]);
});

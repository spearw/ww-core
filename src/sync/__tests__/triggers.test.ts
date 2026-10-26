import { sql } from 'drizzle-orm';

import { wwLocalTables, wwOutbox, wwSyncedTables } from '../../db';
import { installSync } from '../triggers';
import type { SyncDb } from '../types';
import { freshDb, insertItem, outbox, setApplying, updateTitle } from './testDb';
import { testItem } from './testSchema';

let db: SyncDb;
beforeEach(async () => {
  db = await freshDb({ ...wwLocalTables, ...wwSyncedTables, testItem });
  installSync(db, [testItem]);
});

it('an insert and an update leave one outbox entry with a newer seq', () => {
  insertItem(db, { id: 'i1', title: 'A' });
  const first = outbox(db);
  expect(first).toEqual([{ table_name: 'ww_test_item', row_id: 'i1', seq: 1 }]);
  updateTitle(db, 'i1', 'B');
  expect(outbox(db)).toEqual([
    { table_name: 'ww_test_item', row_id: 'i1', seq: first[0]!.seq + 1 },
  ]);
});
it('writes made while applying are not captured', () => {
  setApplying(db, 1);
  insertItem(db, { id: 'i2', title: 'A' });
  setApplying(db, 0);
  expect(outbox(db)).toEqual([]);
});
it('a hard delete is refused outside applying', () => {
  insertItem(db, { id: 'i3', title: 'A' });
  // drizzle wraps driver errors; the trigger's message is on `cause`
  let caught: unknown;
  try {
    db.run(sql`delete from ww_test_item where id = 'i3'`);
  } catch (e) {
    caught = e;
  }
  expect(String((caught as Error).cause)).toContain('ww_sync: use deleted_at');
});
it('installing twice is harmless', () => {
  installSync(db, [testItem]);
  installSync(db, [testItem]);
});
it('refuses a bookkeeping table as a synced table', () => {
  expect(() => installSync(db, [wwOutbox])).toThrow(
    'ww_sync: ww_outbox is a package bookkeeping table',
  );
});

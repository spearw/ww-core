import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { assertSyncedTable, syncedTable } from '../columns';

it('rejects a table missing sync columns', () => {
  expect(() => assertSyncedTable(sqliteTable('bad', { id: text('id') }))).toThrow(
    'ww_sync: bad needs list_id',
  );
});
it('rejects timestamp columns', () => {
  expect(() =>
    assertSyncedTable(syncedTable('t', { at: integer('at', { mode: 'timestamp' }) })),
  ).toThrow('timestamp');
});
it('rejects unsafe names', () => {
  for (const bad of ['Item', '1item', 'item"; drop table ww_outbox; --', "it'em", 'a'.repeat(64)])
    expect(() => assertSyncedTable(syncedTable(bad, {}))).toThrow('ww_sync: bad table name');
  expect(() => assertSyncedTable(syncedTable('a'.repeat(63), {}))).not.toThrow();
});

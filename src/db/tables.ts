import { integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

import type { Weights } from '../engine';
import { syncedTable } from './columns';

/** Phone-only bookkeeping. No triggers; never pushed or pulled as rows. */
export const wwList = sqliteTable('ww_list', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id').notNull(),
  isPersonal: integer('is_personal', { mode: 'boolean' }).notNull().default(false),
});

export const wwListMember = sqliteTable(
  'ww_list_member',
  {
    listId: text('list_id').notNull(),
    userId: text('user_id').notNull(),
    displayName: text('display_name').notNull(),
    joinedAt: text('joined_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.listId, t.userId] })],
);

export const wwOutbox = sqliteTable(
  'ww_outbox',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    tableName: text('table_name').notNull(),
    rowId: text('row_id').notNull(),
  },
  (t) => [unique().on(t.tableName, t.rowId)],
);

export const wwCursor = sqliteTable('ww_cursor', {
  listId: text('list_id').primaryKey(),
  seq: integer('seq').notNull(),
});

export const wwSyncFlag = sqliteTable('ww_sync_flag', {
  id: integer('id').primaryKey(),
  applying: integer('applying').notNull().default(0),
});

export const wwReject = sqliteTable('ww_reject', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tableName: text('table_name').notNull(),
  rowId: text('row_id').notNull(),
  reason: text('reason').notNull(),
  at: text('at').notNull(),
});

/** Synced rows the package owns. Its id is `pairId(listId, memberId)`. */
export const wwMemberProfile = syncedTable('ww_member_profile', {
  memberId: text('member_id').notNull(),
  weights: text('weights', { mode: 'json' }).$type<Weights>().notNull(),
  archetype: text('archetype').notNull(),
});

export const wwLocalTables = { wwList, wwListMember, wwOutbox, wwCursor, wwSyncFlag, wwReject };
export const wwSyncedTables = { wwMemberProfile };

export const WW_LOCAL_TABLE_NAMES: ReadonlySet<string> = new Set([
  'ww_list',
  'ww_list_member',
  'ww_outbox',
  'ww_cursor',
  'ww_sync_flag',
  'ww_reject',
]);

import { integer, real, text } from 'drizzle-orm/sqlite-core';

import { syncedTable } from '../../db/columns';

const itemColumns = () => ({
  title: text('title').notNull(),
  position: integer('position').notNull().default(0),
  done: integer('done', { mode: 'boolean' }).notNull().default(false),
  tags: text('tags', { mode: 'json' }).$type<string[]>(),
});

export const testItem = syncedTable('ww_test_item', itemColumns());

export const testPair = syncedTable('ww_test_pair', {
  aId: text('a_id').notNull(),
  bId: text('b_id').notNull(),
  value: real('value').notNull(),
});

/** A phone whose schema is ahead of the server. */
export const testItemWithColour = syncedTable('ww_test_item', {
  ...itemColumns(),
  colour: text('colour'),
});

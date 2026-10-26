import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

import { wwLocalTables, wwMemberProfile, wwSyncedTables } from '../../db';
import { createFakeServer, serverColumnsOf } from '../fakeServer';
import { createSync, installSync } from '../index';
import type { SyncLimits } from '../index';
import { hookedTransport } from './scenarios';
import type { Device, TransportHooks, World } from './scenarios';
import { freshDb } from './testDb';
import { testItem, testPair } from './testSchema';

const WILL = { userId: 'w', displayName: 'Will' };
const KATIE = { userId: 'k', displayName: 'Katie' };

/** The scenario world on the in-memory fake server. `limits` apply to one phone (tests only). */
export async function makeFakeWorld(
  opts: { limits?: { will?: SyncLimits; katie?: SyncLimits } } = {},
): Promise<World> {
  const server = createFakeServer({
    tables: {
      ww_test_item: serverColumnsOf(testItem),
      ww_test_pair: serverColumnsOf(testPair),
      ww_member_profile: serverColumnsOf(wwMemberProfile),
    },
    ownColumns: { ww_member_profile: 'member_id' },
  });
  const listId = server.createList('w', 'Home', [WILL, KATIE]);
  const otherListId = server.createList('k', 'Mine', [{ userId: 'k', displayName: 'Katie' }]);

  const tables: SQLiteTable[] = [wwMemberProfile, testItem, testPair];
  const closers: (() => void)[] = [];
  async function device(userId: string, limits?: SyncLimits): Promise<Device> {
    const db = await freshDb({ ...wwLocalTables, ...wwSyncedTables, testItem, testPair });
    installSync(db, tables);
    const hooks: TransportHooks = { pushLog: [] };
    const transport = hookedTransport(server.transportFor(userId), hooks);
    const sync = createSync({ db, tables, transport, limits });
    closers.push(() => (db as unknown as { $client: { close(): void } }).$client.close());
    return { userId, db, sync, hooks, pushLog: hooks.pushLog! };
  }

  return {
    will: await device(WILL.userId, opts.limits?.will),
    katie: await device(KATIE.userId, opts.limits?.katie),
    listId,
    otherListId,
    async removeMember(userId) {
      server.removeMember(listId, userId);
    },
    async serverRow(table, id) {
      return server.row(table, id);
    },
    async dispose() {
      for (const close of closers) close();
    },
  };
}

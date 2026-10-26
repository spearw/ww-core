import { sql } from 'drizzle-orm';

import { wwMemberProfile } from '../../db';
import {
  disposeLive,
  makeDevice,
  makeSupabaseWorld,
  serverRow,
  sweepStaleUsers,
} from './localSupabase';
import { runScenarios, sid } from './scenarios';
import { testItemWithColour, testPair } from './testSchema';

afterEach(disposeLive);
afterAll(sweepStaleUsers);

runScenarios('local Supabase', makeSupabaseWorld);

describe('local Supabase: schema drift (Review Focus 1)', () => {
  it('a phone whose ww_test_item has an extra colour column is refused unknown_column', async () => {
    const world = await makeSupabaseWorld();
    const phone = await makeDevice(world.users.katie, [
      wwMemberProfile,
      testItemWithColour,
      testPair,
    ]);
    try {
      await phone.sync.run(); // learns the lists
      const id = sid(77);
      phone.db.run(
        sql`insert into ww_test_item (id, title, position, list_id, colour, updated_at)
            values (${id}, 'red one', 0, ${world.listId}, 'red', '2026-01-01T00:00:00.000Z')`,
      );
      const r = await phone.sync.run();
      expect(r.rejected).toBe(1);
      expect(phone.pushLog.at(-1)!.rejected).toEqual([
        { table: 'ww_test_item', id, reason: 'unknown_column' },
      ]);
      expect(phone.db.all(sql`select table_name, row_id, reason from ww_reject`)).toEqual([
        { table_name: 'ww_test_item', row_id: id, reason: 'unknown_column' },
      ]);
      expect(await serverRow('ww_test_item', id)).toBeNull();
    } finally {
      phone.close();
      await world.dispose();
    }
  });
});

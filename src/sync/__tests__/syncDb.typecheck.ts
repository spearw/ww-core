// Compile-time only (not a *.test.ts, so Jest never runs it): `npm run typecheck` fails if the
// better-sqlite3 driver type stops fitting SyncDb.
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { SyncDb } from '../types';

export const accepts = (d: BetterSQLite3Database<Record<string, unknown>>): SyncDb => d;

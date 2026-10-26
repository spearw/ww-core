import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

/** Any synchronous Drizzle SQLite driver (expo-sqlite on the phone, better-sqlite3 in tests). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SyncDb = BaseSQLiteDatabase<'sync', any, any>;

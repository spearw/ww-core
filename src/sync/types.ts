import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

/** Any synchronous Drizzle SQLite driver (expo-sqlite on the phone, better-sqlite3 in tests). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SyncDb = BaseSQLiteDatabase<'sync', any, any>;

/** snake_case column → JSON value. */
export type WireRow = Record<string, unknown>;
export interface WireChange {
  table: string;
  row: WireRow;
}
export type RejectReason =
  'not_allowed' | 'unknown_table' | 'unknown_column' | 'list_moved' | 'invalid';
export interface PushResult {
  /** `row` is the server's row after the write (`ww_seq` left out) — the server's answer. */
  accepted: { table: string; id: string; seq: number; row: WireRow }[];
  rejected: { table: string; id: string; reason: RejectReason }[];
}
export interface ListSnapshot {
  id: string;
  name: string;
  ownerId: string;
  members: { userId: string; displayName: string; joinedAt: string }[];
}
export interface PulledRow {
  table: string;
  seq: number;
  row: WireRow;
}
export interface PullPage {
  /** Every list the caller is in, now. */
  lists: ListSnapshot[];
  changes: { listId: string; rows: PulledRow[]; cursor: number; more: boolean }[];
}
export interface SyncTransport {
  push(changes: readonly WireChange[]): Promise<PushResult>;
  pull(cursors: Readonly<Record<string, number>>, limit: number): Promise<PullPage>;
}
export interface RpcLike {
  rpc(
    fn: string,
    args: object,
  ): PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
}

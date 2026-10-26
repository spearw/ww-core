import { getTableConfig } from 'drizzle-orm/sqlite-core';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

import type {
  ListSnapshot,
  PullPage,
  PulledRow,
  PushResult,
  RejectReason,
  SyncTransport,
  WireChange,
  WireRow,
} from './types';

export interface FakeServerOptions {
  tables: Readonly<Record<string, readonly string[]>>; // table → its server columns
  ownColumns?: Readonly<Record<string, string>>; // e.g. { ww_member_profile: 'member_id' }
  now?: () => Date;
}

export interface FakeServer {
  transportFor(userId: string): SyncTransport;
  createList(
    ownerId: string,
    name: string,
    members: readonly { userId: string; displayName: string }[],
  ): string;
  /** Same owner rules as the Postgres function; `actorId` (optional) is who is asking. */
  removeMember(listId: string, userId: string, actorId?: string): void;
  row(table: string, id: string): WireRow | null;
}

/** The table's local SQL column names (a server table has the same ones). */
export function serverColumnsOf(table: SQLiteTable): string[] {
  return getTableConfig(table).columns.map((c) => c.name);
}

const MAX_CHANGES = 500;

interface Stored {
  seq: number;
  row: WireRow;
}
interface Member {
  userId: string;
  displayName: string;
  joinedAt: string;
}
interface ListState {
  id: string;
  name: string;
  ownerId: string;
  members: Member[];
}

const copy = <T>(v: T): T => structuredClone(v);

/** The R9 answer: the stored row (without seq). */
const clean = (s: Stored): WireRow => copy(s.row);

export function createFakeServer(opts: FakeServerOptions): FakeServer {
  const now = opts.now ?? (() => new Date());
  const ownColumns = opts.ownColumns ?? {};
  const columnSets = new Map<string, Set<string>>();
  for (const [t, cols] of Object.entries(opts.tables)) {
    columnSets.set(t, new Set(cols.filter((c) => c !== 'ww_seq')));
  }
  const lists = new Map<string, ListState>();
  const rows = new Map<string, Map<string, Stored>>(); // table → id → stored
  for (const t of columnSets.keys()) rows.set(t, new Map());
  let seq = 0;
  let listCounter = 0;

  const isMember = (listId: string, userId: string) =>
    !!lists.get(listId)?.members.some((m) => m.userId === userId);

  function applyChange(
    userId: string,
    change: WireChange,
  ): { seq: number; row: WireRow } | RejectReason {
    const cols = columnSets.get(change.table);
    const store = rows.get(change.table);
    if (!cols || !store) return 'unknown_table'; // R1
    const incoming = change.row;
    const id = incoming['id'];
    if (typeof id !== 'string' || id === '') return 'invalid';
    if (incoming['list_id'] !== undefined && typeof incoming['list_id'] !== 'string') {
      return 'invalid';
    }
    for (const key of Object.keys(incoming)) {
      if (!cols.has(key)) return 'unknown_column'; // R4
    }
    const stored = store.get(id);
    const own = ownColumns[change.table];
    if (incoming['list_id'] === undefined) {
      // A new row must name its list; a stored row the caller cannot see reads as absent
      // (Postgres cannot tell "hidden" from "absent" without a probe), so both are invalid.
      if (!stored || !isMember(stored.row['list_id'] as string, userId)) return 'invalid';
    }
    const listId = (incoming['list_id'] ?? stored?.row['list_id']) as string;
    if (!isMember(listId, userId)) return 'not_allowed'; // R2
    if (stored) {
      const storedList = stored.row['list_id'] as string;
      if (!isMember(storedList, userId)) return 'not_allowed'; // R2 (stored row's list)
      // R3 on the stored row, before R5: Postgres's update policy filters it out first.
      if (own !== undefined && stored.row[own] !== userId) return 'not_allowed';
      if (listId !== storedList) return 'list_moved'; // R5
    }
    const merged: WireRow = stored ? copy(stored.row) : {};
    if (stored?.row['deleted_at'] != null) {
      // R6: deletion wins; no stored value changes, the write is only re-stamped.
    } else {
      for (const [k, v] of Object.entries(incoming)) merged[k] = copy(v); // R7
    }
    if (own !== undefined && merged[own] !== userId) return 'not_allowed'; // R3 (submitted)
    merged['id'] = id;
    merged['list_id'] = listId;
    const next = ++seq; // R8
    merged['updated_at'] = now().toISOString();
    merged['updated_by'] = userId;
    const entry: Stored = { seq: next, row: merged };
    store.set(id, entry);
    return { seq: next, row: clean(entry) };
  }

  function push(userId: string, changes: readonly WireChange[]): PushResult {
    if (changes.length > MAX_CHANGES) {
      throw new Error(`a push carries at most ${MAX_CHANGES} changes (got ${changes.length})`); // R12
    }
    const result: PushResult = { accepted: [], rejected: [] };
    for (const change of changes) {
      const id = typeof change.row['id'] === 'string' ? change.row['id'] : '';
      const out = applyChange(userId, change);
      if (typeof out === 'string') {
        result.rejected.push({ table: change.table, id, reason: out });
      } else {
        result.accepted.push({ table: change.table, id, seq: out.seq, row: out.row });
      }
    }
    return result;
  }

  function snapshot(l: ListState): ListSnapshot {
    return {
      id: l.id,
      name: l.name,
      ownerId: l.ownerId,
      members: l.members.map((m) => ({ ...m })),
    };
  }

  function pull(
    userId: string,
    cursors: Readonly<Record<string, number>>,
    limit: number,
  ): PullPage {
    // R11: everything below is read synchronously, so it is one snapshot.
    const mine = [...lists.values()].filter((l) => isMember(l.id, userId));
    const page: PullPage = { lists: mine.map(snapshot), changes: [] };
    for (const l of mine) {
      const after = cursors[l.id] ?? 0;
      const found: PulledRow[] = [];
      for (const [table, store] of rows) {
        for (const s of store.values()) {
          if (s.row['list_id'] === l.id && s.seq > after) {
            found.push({ table, seq: s.seq, row: clean(s) });
          }
        }
      }
      found.sort((a, b) => a.seq - b.seq);
      const out = found.slice(0, Math.max(0, limit)); // R10
      page.changes.push({
        listId: l.id,
        rows: out,
        cursor: out.length > 0 ? out[out.length - 1]!.seq : after,
        more: found.length > out.length,
      });
    }
    return page;
  }

  function removeMember(listId: string, userId: string, actorId?: string): void {
    const l = lists.get(listId);
    if (!l) throw new Error(`no such list: ${listId}`);
    if (actorId !== undefined && actorId !== userId && actorId !== l.ownerId) {
      throw new Error('only the owner can remove another member'); // R13
    }
    l.members = l.members.filter((m) => m.userId !== userId);
    if (l.members.length === 0) {
      lists.delete(listId);
      for (const store of rows.values()) {
        for (const [id, s] of store) if (s.row['list_id'] === listId) store.delete(id);
      }
      return;
    }
    if (l.ownerId === userId) {
      const earliest = [...l.members].sort(
        (a, b) =>
          (a.joinedAt < b.joinedAt ? -1 : a.joinedAt > b.joinedAt ? 1 : 0) ||
          (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
      )[0]!;
      l.ownerId = earliest.userId;
    }
  }

  return {
    transportFor(userId) {
      return {
        push: (changes) => Promise.resolve().then(() => push(userId, changes)),
        pull: (cursors, limit) => Promise.resolve().then(() => pull(userId, cursors, limit)),
      };
    },
    createList(ownerId, name, members) {
      if (!members.some((m) => m.userId === ownerId)) {
        throw new Error('the owner must be one of the members');
      }
      const id = `list-${++listCounter}`;
      const joinedAt = now().toISOString();
      lists.set(id, {
        id,
        name,
        ownerId,
        members: members.map((m) => ({ userId: m.userId, displayName: m.displayName, joinedAt })),
      });
      return id;
    },
    removeMember,
    row(table, id) {
      const s = rows.get(table)?.get(id);
      return s ? clean(s) : null;
    },
  };
}

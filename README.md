# @ww/core

The shared core of the Worry Wednesday sixth-edition apps. TypeScript, strict, no React, React
Native or Expo imports. Screens stay in the apps; this package is the logic and the data layer.

## What is in it

- **engine**: the project-priority engine and its conformance suite.
- **quiz**: the quiz maths (weights from answers). Quiz content and screens belong to the apps.
- **accounts**: sign-in gate, session and account helpers behind an auth port.
- **household**: household rules and the `HouseholdApi` over the server's RPCs (create, invite,
  accept, leave, remove, rename, display name). Invite links last 7 days.
- **db**: Drizzle (SQLite) helpers every synced table shares, and the package's own `ww_` tables.
- **sync**: push local changes, then pull server changes since a per-device cursor;
  last-write-wins per row by server-set `updated_at`; deletion markers.
- **supabase/migrations**: the two `ww_` Postgres migrations (household, RLS, sync RPCs).

Every database object the package owns is prefixed `ww_`.

## Import paths (`exports`)

| Path                        | What                                                          |
| --------------------------- | ------------------------------------------------------------- |
| `@ww/core/engine`           | engine                                                        |
| `@ww/core/quiz`             | quiz maths                                                    |
| `@ww/core/accounts`         | accounts and auth helpers                                     |
| `@ww/core/accounts/testing` | test doubles for accounts                                     |
| `@ww/core/household`        | household rules and `createHouseholdApi`                      |
| `@ww/core/db`               | `syncedTable`, `syncColumns`, `wwSyncedTables`, `ww_` tables  |
| `@ww/core/sync`             | `createSync`, `installSync`, `createSupabaseTransport`, codec |
| `@ww/core/sync/fake`        | in-memory fake server for Jest                                |

`drizzle-orm` is a peer dependency, so table objects are the app's own Drizzle.

## Pinning it in an app

The package is consumed as a git dependency pinned to a commit:

```sh
npm install git+https://github.com/spearw/ww-core.git#<sha>
```

The repo is private, so CI and EAS need a read-only token for `spearw/ww-core` in the git URL's
credentials (the apps keep it as the secret `WW_CORE_TOKEN`).

## Copying the server migrations

Migrations are immutable. Copy the package's into the app's Supabase project:

```sh
npx tsx node_modules/@ww/core/scripts/copy-migrations.ts supabase/migrations
```

The copier runs under `tsx`, so the app needs `tsx` as a devDependency.
It copies the `*.sql` files the destination lacks (never `seed.sql`) and fails with
`ww-core: <file> differs from the package copy` if a same-named file has been edited. Run it
again after upgrading the pin.

## Registering a synced table

Local (phone, SQLite): declare it with `syncedTable`, which adds the client UUID `id` and the
shared `list_id`, `updated_at`, `updated_by`, `deleted_at` columns, then install the outbox
triggers. Timestamps are ISO text; deletion is setting `deleted_at` (a real `DELETE` on a synced
table is refused by a trigger).

```ts
import { syncedTable, wwSyncedTables } from '@ww/core/db';
import { createSync, createSupabaseTransport, installSync } from '@ww/core/sync';
import { text } from 'drizzle-orm/sqlite-core';

export const project = syncedTable('project', {
  title: text('title').notNull(),
});

const tables = [...Object.values(wwSyncedTables), project];
installSync(db, tables); // idempotent; after the app's own DDL has created the tables

const sync = createSync({ db, tables, transport: createSupabaseTransport(supabase) });
const report = await sync.run(); // push, then pull, until settled
```

Server (Postgres): in one of the app's own migrations, create the table with
`id uuid primary key` and its columns, then make it synced:

```sql
create table public.project (
  id uuid primary key,
  title text not null
);
select ww_make_synced('public.project');
```

`ww_make_synced` adds `list_id` (foreign key to `ww_list`, cascade), `updated_at`,
`updated_by`, `deleted_at`, the server sequence `ww_seq`, the stamping trigger, row-level
security for list members (restrictive too, so a permissive policy the app adds later cannot
widen it), and registers the table for `ww_push` / `ww_pull`. The table name must match on both
sides. A `list_id` foreign key the table already has must be `on delete cascade`.

### Rules for synced tables

- **Call `ww_make_synced` before inserting rows.** Rows that already exist are stamped with a
  `ww_seq` by the call, so they do reach the next pull, but they carry no `updated_by` and the
  migration's `updated_at`.
- **No secondary unique constraints** on a synced table (server or phone). A push that would
  violate one is answered `not_allowed` (it reads as a row hidden by RLS) and is never retried.
- **No local-only foreign keys pointing at synced rows.** A pull deletes a lost list's rows and
  applies rows across tables in seq order; a phone-only foreign key into them can fail the
  whole pull.
- **Pair-id rows are never tombstoned.** A row whose id is `pairId(a, b)` (one per pair: a
  member's impact, a dependency edge, a profile) must be removed with a value column the app
  owns (e.g. `removed_at`), never `deleted_at`: deletion is final (R6), so a tombstoned pair id
  can never be created again.
- Ids are UUIDs and travel lowercase; an uppercase local id is renamed to the server's
  lowercase one when its push is answered.
- A personal list (`ww_list.is_personal = 1`) is phone-only: its rows never push, and a pull
  never removes or replaces it.

## Household

```ts
import { createHouseholdApi } from '@ww/core/household';

const api = createHouseholdApi(supabase); // any client with .rpc()
const listId = await api.create('The Sterlings', 'Will');
const { token } = await api.invite(listId);
```

## Development

```sh
npm run check              # typecheck, lint, format:check, jest
supabase start             # local stack (Docker); needed for the next two
npm run test:db            # pgTAP tests of the migrations
npm run test:integration   # resets the local database, then runs sync and household against it
```

`test:db` and `test:integration` need a running local Supabase (`supabase start`);
`test:integration` runs `supabase db reset --local`, so never point it at a real project.
`supabase/seed.sql` is test-only and is never copied to apps.

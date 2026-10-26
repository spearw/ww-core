import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

import { wwLocalTables, wwMemberProfile, wwSyncedTables } from '../../db';
import { createHouseholdApi } from '../../household/api';
import type { HouseholdApi } from '../../household/api';
import { createSync, installSync } from '../index';
import { createSupabaseTransport } from '../supabaseTransport';
import type { RpcLike, WireRow } from '../types';
import { hookedTransport } from './scenarios';
import type { Device, TransportHooks, World } from './scenarios';
import { freshDb } from './testDb';
import { testItem, testPair } from './testSchema';

/** Every user these tests make has this email domain; `sweepStaleUsers` removes leftovers. */
export const TEST_DOMAIN = '@ww-core.test';
const STALE_MS = 60 * 60 * 1000;

interface LocalEnv {
  url: string;
  anonKey: string;
  serviceKey: string;
}

let env: LocalEnv | undefined;

/** `API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY` from `supabase status -o env` (read once). */
export function localEnv(): LocalEnv {
  if (env) return env;
  const out = execSync('npx supabase status -o env', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const vars = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) vars.set(m[1]!, m[2]!.replace(/^"(.*)"$/, '$1'));
  }
  const need = (k: string) => {
    const v = vars.get(k);
    if (!v) throw new Error(`supabase status -o env has no ${k}: is local Supabase running?`);
    return v;
  };
  env = { url: need('API_URL'), anonKey: need('ANON_KEY'), serviceKey: need('SERVICE_ROLE_KEY') };
  return env;
}

const clientOpts = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const;

let admin: SupabaseClient | undefined;
/** The service-role client: bypasses RLS. Tests use it only to set up, inspect and clean up. */
export function adminClient(): SupabaseClient {
  admin ??= createClient(localEnv().url, localEnv().serviceKey, clientOpts);
  return admin;
}

/** `${Date.now().toString(36)}-${6 random hex}`: one per world, so runs never collide. */
export function runSuffix(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

export interface TestUser {
  userId: string;
  email: string;
  client: SupabaseClient;
  rpc: RpcLike;
  household: HouseholdApi;
}

/** A user made through the admin API and signed into its own client (no session persisted).
 *  The password is generated here and never leaves this function. */
async function makeUser(name: string, suffix: string): Promise<TestUser> {
  const { url, anonKey } = localEnv();
  const email = `${name}-${suffix}${TEST_DOMAIN}`;
  const password = randomBytes(24).toString('base64url');
  const made = await adminClient().auth.admin.createUser({ email, password, email_confirm: true });
  if (made.error || !made.data.user) throw new Error(`createUser ${email}: ${made.error?.message}`);
  const client = createClient(url, anonKey, clientOpts);
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) {
    await adminClient().auth.admin.deleteUser(made.data.user.id);
    throw new Error(`sign in ${email}: ${signed.error.message}`);
  }
  const rpc: RpcLike = { rpc: (fn, args) => client.rpc(fn, args as Record<string, unknown>) };
  return { userId: made.data.user.id, email, client, rpc, household: createHouseholdApi(rpc) };
}

export interface UserSet {
  users: Record<string, TestUser>;
  /** Deletes the users (and with them, R13, every list they alone were in and its rows). */
  dispose(): Promise<void>;
}

const live = new Set<() => Promise<void>>();

/** Fresh users `<name>-<suffix>@ww-core.test`, one suffix for the set. */
export async function makeUsers(names: readonly string[]): Promise<UserSet> {
  const suffix = runSuffix();
  const users: Record<string, TestUser> = {};
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    live.delete(dispose);
    for (const u of Object.values(users)) {
      await u.client.auth.signOut({ scope: 'local' }).catch(() => undefined);
      const { error } = await adminClient().auth.admin.deleteUser(u.userId);
      if (error) throw new Error(`deleteUser ${u.email}: ${error.message}`);
    }
  };
  live.add(dispose);
  try {
    for (const n of names) users[n] = await makeUser(n, suffix);
  } catch (e) {
    await dispose();
    throw e;
  }
  return { users, dispose };
}

/** For `afterEach`: disposes whatever a test made and did not dispose itself. */
export async function disposeLive(): Promise<void> {
  for (const d of [...live]) await d();
}

/** For `afterAll`: deletes every `*@ww-core.test` user made more than an hour ago, so a run
 *  that crashed before disposing cannot leak into later ones. */
export async function sweepStaleUsers(): Promise<void> {
  const cutoff = Date.now() - STALE_MS;
  const stale: string[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await adminClient().auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    for (const u of data.users) {
      if (u.email?.endsWith(TEST_DOMAIN) && Date.parse(u.created_at) < cutoff) stale.push(u.id);
    }
    if (data.users.length < 1000) break;
  }
  for (const id of stale) await adminClient().auth.admin.deleteUser(id);
}

export const PHONE_TABLES: readonly SQLiteTable[] = [wwMemberProfile, testItem, testPair];

/** A phone: a fresh SQLite database syncing through `user`'s own client. `tables` replaces the
 *  synced tables (e.g. an item table with a column the server lacks). */
export async function makeDevice(
  user: TestUser,
  tables: readonly SQLiteTable[] = PHONE_TABLES,
): Promise<Device & { close(): void }> {
  const schema: Record<string, unknown> = { ...wwLocalTables, ...wwSyncedTables };
  tables.forEach((t, i) => (schema[`synced${i}`] = t));
  const db = await freshDb(schema);
  installSync(db, [...tables]);
  const hooks: TransportHooks = { pushLog: [] };
  const transport = hookedTransport(createSupabaseTransport(user.rpc), hooks);
  const sync = createSync({ db, tables, transport });
  return {
    userId: user.userId,
    db,
    sync,
    hooks,
    pushLog: hooks.pushLog!,
    close: () => (db as unknown as { $client: { close(): void } }).$client.close(),
  };
}

/** The service role's view of one stored row, without `ww_seq` (null when absent). */
export async function serverRow(table: string, id: string): Promise<WireRow | null> {
  const { data, error } = await adminClient().from(table).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`serverRow ${table} ${id}: ${error.message}`);
  if (!data) return null;
  const row = { ...(data as WireRow) };
  delete row['ww_seq'];
  return row;
}

export interface SupabaseWorld extends World {
  users: { will: TestUser; katie: TestUser };
}

/** The scenario world on local Supabase: fresh Will and Katie, the household made by Will
 *  through the household API, Katie in by invite, and Katie's own second list. */
export async function makeSupabaseWorld(): Promise<SupabaseWorld> {
  const set = await makeUsers(['will', 'katie']);
  const closers: (() => void)[] = [];
  const dispose = async () => {
    for (const close of closers.splice(0)) close();
    await set.dispose();
  };
  try {
    const will = set.users['will']!;
    const katie = set.users['katie']!;
    const listId = await will.household.create('Home', 'Will');
    const { token } = await will.household.invite(listId);
    const joined = await katie.household.accept(token, 'Katie');
    if (!joined.ok) throw new Error(`Katie could not join: ${joined.error}`);
    const otherListId = await katie.household.create('Mine', 'Katie');
    const willPhone = await makeDevice(will);
    closers.push(willPhone.close);
    const katiePhone = await makeDevice(katie);
    closers.push(katiePhone.close);
    return {
      users: { will, katie },
      will: willPhone,
      katie: katiePhone,
      listId,
      otherListId,
      async removeMember(userId) {
        await will.household.remove(listId, userId);
      },
      serverRow,
      dispose,
    };
  } catch (e) {
    await dispose();
    throw e;
  }
}

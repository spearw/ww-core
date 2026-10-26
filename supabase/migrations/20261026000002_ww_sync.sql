-- ww-core: the synced-table machinery (server rules R1–R12) and the member profiles (R3).
-- One global sequence orders every write; ww_make_synced turns an app table into a synced one;
-- ww_push / ww_pull are the only sync RPCs and run as the caller, so RLS applies to every row.

create sequence public.ww_seq;
-- Supabase's default privileges grant ALL on a new sequence to anon and authenticated; setval
-- would rewind every household's cursor. Only nextval (USAGE) is needed, by the stamp trigger.
revoke all on sequence public.ww_seq from public, anon, authenticated;
grant usage on sequence public.ww_seq to authenticated;

-- The registry: table_name is the bare name the phone uses. Written only by ww_make_synced.
create table public.ww_synced_table (
  name regclass primary key,
  table_name text not null unique
);
alter table public.ww_synced_table enable row level security;
create policy ww_synced_table_select on public.ww_synced_table for select to authenticated
  using (true);
revoke all on table public.ww_synced_table from anon, authenticated;
grant select on table public.ww_synced_table to authenticated;

-- Every write: a list_id never changes (WW001, R5); a tombstone keeps every stored value (R6);
-- then the per-list lock, taken BEFORE nextval and held to commit, so within a list seq order is
-- commit order and a per-list cursor never skips a row (R8, R10).
create function public.ww_sync_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.list_id is distinct from old.list_id then
      raise exception 'list_id never changes' using errcode = 'WW001';
    end if;
    if old.deleted_at is not null then
      new := old;
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.list_id::text, 0));
  new.ww_seq := nextval('public.ww_seq');
  new.updated_at := clock_timestamp();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;

-- For migrations only. The app's DDL creates `id uuid primary key` and its own columns.
create function public.ww_make_synced(p_table regclass) returns void
language plpgsql set search_path = public as $$
declare
  v_rel text := p_table::text;
  v_name text;
  v_has_fk boolean;
begin
  select c.relname into v_name from pg_class c where c.oid = p_table;

  execute format('alter table %s add column if not exists list_id uuid', v_rel);
  execute format('alter table %s alter column list_id set not null', v_rel);
  -- An existing list_id FK to ww_list must cascade (R13: the last member going takes the rows).
  select bool_or(k.confdeltype = 'c') from pg_constraint k
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
    where k.conrelid = p_table and k.contype = 'f' and k.confrelid = 'public.ww_list'::regclass
      and a.attname = 'list_id' and array_length(k.conkey, 1) = 1
    into v_has_fk;
  if v_has_fk is false then
    raise exception 'ww_make_synced: list_id must reference ww_list on delete cascade';
  elsif v_has_fk is null then
    execute format(
      'alter table %s add constraint %I foreign key (list_id) references public.ww_list (id) on delete cascade',
      v_rel, v_name || '_ww_list_fk');
  end if;
  execute format('alter table %s add column if not exists updated_at timestamptz not null default now()', v_rel);
  execute format('alter table %s add column if not exists updated_by uuid', v_rel);
  execute format('alter table %s add column if not exists deleted_at timestamptz', v_rel);
  execute format('alter table %s add column if not exists ww_seq bigint not null default 0', v_rel);
  -- Rows that existed before this call (default 0) would never be pulled; stamp them, as the
  -- migration's role, so they reach every member's next pull.
  execute format('update %s set ww_seq = nextval(''public.ww_seq'') where ww_seq = 0', v_rel);
  execute format('create index if not exists %I on %s (list_id, ww_seq)', v_name || '_ww_seq_idx', v_rel);

  execute format('drop trigger if exists ww_sync_stamp on %s', v_rel);
  execute format(
    'create trigger ww_sync_stamp before insert or update on %s for each row execute function public.ww_sync_stamp()',
    v_rel);

  execute format('alter table %s enable row level security', v_rel);
  execute format('drop policy if exists ww_sync_select on %s', v_rel);
  execute format('drop policy if exists ww_sync_insert on %s', v_rel);
  execute format('drop policy if exists ww_sync_update on %s', v_rel);
  execute format(
    'create policy ww_sync_select on %s for select to authenticated using (public.ww_is_member(list_id))',
    v_rel);
  execute format(
    'create policy ww_sync_insert on %s for insert to authenticated with check (public.ww_is_member(list_id))',
    v_rel);
  -- The new row's list must be the caller's too.
  execute format(
    'create policy ww_sync_update on %s for update to authenticated using (public.ww_is_member(list_id)) with check (public.ww_is_member(list_id))',
    v_rel);
  -- The same membership checks again as restrictive policies, which are AND-ed with every
  -- permissive one: a permissive policy the app adds later can never reach past membership.
  execute format('drop policy if exists ww_sync_member_select on %s', v_rel);
  execute format('drop policy if exists ww_sync_member_insert on %s', v_rel);
  execute format('drop policy if exists ww_sync_member_update on %s', v_rel);
  execute format(
    'create policy ww_sync_member_select on %s as restrictive for select to authenticated using (public.ww_is_member(list_id))',
    v_rel);
  execute format(
    'create policy ww_sync_member_insert on %s as restrictive for insert to authenticated with check (public.ww_is_member(list_id))',
    v_rel);
  execute format(
    'create policy ww_sync_member_update on %s as restrictive for update to authenticated using (public.ww_is_member(list_id)) with check (public.ww_is_member(list_id))',
    v_rel);
  -- No delete policy: rows are tombstoned (deleted_at), never deleted by a member.
  -- `revoke all` also takes TRUNCATE (which ignores RLS), REFERENCES and TRIGGER from both roles.
  execute format('revoke all on table %s from anon, authenticated', v_rel);
  execute format('grant select, insert, update on table %s to authenticated', v_rel);

  insert into ww_synced_table (name, table_name) values (p_table, v_name)
    on conflict (name) do nothing;
end $$;

-- One change per begin … exception block (its own subtransaction): a rejected change writes
-- nothing. Nothing the client sends is ever spliced into SQL text: the relation comes from the
-- registry by exact text equality and is printed from its regclass; columns are catalogue names
-- printed with %I; values reach the statement only as $1 through jsonb_populate_record.
create function public.ww_push(p_changes jsonb) returns jsonb
language plpgsql volatile security invoker set search_path = public as $$
declare
  v_change jsonb;
  v_row jsonb;
  v_table text;
  v_id text;
  v_rel regclass;
  v_cols text[];
  v_keys text[];
  v_sets text;
  v_list text;
  v_res record;
  v_found boolean;
  v_state text;
  v_accepted jsonb := '[]'::jsonb;
  v_rejected jsonb := '[]'::jsonb;
  v_reason text;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception 'a push is an array of changes' using errcode = '22023';
  end if;
  if jsonb_array_length(p_changes) > 500 then -- R12
    raise exception 'a push carries at most 500 changes (got %)', jsonb_array_length(p_changes)
      using errcode = '54000';
  end if;

  -- Every list this push touches, locked in one sorted order before any write (no deadlocks
  -- between two pushes; the stamp trigger's own lock on the same key is then re-entrant).
  perform pg_advisory_xact_lock(hashtextextended(l::text, 0))
    from (
      select distinct (c->'row'->>'list_id')::uuid as l
        from jsonb_array_elements(p_changes) c
        where jsonb_typeof(c->'row'->'list_id') = 'string'
          and c->'row'->>'list_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) s
    order by l;

  for v_change in select value from jsonb_array_elements(p_changes) loop
    v_table := coalesce(v_change->>'table', '');
    v_row := v_change->'row';
    v_id := case when jsonb_typeof(v_row->'id') = 'string' then v_row->>'id' else '' end;
    v_reason := null;
    begin
      -- R1: exact text equality against the registry, never a cast of client text.
      select s.name into v_rel from ww_synced_table s where s.table_name = v_table;
      if not found then
        v_reason := 'unknown_table';
      elsif v_row is null or jsonb_typeof(v_row) <> 'object' or v_id = ''
        or (v_row ? 'list_id' and jsonb_typeof(v_row->'list_id') <> 'string') then
        v_reason := 'invalid';
      else
        -- R4: every key a column of the table, never ww_seq.
        v_cols := array(select a.attname::text from pg_attribute a
          where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped);
        v_keys := array(select jsonb_object_keys(v_row));
        if exists (select 1 from unnest(v_keys) k where k = 'ww_seq' or not (k = any (v_cols))) then
          v_reason := 'unknown_column';
        end if;
      end if;

      if v_reason is null then
        v_list := v_row->>'list_id';
        -- R2 first, as the fake orders it: a change naming a list the caller is not in is
        -- not_allowed (without this, moving a visible row into such a list would read as
        -- list_moved, since the stamp trigger runs before the update policy's WITH CHECK).
        if v_list is not null and not ww_is_member(v_list::uuid) then
          v_reason := 'not_allowed';
        end if;
      end if;

      if v_reason is null then
        -- Update first: the SET list is the submitted keys minus id (R7: an absent key keeps
        -- its stored value); a change carrying only id still writes `id = id` so the stamp
        -- trigger re-stamps the row (R6, R8, R9).
        select coalesce(string_agg(format('%I = ww_p.%I', k, k), ', '), 'id = ww_t.id')
          into v_sets from unnest(v_keys) k where k <> 'id';
        execute format(
          'update %s as ww_t set %s from (select * from jsonb_populate_record(null::%s, $1)) ww_p '
          'where ww_t.id = ww_p.id returning ww_t.ww_seq as seq, to_jsonb(ww_t.*) - ''ww_seq'' as row',
          v_rel::text, v_sets, v_rel::text)
          into v_res using v_row;
        v_found := v_res.seq is not null;

        if not v_found then
          if v_list is null then
            -- A new row must name its list (the fake's rule). This also answers `invalid` for a
            -- row that exists in a list the caller cannot see, where the fake says not_allowed:
            -- RLS's insert check runs before the unique check, so the two cannot be told apart
            -- without revealing whether the id exists.
            v_reason := 'invalid';
          else
            -- Only the submitted columns, so every other one takes its column default (R7).
            -- A unique_violation here means the id exists but RLS hid it from the update above:
            -- a non-member updating someone else's row, which is R2's not_allowed (mapped below).
            execute format(
              'insert into %s as ww_t (%s) select %s from jsonb_populate_record(null::%s, $1) '
              'returning ww_t.ww_seq as seq, to_jsonb(ww_t.*) - ''ww_seq'' as row',
              v_rel::text,
              (select string_agg(format('%I', k), ', ') from unnest(v_keys) k),
              (select string_agg(format('%I', k), ', ') from unnest(v_keys) k),
              v_rel::text)
              into v_res using v_row;
          end if;
        end if;
      end if;

      if v_reason is null then
        v_accepted := v_accepted || jsonb_build_array(jsonb_build_object(
          'table', v_table, 'id', v_id, 'seq', v_res.seq, 'row', v_res.row));
      end if;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate;
      -- Transient: a deadlock, a serialization failure or a lock timeout fails the whole push
      -- (nothing commits; the phone's outbox is untouched and the next sync retries it).
      if v_state in ('40P01', '40001', '55P03') then
        raise;
      end if;
      v_reason := case v_state
        when '42501' then 'not_allowed'
        when 'WW001' then 'list_moved'
        when '23505' then 'not_allowed' -- see the insert above: the row exists, hidden by RLS
        else 'invalid'
      end;
    end;
    if v_reason is not null then
      v_rejected := v_rejected || jsonb_build_array(jsonb_build_object(
        'table', v_table, 'id', v_id, 'reason', v_reason));
    end if;
  end loop;
  return jsonb_build_object('accepted', v_accepted, 'rejected', v_rejected);
end $$;

-- Declared stable: under READ COMMITTED every statement of a stable function reads the calling
-- statement's snapshot, so the lists, the members and every list's rows are one snapshot (R11).
create function public.ww_pull(p_cursors jsonb, p_limit int default 500) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 500), 1), 500);
  v_sql text;
  v_lists jsonb;
  v_changes jsonb := '[]'::jsonb;
  v_list uuid;
  v_cursor bigint;
  v_rows jsonb;
  v_n int;
  v_more boolean;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id,
      'name', l.name,
      'ownerId', l.owner_id,
      'members', (select jsonb_agg(jsonb_build_object(
          'userId', m.user_id, 'displayName', m.display_name, 'joinedAt', m.joined_at)
          order by m.joined_at, m.user_id)
        from ww_list_member m where m.list_id = l.id)
    ) order by l.created_at, l.id), '[]'::jsonb)
    into v_lists
    from ww_list l
    where exists (select 1 from ww_list_member m where m.list_id = l.id and m.user_id = auth.uid());

  -- One arm per registered table: the label as a literal, the relation from its regclass.
  select string_agg(format(
      'select %L::text as tbl, x.ww_seq, to_jsonb(x.*) - ''ww_seq'' as row from %s x '
      'where x.list_id = $1 and x.ww_seq > $2', s.table_name, s.name::text),
      ' union all ' order by s.table_name)
    into v_sql from ww_synced_table s;

  for v_list in select (l->>'id')::uuid from jsonb_array_elements(v_lists) l loop
    v_cursor := coalesce((p_cursors->>v_list::text)::bigint, 0);
    v_rows := '[]'::jsonb;
    v_more := false;
    if v_sql is not null then
      execute format(
        'select coalesce(jsonb_agg(jsonb_build_object(''table'', tbl, ''seq'', ww_seq, ''row'', row) '
        'order by ww_seq), ''[]''::jsonb), count(*) from (select * from (%s) u order by ww_seq limit $3 + 1) p',
        v_sql)
        into v_rows, v_n using v_list, v_cursor, v_limit;
      if v_n > v_limit then
        v_more := true;
        v_rows := v_rows - (jsonb_array_length(v_rows) - 1);
      end if;
    end if;
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'listId', v_list,
      'rows', v_rows,
      'cursor', case when jsonb_array_length(v_rows) > 0
        then (v_rows->(jsonb_array_length(v_rows) - 1)->>'seq')::bigint else v_cursor end,
      'more', v_more));
  end loop;
  return jsonb_build_object('lists', v_lists, 'changes', v_changes);
end $$;

-- Member profiles: each person's quiz weights, synced so a shared list scores with the mean.
create table public.ww_member_profile (
  id uuid primary key,
  member_id uuid not null,
  weights jsonb not null,
  archetype text not null
);
select public.ww_make_synced('public.ww_member_profile');
-- R3, restrictive so they are AND-ed with the membership policies (a permissive one would be
-- OR-ed and restrict nothing).
create policy ww_member_profile_own_insert on public.ww_member_profile as restrictive
  for insert to authenticated with check (member_id = auth.uid());
create policy ww_member_profile_own_update on public.ww_member_profile as restrictive
  for update to authenticated using (member_id = auth.uid()) with check (member_id = auth.uid());

revoke all on function public.ww_make_synced(regclass) from public, anon, authenticated;
revoke all on function public.ww_sync_stamp(), public.ww_push(jsonb), public.ww_pull(jsonb, int)
  from public, anon;
grant execute on function public.ww_push(jsonb), public.ww_pull(jsonb, int) to authenticated;

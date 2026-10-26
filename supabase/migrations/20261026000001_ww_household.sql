-- ww-core: households (lists), members and 7-day invite links. Members read through RLS; every
-- write goes through the security-definer functions below. Rule R13 lives in ww_after_member_delete.

create table public.ww_list (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  owner_id uuid not null, -- no FK: the member-delete trigger hands it on before the user row is gone
  is_personal boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.ww_list_member (
  list_id uuid not null references public.ww_list on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  joined_at timestamptz not null default now(),
  primary key (list_id, user_id)
);
create index ww_list_member_user_idx on public.ww_list_member (user_id);

create table public.ww_list_invite (
  token_hash text primary key,
  list_id uuid not null references public.ww_list on delete cascade,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_by uuid,
  used_at timestamptz
);

alter table public.ww_list enable row level security;
alter table public.ww_list_member enable row level security;
alter table public.ww_list_invite enable row level security; -- no policies: RPC only
revoke all on table public.ww_list, public.ww_list_member, public.ww_list_invite from anon;

create function public.ww_is_member(p_list uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from ww_list_member m where m.list_id = p_list and m.user_id = auth.uid());
$$;

create policy ww_list_select on public.ww_list for select to authenticated
  using (public.ww_is_member(id));
create policy ww_list_member_select on public.ww_list_member for select to authenticated
  using (public.ww_is_member(list_id));

-- Names: trimmed, then 1..max characters, else WW014.
create function public.ww_clean_name(p_name text, p_max int) returns text
language plpgsql immutable set search_path = public as $$
declare v text := btrim(coalesce(p_name, ''));
begin
  if char_length(v) < 1 or char_length(v) > p_max then
    raise exception 'bad name' using errcode = 'WW014';
  end if;
  return v;
end $$;

create function public.ww_require_user() returns uuid
language plpgsql stable set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  return auth.uid();
end $$;

create function public.ww_create_household(p_name text, p_display_name text) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare
  v_user uuid := ww_require_user();
  v_name text := ww_clean_name(p_name, 60);
  v_display text := ww_clean_name(p_display_name, 40);
  v_list uuid;
begin
  insert into ww_list (name, owner_id) values (v_name, v_user) returning id into v_list;
  insert into ww_list_member (list_id, user_id, display_name) values (v_list, v_user, v_display);
  return v_list;
end $$;

create function public.ww_create_invite(p_list uuid) returns table (token text, expires_at timestamptz)
language plpgsql volatile security definer set search_path = public as $$
declare
  v_token text;
  v_expires timestamptz := now() + interval '7 days';
begin
  perform ww_require_user();
  if not ww_is_member(p_list) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  v_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_');
  insert into ww_list_invite (token_hash, list_id, created_by, expires_at)
    values (encode(sha256(convert_to(v_token, 'utf8')), 'hex'), p_list, auth.uid(), v_expires);
  token := v_token;
  expires_at := v_expires;
  return next;
end $$;

create function public.ww_accept_invite(p_token text, p_display_name text) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare
  v_user uuid := ww_require_user();
  v_display text := ww_clean_name(p_display_name, 40);
  v_hash text := encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex');
  v_list uuid;
  v_inv ww_list_invite;
begin
  -- Already in that list: hand the id back without spending the invite.
  select i.list_id into v_list from ww_list_invite i
    where i.token_hash = v_hash
      and exists (select 1 from ww_list_member m where m.list_id = i.list_id and m.user_id = v_user);
  if found then
    return v_list;
  end if;

  -- The claim is one atomic conditional statement; a concurrent second accept blocks on the row
  -- lock, re-checks used_at after the first commits, matches nothing and falls through to WW011.
  update ww_list_invite set used_by = v_user, used_at = now()
    where token_hash = v_hash and used_at is null and expires_at > now()
    returning list_id into v_list;
  if found then
    insert into ww_list_member (list_id, user_id, display_name) values (v_list, v_user, v_display);
    return v_list;
  end if;

  select * into v_inv from ww_list_invite where token_hash = v_hash;
  if not found then
    raise exception 'unknown invite' using errcode = 'WW012';
  elsif v_inv.used_at is not null then
    raise exception 'invite already used' using errcode = 'WW011';
  end if;
  raise exception 'invite expired' using errcode = 'WW010';
end $$;

create function public.ww_leave_list(p_list uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  delete from ww_list_member where list_id = p_list and user_id = ww_require_user();
end $$;

create function public.ww_remove_member(p_list uuid, p_user uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if not exists (select 1 from ww_list where id = p_list and owner_id = ww_require_user()) then
    raise exception 'not the owner' using errcode = 'WW013';
  end if;
  delete from ww_list_member where list_id = p_list and user_id = p_user;
end $$;

create function public.ww_rename_list(p_list uuid, p_name text) returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_name text := ww_clean_name(p_name, 60);
begin
  perform ww_require_user();
  if not ww_is_member(p_list) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  update ww_list set name = v_name where id = p_list;
end $$;

create function public.ww_set_display_name(p_list uuid, p_name text) returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_name text := ww_clean_name(p_name, 40);
begin
  update ww_list_member set display_name = v_name where list_id = p_list and user_id = ww_require_user();
end $$;

-- R13: the last member going takes the list (and every synced row) with it; the owner going
-- hands the list to the earliest-joined member left (ties by user id).
create function public.ww_after_member_delete() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_next uuid;
begin
  select m.user_id into v_next from ww_list_member m
    where m.list_id = old.list_id order by m.joined_at, m.user_id limit 1;
  if v_next is null then
    delete from ww_list where id = old.list_id;
  else
    update ww_list set owner_id = v_next where id = old.list_id and owner_id = old.user_id;
  end if;
  return null;
end $$;

create trigger ww_after_member_delete after delete on public.ww_list_member
  for each row execute function public.ww_after_member_delete();

-- Callable functions: authenticated only. Helpers stay internal.
revoke all on function public.ww_is_member(uuid), public.ww_clean_name(text, int),
  public.ww_require_user(), public.ww_create_household(text, text), public.ww_create_invite(uuid),
  public.ww_accept_invite(text, text), public.ww_leave_list(uuid), public.ww_remove_member(uuid, uuid),
  public.ww_rename_list(uuid, text), public.ww_set_display_name(uuid, text),
  public.ww_after_member_delete() from public, anon;
grant execute on function public.ww_is_member(uuid), public.ww_clean_name(text, int),
  public.ww_require_user(), public.ww_create_household(text, text), public.ww_create_invite(uuid),
  public.ww_accept_invite(text, text), public.ww_leave_list(uuid), public.ww_remove_member(uuid, uuid),
  public.ww_rename_list(uuid, text), public.ww_set_display_name(uuid, text) to authenticated;

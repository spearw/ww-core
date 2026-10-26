-- Test-only fixtures, loaded by `supabase db reset`. Never copied to an app.
create table public.ww_test_item (
  id uuid primary key,
  title text not null,
  position integer not null default 0,
  done boolean not null default false,
  tags jsonb
);
create table public.ww_test_pair (
  id uuid primary key,
  a_id text not null,
  b_id text not null,
  value double precision not null
);
select public.ww_make_synced('public.ww_test_item');
select public.ww_make_synced('public.ww_test_pair');

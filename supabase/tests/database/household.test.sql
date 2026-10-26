begin;
create extension if not exists pgtap with schema extensions;
select plan(54);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'will@example.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'katie@example.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'third@example.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'fourth@example.test');

-- create (R13 setup)
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1"}';
create temp table t (k text primary key, v text);
grant all on t to authenticated;
insert into t values ('list', (select ww_create_household('Sterlings', 'Will')::text));
select is((select count(*)::int from ww_list), 1, 'create makes one list');
select is((select owner_id from ww_list), '00000000-0000-0000-0000-0000000000a1'::uuid, 'the creator owns it');
select is((select count(*)::int from ww_list_member), 1, 'with one member');
select is((select display_name from ww_list_member), 'Will', 'carrying the display name');
select throws_ok($$ select ww_create_household('', 'Will') $$, 'WW014', null, 'an empty list name is WW014');
select throws_ok($$ select ww_create_household('X', repeat('x', 41)) $$, 'WW014', null, 'a 41-character display name is WW014');

-- a non-member sees nothing
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a3"}';
select is((select count(*)::int from ww_list), 0, 'a non-member selects 0 lists');
select is((select count(*)::int from ww_list_member), 0, 'and 0 members');
select is(ww_is_member((select v::uuid from t where k = 'list')), false, 'ww_is_member is false for a stranger');
select throws_ok(format($$ select ww_create_invite(%L) $$, (select v from t where k = 'list')), '42501', null, 'a stranger cannot invite');

-- invite + accept
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1"}';
insert into t select 'tok', token from ww_create_invite((select v::uuid from t where k = 'list'));
reset role;
select is((select expires_at - created_at from public.ww_list_invite), interval '7 days', 'an invite lasts 7 days');
select isnt((select token_hash from public.ww_list_invite), (select v from t where k = 'tok'), 'only the hash is stored');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1"}';

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a2"}';
select is(ww_accept_invite((select v from t where k = 'tok'), 'Katie'), (select v::uuid from t where k = 'list'), 'Katie accepts');
select is((select count(*)::int from ww_list_member), 2, 'two members');
reset role;
select is((select used_by from public.ww_list_invite), '00000000-0000-0000-0000-0000000000a2'::uuid, 'used_by is the accepter');
set local role authenticated;
update public.ww_list_invite set used_by = null;
reset role;
select is((select count(*)::int from public.ww_list_invite where used_by is null), 0, 'a direct update changes 0 rows');
set local role authenticated;

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1"}';
insert into t select 'own', token from ww_create_invite((select v::uuid from t where k = 'list'));
select is(ww_accept_invite((select v from t where k = 'own'), 'Will'), (select v::uuid from t where k = 'list'), 'the owner accepting their own invite gets the list id');
reset role;
select is((select count(*)::int from public.ww_list_member), 2, 'still two members');
select is((select used_at from public.ww_list_invite where token_hash = encode(sha256(convert_to((select v from t where k = 'own'), 'utf8')), 'hex')), null, 'and that invite stays unused');
delete from public.ww_list_invite where used_at is null;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a3"}';
select throws_ok(format($$ select ww_accept_invite(%L, 'Third') $$, (select v from t where k = 'tok')), 'WW011', null, 'a used token is WW011');
select throws_ok($$ select ww_accept_invite('nonsense', 'Third') $$, 'WW012', null, 'an unknown token is WW012');
select throws_ok(format($$ select ww_accept_invite(%L, '') $$, (select v from t where k = 'tok')), 'WW014', null, 'a bad name is WW014');

-- the same user accepting twice in a row gets the list id both times
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1"}';
insert into t select 'twice', token from ww_create_invite((select v::uuid from t where k = 'list'));
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a3"}';
select is(ww_accept_invite((select v from t where k = 'twice'), 'Third'), (select v::uuid from t where k = 'list'), 'a first accept returns the list id');
select is(ww_accept_invite((select v from t where k = 'twice'), 'Third'), (select v::uuid from t where k = 'list'), 'a second accept by the same user returns it again');
reset role;
select is((select count(*)::int from public.ww_list_member where user_id = '00000000-0000-0000-0000-0000000000a3'), 1, 'and the user is a member once');
delete from public.ww_list_member where user_id = '00000000-0000-0000-0000-0000000000a3';
set local role authenticated;

-- expiry
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1"}';
insert into t select 'old', token from ww_create_invite((select v::uuid from t where k = 'list'));
reset role;
update public.ww_list_invite set expires_at = now() - interval '1 second' where used_at is null;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a3"}';
select throws_ok(format($$ select ww_accept_invite(%L, 'Third') $$, (select v from t where k = 'old')), 'WW010', null, 'an expired token is WW010');

-- removing (R13)
select throws_ok(format($$ select ww_remove_member(%L, '00000000-0000-0000-0000-0000000000a1') $$, (select v from t where k = 'list')), 'WW013', null, 'a stranger removing is WW013');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a2"}';
select throws_ok(format($$ select ww_remove_member(%L, '00000000-0000-0000-0000-0000000000a1') $$, (select v from t where k = 'list')), 'WW013', null, 'a member who is not the owner removing is WW013');
select lives_ok(format($$ select ww_set_display_name(%L, 'Kate') $$, (select v from t where k = 'list')), 'a member renames themselves');
select throws_ok(format($$ select ww_rename_list(%L, %L) $$, (select v from t where k = 'list'), repeat('x', 61)), 'WW014', null, 'a 61-character list name is WW014');
select lives_ok(format($$ select ww_rename_list(%L, 'Our place') $$, (select v from t where k = 'list')), 'a non-owner member renames the list');
select is((select name from ww_list), 'Our place', 'and the name changed');
insert into t select 'kt', token from ww_create_invite((select v::uuid from t where k = 'list'));
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1"}';
select ww_remove_member((select v::uuid from t where k = 'list'), '00000000-0000-0000-0000-0000000000a2');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a2"}';
select is((select count(*)::int from ww_list), 0, 'a removed member no longer selects the list');
select throws_ok(format($$ select ww_accept_invite(%L, 'Katie') $$, (select v from t where k = 'kt')), 'WW012', null, 'an invite minted before removal is unknown afterwards');
select is((select count(*)::int from ww_list), 0, 'so the removed member still selects 0 lists');

-- leaving
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1"}';
insert into t select 'tok1', token from ww_create_invite((select v::uuid from t where k = 'list'));
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a4"}';
select ww_accept_invite((select v from t where k = 'tok1'), 'Fourth');
select is((select count(*)::int from ww_list), 1, 'the fourth user joined');
select ww_leave_list((select v::uuid from t where k = 'list'));
select is((select count(*)::int from ww_list), 0, 'a leaver selects 0 lists afterwards');

-- owner leaves: earliest-joined member takes over (R13)
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1"}';
insert into t select 'tok2', token from ww_create_invite((select v::uuid from t where k = 'list'));
insert into t select 'tok3', token from ww_create_invite((select v::uuid from t where k = 'list'));
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a2"}';
select ww_accept_invite((select v from t where k = 'tok2'), 'Katie');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a3"}';
select ww_accept_invite((select v from t where k = 'tok3'), 'Third');
reset role;
update public.ww_list_member set joined_at = '2026-01-01' where user_id = '00000000-0000-0000-0000-0000000000a1';
update public.ww_list_member set joined_at = '2026-02-01' where user_id = '00000000-0000-0000-0000-0000000000a3';
update public.ww_list_member set joined_at = '2026-03-01' where user_id = '00000000-0000-0000-0000-0000000000a2';
delete from auth.users where id = '00000000-0000-0000-0000-0000000000a1';
select is((select owner_id from public.ww_list), '00000000-0000-0000-0000-0000000000a3'::uuid, 'the earliest-joined member (not the lowest id) becomes owner');
update public.ww_list_member set joined_at = '2026-03-01';
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a0', 'zero@example.test');
insert into public.ww_list_member (list_id, user_id, display_name, joined_at)
  select id, '00000000-0000-0000-0000-0000000000a0', 'Zero', '2026-03-01' from public.ww_list;
delete from auth.users where id = '00000000-0000-0000-0000-0000000000a3';
select is((select owner_id from public.ww_list), '00000000-0000-0000-0000-0000000000a0'::uuid, 'a joined_at tie goes to the lower user id');
delete from auth.users where id = '00000000-0000-0000-0000-0000000000a0';
select is((select owner_id from public.ww_list), '00000000-0000-0000-0000-0000000000a2'::uuid, 'and then Katie holds the list');
delete from auth.users where id = '00000000-0000-0000-0000-0000000000a2';
select is((select count(*)::int from public.ww_list), 0, 'deleting the last member deletes the list');

-- privileges: no truncate, references or trigger for the API roles; helpers stay internal
select table_privs_are('public', 'ww_list', 'authenticated', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'], 'ww_list: no truncate, references or trigger for authenticated');
select table_privs_are('public', 'ww_list_member', 'authenticated', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'], 'ww_list_member: no truncate, references or trigger for authenticated');
select table_privs_are('public', 'ww_list_invite', 'authenticated', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'], 'ww_list_invite: no truncate, references or trigger for authenticated');
select table_privs_are('public', 'ww_list', 'anon', ARRAY[]::text[], 'ww_list: nothing for anon');
select table_privs_are('public', 'ww_list_member', 'anon', ARRAY[]::text[], 'ww_list_member: nothing for anon');
select table_privs_are('public', 'ww_list_invite', 'anon', ARRAY[]::text[], 'ww_list_invite: nothing for anon');
select function_privs_are('public', 'ww_clean_name', ARRAY['text', 'integer'], 'authenticated', ARRAY[]::text[], 'ww_clean_name is internal (authenticated)');
select function_privs_are('public', 'ww_clean_name', ARRAY['text', 'integer'], 'anon', ARRAY[]::text[], 'ww_clean_name is internal (anon)');
select function_privs_are('public', 'ww_clean_name', ARRAY['text', 'integer'], 'public', ARRAY[]::text[], 'ww_clean_name is internal (public)');
select function_privs_are('public', 'ww_require_user', ARRAY[]::text[], 'authenticated', ARRAY[]::text[], 'ww_require_user is internal (authenticated)');
select function_privs_are('public', 'ww_require_user', ARRAY[]::text[], 'anon', ARRAY[]::text[], 'ww_require_user is internal (anon)');
select function_privs_are('public', 'ww_require_user', ARRAY[]::text[], 'public', ARRAY[]::text[], 'ww_require_user is internal (public)');
select function_privs_are('public', 'ww_is_member', ARRAY['uuid'], 'authenticated', ARRAY['EXECUTE'], 'ww_is_member stays executable: policies call it as the caller');

select * from finish();
rollback;

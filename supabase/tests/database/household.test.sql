begin;
create extension if not exists pgtap with schema extensions;
select plan(28);

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

-- the owner using their own household's invite: list id back, invite unused, still one member
select is(ww_accept_invite((select v from t where k = 'tok'), 'Will'), (select v::uuid from t where k = 'list'), 'a member accepting gets the list id');
reset role;
select is((select used_at from public.ww_list_invite), null, 'and the invite stays unused');
set local role authenticated;

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

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a3"}';
select throws_ok(format($$ select ww_accept_invite(%L, 'Third') $$, (select v from t where k = 'tok')), 'WW011', null, 'a used token is WW011');
select throws_ok($$ select ww_accept_invite('nonsense', 'Third') $$, 'WW012', null, 'an unknown token is WW012');
select throws_ok(format($$ select ww_accept_invite(%L, '') $$, (select v from t where k = 'tok')), 'WW014', null, 'a bad name is WW014');

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
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1"}';
select ww_remove_member((select v::uuid from t where k = 'list'), '00000000-0000-0000-0000-0000000000a2');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a2"}';
select is((select count(*)::int from ww_list), 0, 'a removed member no longer selects the list');

-- owner leaves: earliest-joined member takes over (R13)
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1"}';
insert into t select 'tok2', token from ww_create_invite((select v::uuid from t where k = 'list'));
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a2"}';
select ww_accept_invite((select v from t where k = 'tok2'), 'Katie');
reset role;
delete from auth.users where id = '00000000-0000-0000-0000-0000000000a1';
select is((select owner_id from public.ww_list), '00000000-0000-0000-0000-0000000000a2'::uuid, 'deleting the owner hands the list to Katie');
delete from auth.users where id = '00000000-0000-0000-0000-0000000000a2';
select is((select count(*)::int from public.ww_list), 0, 'deleting the last member deletes the list');

select * from finish();
rollback;

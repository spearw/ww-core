begin;
create extension if not exists pgtap with schema extensions;
select plan(63);

-- Will (a1) and Katie (a2) share 'h'; Will also has 'w2', Katie 'k2'; the outsider (a3) has 'o1'.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'will@example.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'katie@example.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'outsider@example.test');

create temp table t (k text primary key, v text);
grant all on t to authenticated;
create function pg_temp.v(p_k text) returns text language sql as $$ select v from t where k = p_k $$;
-- One change, pushed as the current caller.
create function pg_temp.push1(p_table text, p_row jsonb) returns jsonb language sql as $$
  select ww_push(jsonb_build_array(jsonb_build_object('table', p_table, 'row', p_row)))
$$;
create function pg_temp.reason(p_res jsonb) returns text language sql as $$
  select p_res->'rejected'->0->>'reason'
$$;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1"}';
insert into t values ('h', ww_create_household('Sterlings', 'Will')::text);
insert into t values ('w2', ww_create_household('Will only', 'Will')::text);
insert into t select 'tok', token from ww_create_invite(pg_temp.v('h')::uuid);
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a2"}';
insert into t values ('join', ww_accept_invite(pg_temp.v('tok'), 'Katie')::text);
insert into t values ('k2', ww_create_household('Katie only', 'Katie')::text);
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a3"}';
insert into t values ('o1', ww_create_household('Outside', 'Out')::text);

-- R2 / R8: a member's push is accepted and stamped
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1"}';
insert into t values ('p1', pg_temp.push1('ww_test_item', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b1', 'list_id', pg_temp.v('h'), 'title', 'A'))::text);
select is(jsonb_array_length(pg_temp.v('p1')::jsonb->'accepted'), 1, 'R2: a member''s push is accepted');
select is(pg_temp.v('p1')::jsonb->'accepted'->0->'row'->>'updated_by', '00000000-0000-0000-0000-0000000000a1', 'R8: updated_by is the caller');
select ok((pg_temp.v('p1')::jsonb->'accepted'->0->>'seq')::bigint > 0, 'R8: ww_seq > 0');
select is(pg_temp.v('p1')::jsonb->'accepted'->0->>'id', '00000000-0000-0000-0000-0000000000b1', 'R9: the answer carries the id');
select ok(not (pg_temp.v('p1')::jsonb->'accepted'->0->'row' ? 'ww_seq'), 'R9: the answered row leaves out ww_seq');
select is(pg_temp.v('p1')::jsonb->'rejected', '[]'::jsonb, 'R9: nothing rejected');

-- R2: the outsider
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a3"}';
select is(pg_temp.reason(pg_temp.push1('ww_test_item', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b2', 'list_id', pg_temp.v('h'), 'title', 'X'))),
  'not_allowed', 'R2: an outsider''s push of a row in the list is not_allowed');
select is(pg_temp.reason(pg_temp.push1('ww_test_item', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b1', 'list_id', pg_temp.v('o1'), 'title', 'hacked'))),
  'not_allowed', 'R2: an outsider updating an existing row through their own list is not_allowed');
select is(pg_temp.reason(pg_temp.push1('ww_test_item', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b1', 'list_id', pg_temp.v('h'), 'title', 'hacked'))),
  'not_allowed', 'R2: an outsider updating an existing row in its own list is not_allowed');
select is((select count(*)::int from ww_test_item), 0, 'R2: the outsider sees no rows');
select is((select jsonb_agg(c->>'listId') from jsonb_array_elements(ww_pull('{}'::jsonb)->'changes') c),
  jsonb_build_array(pg_temp.v('o1')), 'R10: the outsider''s pull omits the list');
reset role;
select is((select title from public.ww_test_item where id = '00000000-0000-0000-0000-0000000000b1'), 'A', 'R2: the row is unchanged');
set local role authenticated;

-- R8: a second push re-stamps and replaces
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a2"}';
insert into t values ('p2', pg_temp.push1('ww_test_item', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b1', 'list_id', pg_temp.v('h'), 'title', 'A2'))::text);
select ok((pg_temp.v('p2')::jsonb->'accepted'->0->>'seq')::bigint > (pg_temp.v('p1')::jsonb->'accepted'->0->>'seq')::bigint, 'R8: a second push has a greater seq');
select is((select title from ww_test_item where id = '00000000-0000-0000-0000-0000000000b1'), 'A2', 'R8: the old value is replaced');
select is((select updated_by from ww_test_item where id = '00000000-0000-0000-0000-0000000000b1'), '00000000-0000-0000-0000-0000000000a2'::uuid, 'R8: updated_by is the new caller');

-- R4: unknown columns (Review Focus 1)
select is(pg_temp.reason(pg_temp.push1('ww_test_item', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b3', 'list_id', pg_temp.v('h'), 'title', 'C', 'colour', 'red'))),
  'unknown_column', 'R4: a key colour is unknown_column');
select is((select count(*)::int from ww_test_item where id = '00000000-0000-0000-0000-0000000000b3'), 0, 'R4: and nothing is written');
select is(pg_temp.reason(pg_temp.push1('ww_test_item', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b1', 'list_id', pg_temp.v('h'), 'ww_seq', 1))),
  'unknown_column', 'R4: a key ww_seq is unknown_column');

-- R1 / R4: hostile names
select is(pg_temp.reason(pg_temp.push1('ww_test_item; drop table ww_list; --', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b1', 'list_id', pg_temp.v('h'), 'title', 'Z'))),
  'unknown_table', 'R1: a table name carrying SQL is unknown_table');
select has_table('public', 'ww_list', 'R1: and ww_list still exists');
select is(pg_temp.reason(pg_temp.push1('"ww_test_item"', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b1', 'list_id', pg_temp.v('h'), 'title', 'Z'))),
  'unknown_table', 'R1: a quoted table name is unknown_table');
select is(pg_temp.reason(pg_temp.push1('ww_list', jsonb_build_object(
  'id', pg_temp.v('h'), 'name', 'Z'))),
  'unknown_table', 'R1: an unregistered table is unknown_table');
select is(pg_temp.reason(pg_temp.push1('ww_test_item', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b1', 'list_id', pg_temp.v('h'), 'title" = null; --', 'Z'))),
  'unknown_column', 'R4: a key carrying SQL is unknown_column');
select is((select title from ww_test_item where id = '00000000-0000-0000-0000-0000000000b1'), 'A2', 'R4: and the row is unchanged');

-- invalid ids
select is(pg_temp.reason(pg_temp.push1('ww_test_item', jsonb_build_object('list_id', pg_temp.v('h'), 'title', 'N'))),
  'invalid', 'a change with no id is invalid');
select is(pg_temp.reason(pg_temp.push1('ww_test_item', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b9', 'title', 'N'))),
  'invalid', 'a new row with no list_id is invalid');

-- R7: insert takes the column defaults
select is(jsonb_array_length(pg_temp.push1('ww_test_item', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b4', 'list_id', pg_temp.v('h'), 'title', 'D'))->'accepted'),
  1, 'R7: a new row with only id, list_id and title is accepted');
select is((select (position, done) from ww_test_item where id = '00000000-0000-0000-0000-0000000000b4'),
  row(0, false), 'R7: position and done take the column defaults');

-- R7: update keeps what the change does not carry
select is(jsonb_array_length(pg_temp.push1('ww_test_item', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b5', 'list_id', pg_temp.v('h'), 'title', 'E',
  'position', 3, 'done', true, 'tags', '["x"]'::jsonb))->'accepted'), 1, 'R7: setup row stored');
select is(jsonb_array_length(pg_temp.push1('ww_test_item', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b5', 'list_id', pg_temp.v('h'), 'title', 'B'))->'accepted'),
  1, 'R7: a push of id, list_id and title is accepted');
select is((select (title, position, done, tags) from ww_test_item where id = '00000000-0000-0000-0000-0000000000b5'),
  row('B'::text, 3, true, '["x"]'::jsonb), 'R7: title changed, position, done and tags kept');

-- R8: a push of {id} alone re-stamps a stored row
reset role;
update public.ww_test_item set updated_at = now() - interval '1 day', updated_by = null
  where id = '00000000-0000-0000-0000-0000000000b5';
insert into t select 'seq5', ww_seq::text from public.ww_test_item where id = '00000000-0000-0000-0000-0000000000b5';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1"}';
insert into t values ('p5', pg_temp.push1('ww_test_item', jsonb_build_object('id', '00000000-0000-0000-0000-0000000000b5'))::text);
select is(jsonb_array_length(pg_temp.v('p5')::jsonb->'accepted'), 1, 'R8: a push of {id} alone for a stored row is accepted');
select ok((select ww_seq > pg_temp.v('seq5')::bigint and updated_at > now() - interval '1 hour'
  and updated_by = '00000000-0000-0000-0000-0000000000a1' from ww_test_item where id = '00000000-0000-0000-0000-0000000000b5'),
  'R8: ww_seq, updated_at and updated_by are re-stamped');
select is((select (title, position, done, tags, list_id::text) from ww_test_item where id = '00000000-0000-0000-0000-0000000000b5'),
  row('B'::text, 3, true, '["x"]'::jsonb, pg_temp.v('h')), 'R7: every application column unchanged');

-- R6 / R9: deletion wins
insert into t values ('d1', pg_temp.push1('ww_test_item', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b4', 'list_id', pg_temp.v('h'), 'deleted_at', '2026-10-26T00:00:00Z'))::text);
insert into t values ('d2', pg_temp.push1('ww_test_item', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b4', 'list_id', pg_temp.v('h'), 'title', 'alive', 'deleted_at', null))::text);
select is((select title from ww_test_item where id = '00000000-0000-0000-0000-0000000000b4'), 'D', 'R6: a write onto a tombstone keeps the title');
select isnt((select deleted_at from ww_test_item where id = '00000000-0000-0000-0000-0000000000b4'), null, 'R6: and keeps deleted_at');
select ok((pg_temp.v('d2')::jsonb->'accepted'->0->>'seq')::bigint > (pg_temp.v('d1')::jsonb->'accepted'->0->>'seq')::bigint, 'R6: and ww_seq is raised');
select isnt(pg_temp.v('d2')::jsonb->'accepted'->0->'row'->>'deleted_at', null, 'R9: the answer is the stored row, deleted_at set');

-- R5: list_id never changes
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a2"}';
select is(pg_temp.reason(pg_temp.push1('ww_test_item', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b1', 'list_id', pg_temp.v('k2'), 'title', 'moved'))),
  'list_moved', 'R5: moving a row to another list of the caller''s is list_moved');
select is(pg_temp.reason(pg_temp.push1('ww_test_item', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000b1', 'list_id', pg_temp.v('w2'), 'title', 'moved'))),
  'not_allowed', 'R2: moving a row to a list the caller is not in is not_allowed');
select is((select list_id::text from ww_test_item where id = '00000000-0000-0000-0000-0000000000b1'), pg_temp.v('h'), 'R5: the row stays in its list');

-- R2: RLS on its own, with the trigger off
reset role;
alter table public.ww_test_item disable trigger ww_sync_stamp;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a2"}';
select throws_ok(format($$ update ww_test_item set list_id = %L where id = '00000000-0000-0000-0000-0000000000b1' $$, pg_temp.v('w2')),
  '42501', null, 'R2: RLS refuses moving a row into a list the caller is not in');
select throws_ok(format($$ insert into ww_test_item (id, list_id, title) values ('00000000-0000-0000-0000-0000000000b8', %L, 'x') $$, pg_temp.v('w2')),
  '42501', null, 'R2: RLS refuses an insert into a list the caller is not in');
reset role;
alter table public.ww_test_item enable trigger ww_sync_stamp;
set local role authenticated;

-- R3: member profiles
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1"}';
select is(jsonb_array_length(pg_temp.push1('ww_member_profile', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000c1', 'list_id', pg_temp.v('h'),
  'member_id', '00000000-0000-0000-0000-0000000000a1', 'weights', '{"r":1}'::jsonb, 'archetype', 'will'))->'accepted'),
  1, 'R3: Will pushes his own profile');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a2"}';
select is(pg_temp.reason(pg_temp.push1('ww_member_profile', jsonb_build_object(
  'id', '00000000-0000-0000-0000-0000000000c2', 'list_id', pg_temp.v('h'),
  'member_id', '00000000-0000-0000-0000-0000000000a1', 'weights', '{}'::jsonb, 'archetype', 'fake'))),
  'not_allowed', 'R3: Katie pushing a profile with Will''s member_id is not_allowed');
select throws_ok(format($$ insert into ww_member_profile (id, list_id, member_id, weights, archetype)
  values ('00000000-0000-0000-0000-0000000000c3', %L, '00000000-0000-0000-0000-0000000000a1', '{}', 'x') $$, pg_temp.v('h')),
  '42501', null, 'R3: the insert policy refuses Will''s member_id from Katie');
select is_empty($$ update ww_member_profile set archetype = 'x' where id = '00000000-0000-0000-0000-0000000000c1' returning id $$,
  'R3: Katie''s update of Will''s profile changes 0 rows');
select lives_ok(format($$ insert into ww_member_profile (id, list_id, member_id, weights, archetype)
  values ('00000000-0000-0000-0000-0000000000c4', %L, '00000000-0000-0000-0000-0000000000a2', '{}', 'katie') $$, pg_temp.v('h')),
  'R3: Katie inserts her own profile');
select lives_ok($$ update ww_member_profile set archetype = 'kate' where id = '00000000-0000-0000-0000-0000000000c4' $$,
  'R3: Katie updates her own profile');
select throws_ok($$ update ww_member_profile set member_id = '00000000-0000-0000-0000-0000000000a1' where id = '00000000-0000-0000-0000-0000000000c4' $$,
  '42501', null, 'R3: Katie cannot hand her profile row to Will');
select is((select archetype from ww_member_profile where id = '00000000-0000-0000-0000-0000000000c1'), 'will', 'R3: Will''s profile is unchanged');

-- R10: paging
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a2"}';
insert into t values ('push3', ww_push(jsonb_build_array(
  jsonb_build_object('table', 'ww_test_item', 'row', jsonb_build_object('id', '00000000-0000-0000-0000-0000000000e1', 'list_id', pg_temp.v('k2'), 'title', '1')),
  jsonb_build_object('table', 'ww_test_pair', 'row', jsonb_build_object('id', '00000000-0000-0000-0000-0000000000e2', 'list_id', pg_temp.v('k2'), 'a_id', 'x', 'b_id', 'y', 'value', 0.5)),
  jsonb_build_object('table', 'ww_test_item', 'row', jsonb_build_object('id', '00000000-0000-0000-0000-0000000000e3', 'list_id', pg_temp.v('k2'), 'title', '3'))
))::text);
insert into t select 'pg1', c::text from jsonb_array_elements(ww_pull('{}'::jsonb, 2)->'changes') c where c->>'listId' = pg_temp.v('k2');
select is((select jsonb_agg(r->>'table') from jsonb_array_elements(pg_temp.v('pg1')::jsonb->'rows') r),
  '["ww_test_item", "ww_test_pair"]'::jsonb, 'R10: p_limit 2 over 3 rows answers 2 rows across tables, in seq order');
select is((pg_temp.v('pg1')::jsonb->>'more')::boolean, true, 'R10: more is true');
select is((pg_temp.v('pg1')::jsonb->>'cursor')::bigint, (pg_temp.v('pg1')::jsonb->'rows'->1->>'seq')::bigint, 'R10: cursor is the 2nd row''s seq');
insert into t select 'pg2', c::text from jsonb_array_elements(
  ww_pull(jsonb_build_object(pg_temp.v('k2'), (pg_temp.v('pg1')::jsonb->>'cursor')::bigint), 2)->'changes') c
  where c->>'listId' = pg_temp.v('k2');
select is(jsonb_array_length(pg_temp.v('pg2')::jsonb->'rows'), 1, 'R10: the next call answers 1 row');
select is((pg_temp.v('pg2')::jsonb->>'more')::boolean, false, 'R10: and more is false');

-- R10 / pull shape: every list the caller is in, even an empty one
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1"}';
insert into t values ('pw', ww_pull('{}'::jsonb)::text);
select is((select c from jsonb_array_elements(pg_temp.v('pw')::jsonb->'changes') c where c->>'listId' = pg_temp.v('w2')),
  jsonb_build_object('listId', pg_temp.v('w2'), 'rows', '[]'::jsonb, 'cursor', 0, 'more', false),
  'R10: an empty list still answers a changes entry with cursor 0');
select is((select jsonb_build_object('name', l->>'name', 'ownerId', l->>'ownerId',
    'names', (select jsonb_agg(m->>'displayName') from jsonb_array_elements(l->'members') m))
  from jsonb_array_elements(pg_temp.v('pw')::jsonb->'lists') l where l->>'id' = pg_temp.v('h')),
  jsonb_build_object('name', 'Sterlings', 'ownerId', '00000000-0000-0000-0000-0000000000a1', 'names', '["Will", "Katie"]'::jsonb),
  'R11: lists carry name, ownerId and members by joinedAt');
select ok((select bool_and(m ? 'userId' and m ? 'joinedAt') from jsonb_array_elements(pg_temp.v('pw')::jsonb->'lists'->0->'members') m),
  'R11: members carry userId and joinedAt');
select is(jsonb_array_length(pg_temp.v('pw')::jsonb->'lists'), 2, 'R11: Will''s pull lists his two lists');

-- R13: the last member going takes the rows
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a2"}';
select lives_ok(format($$ select ww_leave_list(%L) $$, pg_temp.v('k2')), 'R13: Katie leaves her own list');
reset role;
select is((select count(*)::int from public.ww_test_item where list_id = pg_temp.v('k2')::uuid), 0, 'R13: its ww_test_item rows are gone');
set local role authenticated;

-- R12
select throws_ok($$ select ww_push((select jsonb_agg(jsonb_build_object('table', 'ww_test_item', 'row', '{}'::jsonb)) from generate_series(1, 501))) $$,
  null, null, 'R12: 501 changes is an error');

select * from finish();
rollback;

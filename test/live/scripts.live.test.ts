import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE, TEST_DB, multi, run, select } from './helpers';

// Everything that writes lives in BQX_TEST.PUBLIC (created if missing).
const T = `${TEST_DB}.PUBLIC`;

describe('live: scripts, DDL / DML, sessions, time travel', { skip: !LIVE }, () => {
  before(async () => {
    const r = await run(`create database if not exists ${TEST_DB}; create schema if not exists ${T};`);
    assert.notEqual(r.kind, 'error', r.kind === 'error' ? r.message : '');
  });

  it('mixed DDL / DML / SELECT script gives one outcome per statement', async () => {
    const s = await multi(`
      create or replace table ${T}.people (id int, name varchar, tags array);
      insert into ${T}.people select 1, 'Ana', array_construct('a')
        union all select 2, 'Bo', array_construct('b', 'c');
      update ${T}.people set name = 'Bob' where id = 2;
      merge into ${T}.people t using (select 3 id, 'Cy' name) s on t.id = s.id
        when matched then update set name = s.name
        when not matched then insert (id, name, tags) values (s.id, s.name, array_construct());
      select * from ${T}.people order by id;
      delete from ${T}.people where id = 3;
      drop table ${T}.people;`);
    assert.deepEqual(s.map((o) => o.kind), ['ddl', 'dml', 'dml', 'dml', 'select', 'dml', 'ddl']);
    assert.match((s[0] as { message: string }).message, /PEOPLE successfully created/i);
    assert.equal((s[1] as { rowsAffected: number }).rowsAffected, 2);
    assert.equal((s[2] as { rowsAffected: number }).rowsAffected, 1);
    assert.equal((s[3] as { rowsAffected: number }).rowsAffected, 1);
    const sel = s[4] as { rows: Record<string, unknown>[] };
    assert.deepEqual(sel.rows.map((r) => r.NAME), ['Ana', 'Bob', 'Cy']);
    assert.deepEqual(sel.rows[1].TAGS, ['b', 'c']);
    assert.equal((s[5] as { rowsAffected: number }).rowsAffected, 1);
    for (const o of s) {
      if (o.kind !== 'error' && o.kind !== 'cancelled' && o.kind !== 'script-completed') {
        assert.equal(typeof o.executionMs, 'number');
      }
    }
  });

  it('stops at the first error and keeps earlier results', async () => {
    const r = await run(`select 1 as a; select * from ${T}.does_not_exist_xyz; select 3 as c;`);
    assert.equal(r.kind, 'multi');
    const s = (r as { statements: { kind: string; message?: string }[] }).statements;
    assert.deepEqual(s.map((o) => o.kind), ['select', 'error']);
    assert.match(s[1].message ?? '', /does not exist|not authorized/i);
  });

  it('single failing statement surfaces Snowflake\'s error text', async () => {
    const r = await run('selec 1');
    assert.equal(r.kind, 'error');
    assert.match((r as { message: string }).message, /syntax error/i);
  });

  it('session state carries over between runs (USE, variables, temp tables)', async () => {
    await run(`use schema ${T}; set my_var = 41; create or replace temporary table tmp_carry (x int); insert into tmp_carry values (1);`);
    const { rows } = await select('select current_schema() as s, $my_var + 1 as v, (select count(*) from tmp_carry) as n');
    assert.equal(rows[0].S, 'PUBLIC');
    assert.equal(rows[0].V, 42);
    assert.equal(rows[0].N, 1);
  });

  it('Snowflake Scripting block and EXECUTE IMMEDIATE run as one statement', async () => {
    const block = await select(`declare
        total int default 0;
      begin
        for i in 1 to 3 do
          total := total + i;
        end for;
        if (total > 5) then
          total := total * 10;
        end if;
        return total;
      end;`);
    assert.equal(Object.values(block.rows[0])[0], 60);
    const imm = await select(`execute immediate $$ select 'a;b' as semi $$;`);
    assert.equal(imm.rows[0].SEMI, 'a;b');
  });

  it('time travel: AT(OFFSET) and BEFORE(STATEMENT) see older versions', async () => {
    await run(`create or replace table ${T}.tt (v int); insert into ${T}.tt values (1);`);
    await new Promise((res) => setTimeout(res, 3000));
    const upd = await run(`update ${T}.tt set v = 2`);
    assert.equal(upd.kind, 'multi');
    const { rows: qid } = await select('select last_query_id() as q');
    const updateId = String(qid[0].Q);
    const now = await select(`select v from ${T}.tt`);
    assert.equal(now.rows[0].V, 2);
    const before = await select(`select v from ${T}.tt before(statement => '${updateId}')`);
    assert.equal(before.rows[0].V, 1);
    const ago = await select(`select v from ${T}.tt at(offset => -2)`);
    assert.equal(ago.rows[0].V, 1);
    await run(`drop table ${T}.tt`);
    // UNDROP restores it (Fail-safe / time-travel feature).
    const und = await run(`undrop table ${T}.tt`);
    assert.notEqual(und.kind, 'error');
    await run(`drop table ${T}.tt`);
  });

  it('transactions: BEGIN / ROLLBACK is split correctly and honoured', async () => {
    const s = await multi(`create or replace table ${T}.txn (v int);
      begin;
      insert into ${T}.txn values (1);
      rollback;
      select count(*) as n from ${T}.txn;
      drop table ${T}.txn;`);
    assert.equal(s.length, 6);
    const sel = s[4] as { rows: Record<string, unknown>[] };
    assert.equal(sel.rows[0].N, 0);
  });

  it('SHOW / DESCRIBE return grids, not status banners', async () => {
    const show = await select(`show schemas in database ${TEST_DB}`);
    assert.ok(show.columns.some((c) => c.field === 'name'), 'lower-case SHOW column names kept');
    const desc = await select(`describe table snowflake_sample_data.tpch_sf1.nation`);
    assert.ok(desc.rows.length >= 4);
  });

  it('status-only DDL in a single run renders as a one-statement overview', async () => {
    const r = await run(`create or replace temporary table ${T}.one_ddl (x int)`);
    assert.equal(r.kind, 'multi');
    const s = (r as { statements: { kind: string }[] }).statements;
    assert.deepEqual(s.map((o) => o.kind), ['ddl']);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE, run, select, typeOf } from './helpers';
import { runSnowflake } from '../../src/snowflake/runSnowflake';
import { getConnection, resolveConnection } from '../../src/snowflake/client';

// Big public data (SNOWFLAKE_SAMPLE_DATA.TPCH_*), result caps, cancel,
// reconnects, odd column names, wide tables.
describe('live: scale, limits and robustness', { skip: !LIVE }, () => {
  it('fetches a full 150k-row public table', async () => {
    const { columns, rows } = await select('select * from snowflake_sample_data.tpch_sf1.customer');
    assert.equal(rows.length, 150000);
    assert.equal(typeOf(columns, 'C_ACCTBAL'), 'decimal');
    assert.equal(typeOf(columns, 'C_CUSTKEY'), 'number');
  });

  it('TPC-H Q1 aggregation over 6M lineitem rows', async () => {
    const { rows } = await select(`select l_returnflag, l_linestatus, sum(l_quantity) as sum_qty,
        avg(l_extendedprice) as avg_price, count(*) as count_order
      from snowflake_sample_data.tpch_sf1.lineitem
      where l_shipdate <= dateadd(day, -90, to_date('1998-12-01'))
      group by 1, 2 order by 1, 2`);
    assert.equal(rows.length, 4);
    const total = rows.reduce((s, r) => s + Number(r.COUNT_ORDER), 0);
    assert.ok(total > 5_900_000);
  });

  it('stops with a clear message when the result passes the size cap', async () => {
    const r = await run('select * from snowflake_sample_data.tpch_sf1.orders', { maxBytes: 5 * 1024 * 1024 });
    assert.equal(r.kind, 'error');
    assert.match((r as { message: string }).message, /Result too large to display/);
  });

  it('cancel stops a running query', async () => {
    const h = runSnowflake('call system$wait(30)', undefined);
    setTimeout(() => h.cancel(), 2500);
    const t0 = Date.now();
    const r = await h.promise;
    assert.equal(r.kind, 'error');
    assert.match((r as { message: string }).message, /cancelled/i);
    assert.ok(Date.now() - t0 < 15000, 'returned promptly after cancel');
  });

  it('cancel mid-script keeps finished statements', async () => {
    const h = runSnowflake('select 1 as a; call system$wait(30); select 3 as c;', undefined);
    setTimeout(() => h.cancel(), 4000);
    const r = await h.promise;
    assert.equal(r.kind, 'multi');
    const kinds = (r as { statements: { kind: string }[] }).statements.map((s) => s.kind);
    assert.deepEqual(kinds, ['select', 'cancelled']);
  });

  it('reconnects transparently when the session was closed', async () => {
    await select('select 1 as warm');
    const resolved = resolveConnection(undefined);
    assert.ok(!('error' in resolved));
    const conn = await getConnection(resolved as Exclude<typeof resolved, { error: string }>);
    await new Promise<void>((res) => conn.destroy(() => res()));
    const { rows } = await select('select 2 as after_reconnect');
    assert.equal(rows[0].AFTER_RECONNECT, 2);
  });

  it('unknown connection name gives a helpful error', async () => {
    const r = await run('select 1', { connection: 'no_such_connection' });
    assert.equal(r.kind, 'error');
    assert.match((r as { message: string }).message, /no_such_connection.*not found.*Available: /s);
  });

  it('duplicate, lower-case, spaced and unicode column names', async () => {
    const { columns, rows } = await select(`select 1 as a, 2 as a, 3 as "a", 4 as "with space", 5 as "dot.ted", 6 as "año", 7 as "A_2"`);
    assert.deepEqual(columns.map((c) => c.field), ['A', 'A_3', 'a', 'with space', 'dot.ted', 'año', 'A_2']);
    assert.deepEqual(Object.values(rows[0]), [1, 2, 3, 4, 5, 6, 7]);
  });

  it('wide table: 300 columns', async () => {
    const cols = Array.from({ length: 300 }, (_, i) => `${i} as c${i}`).join(', ');
    const { columns, rows } = await select(`select ${cols}`);
    assert.equal(columns.length, 300);
    assert.equal(rows[0].C299, 299);
  });

  it('empty result keeps its columns and types', async () => {
    const { columns, rows } = await select('select * from snowflake_sample_data.tpch_sf1.nation where 1 = 0');
    assert.equal(rows.length, 0);
    assert.deepEqual(columns.map((c) => c.field), ['N_NATIONKEY', 'N_NAME', 'N_REGIONKEY', 'N_COMMENT']);
  });

  it('comments and blank statements around the SQL are ignored', async () => {
    const { rows } = await select(`-- leading comment
      /* block ; with semicolon */
      select 'x;y' as v -- trailing ; comment
      ;
      ;`);
    assert.equal(rows[0].V, 'x;y');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE, select, typeOf } from './helpers';

// Snowflake's take on the BigQuery STRUCT / ARRAY / JSON fixtures
// (test_q1..q4): arrays, objects, arrays of objects, objects of arrays,
// arrays in arrays, deep nesting, VARIANT scalars, structured types.
describe('live: nested data', { skip: !LIVE }, () => {
  it('arrays, objects and their combinations', async () => {
    const { columns, rows } = await select(`select
      array_construct(1, 2, 3) as int_arr,
      array_construct('a', null, 'c') as arr_with_null,
      array_construct() as empty_arr,
      object_construct('name', 'Ana', 'age', 31) as obj,
      object_construct() as empty_obj,
      array_construct(object_construct('id', 1, 'tags', array_construct('x', 'y')),
                      object_construct('id', 2, 'tags', array_construct())) as arr_of_obj,
      object_construct('items', array_construct(1, 2), 'meta', object_construct('k', 'v')) as obj_of_arr,
      array_construct(array_construct(1, 2), array_construct(3, array_construct(4, 5))) as arr_of_arr,
      object_construct_keep_null('present', 1, 'missing', null) as obj_keep_null`);
    const r = rows[0];
    assert.equal(typeOf(columns, 'INT_ARR'), 'array');
    assert.deepEqual(r.INT_ARR, [1, 2, 3]);
    // Snowflake stores the NULL as `undefined`; the grid gets a real null.
    assert.deepEqual(r.ARR_WITH_NULL, ['a', null, 'c']);
    assert.deepEqual(r.EMPTY_ARR, []);
    assert.equal(typeOf(columns, 'OBJ'), 'struct');
    assert.deepEqual(r.OBJ, { age: 31, name: 'Ana' });
    assert.deepEqual(r.EMPTY_OBJ, {});
    assert.deepEqual(r.ARR_OF_OBJ, [{ id: 1, tags: ['x', 'y'] }, { id: 2, tags: [] }]);
    assert.deepEqual(r.OBJ_OF_ARR, { items: [1, 2], meta: { k: 'v' } });
    assert.deepEqual(r.ARR_OF_ARR, [[1, 2], [3, [4, 5]]]);
    assert.deepEqual(r.OBJ_KEEP_NULL, { missing: null, present: 1 });
  });

  it('deep nesting (6 levels) survives intact', async () => {
    const { rows } = await select(`select parse_json('{"l1":{"l2":[{"l3":{"l4":[[{"l5":{"l6":"deep"}}]]}}]}}') as v`);
    const v = rows[0].V as Record<string, any>;
    assert.equal(v.l1.l2[0].l3.l4[0][0].l5.l6, 'deep');
  });

  it('VARIANT: scalars, JSON null vs SQL NULL, big numbers', async () => {
    const { columns, rows } = await select(`select
      parse_json('42') as v_int,
      parse_json('"text"') as v_str,
      parse_json('true') as v_bool,
      parse_json('null') as v_json_null,
      null::variant as v_sql_null,
      parse_json('{"big": 12345678901234567890, "ok": 7, "dec": 0.1, "long": 1.2345678901234567890}') as v_big,
      to_variant('2024-02-29'::date) as v_date,
      to_variant(123.45::number(10,2)) as v_num,
      to_variant(array_construct(1, null, 3)) as v_arr_null`);
    const r = rows[0];
    assert.equal(typeOf(columns, 'V_INT'), 'json');
    assert.equal(r.V_INT, 42);
    assert.equal(r.V_STR, 'text');
    assert.equal(r.V_BOOL, true);
    // JSON null inside a VARIANT is a value; SQL NULL is absence.
    assert.equal(r.V_JSON_NULL, null);
    assert.equal(r.V_SQL_NULL, null);
    const big = r.V_BIG as Record<string, unknown>;
    assert.equal(big.ok, 7);
    assert.equal(big.dec, 0.1);
    if (typeof big.big === 'string') {
      // Runtime supports JSON.parse source access: exact digits kept.
      assert.equal(big.big, '12345678901234567890');
      // Snowflake itself normalises away the trailing zero.
      assert.equal(big.long, '1.234567890123456789');
    }
    assert.equal(r.V_DATE, '2024-02-29');
    assert.equal(r.V_NUM, 123.45);
    assert.deepEqual(r.V_ARR_NULL, [1, null, 3]);
  });

  it('structured types (OBJECT(...), ARRAY(type), MAP) and GEOGRAPHY / VECTOR', async () => {
    const { columns, rows } = await select(`select
      {'a': 1, 'b': 'z'}::object(a int, b varchar) as sobj,
      [1, 2, 3]::array(int) as sarr,
      {'k1': 10, 'k2': 20}::map(varchar, int) as smap,
      to_geography('POINT(-122.35 37.55)') as geo,
      [1.5, 2.5]::vector(float, 2) as vec`);
    const r = rows[0];
    assert.equal(typeOf(columns, 'SOBJ'), 'struct');
    assert.deepEqual(r.SOBJ, { a: 1, b: 'z' });
    assert.equal(typeOf(columns, 'SARR'), 'array');
    assert.deepEqual(r.SARR, [1, 2, 3]);
    assert.equal(typeOf(columns, 'SMAP'), 'struct');
    assert.deepEqual(r.SMAP, { k1: 10, k2: 20 });
    assert.deepEqual(r.GEO, { coordinates: [-122.35, 37.55], type: 'Point' });
    assert.equal(typeOf(columns, 'VEC'), 'array');
    assert.deepEqual(r.VEC, [1.5, 2.5]);
  });

  it('nested values over many rows (10k generated rows)', async () => {
    const { rows } = await select(`select seq4() as id,
        object_construct('id', seq4(), 'sq', array_construct(seq4(), seq4() * seq4())) as o
      from table(generator(rowcount => 10000))`);
    assert.equal(rows.length, 10000);
    const last = rows[9999] as { ID: number; O: { id: number; sq: number[] } };
    assert.equal(last.O.id, last.ID);
    assert.deepEqual(last.O.sq, [last.ID, last.ID * last.ID]);
  });

  it('FLATTEN over a nested array (the UNNEST equivalent)', async () => {
    const { rows } = await select(`select f.index as idx, f.value:id::int as id, f.value:tags as tags
      from table(flatten(input => parse_json('[{"id":1,"tags":["a"]},{"id":2,"tags":["b","c"]}]'))) f
      order by idx`);
    assert.deepEqual(rows.map((r) => r.ID), [1, 2]);
    assert.deepEqual(rows[1].TAGS, ['b', 'c']);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE, select, typeOf } from './helpers';

// Every scalar type the grid has to render, checked for exact values.
describe('live: scalar types', { skip: !LIVE }, () => {
  it('numbers keep exact precision', async () => {
    const { columns, rows } = await select(`select
      42::number(38,0) as small_int,
      -9007199254740991::number(38,0) as min_safe,
      9007199254740993::number(38,0) as past_safe,
      99999999999999999999999999999999999999::number(38,0) as max_38,
      123.45::number(10,2) as dec2,
      0.0000000000000000000000000000000000001::number(38,37) as tiny,
      -0.50::number(5,2) as neg_dec,
      0::number(38,0) as zero,
      1.5::float as flt, -1.5e300::float as big_flt, 0.1::float as tenth,
      'NaN'::float as nan, 'inf'::float as pinf, '-inf'::float as ninf`);
    const r = rows[0];
    assert.equal(typeOf(columns, 'SMALL_INT'), 'number');
    assert.equal(r.SMALL_INT, 42);
    assert.equal(r.MIN_SAFE, -9007199254740991);
    assert.equal(typeOf(columns, 'PAST_SAFE'), 'decimal');
    assert.equal(r.PAST_SAFE, '9007199254740993');
    assert.equal(r.MAX_38, '99999999999999999999999999999999999999');
    assert.equal(typeOf(columns, 'DEC2'), 'decimal');
    assert.equal(r.DEC2, '123.45');
    assert.equal(r.TINY, '0.0000000000000000000000000000000000001');
    assert.equal(r.NEG_DEC, '-0.50');
    assert.equal(r.ZERO, 0);
    assert.equal(typeOf(columns, 'FLT'), 'number');
    assert.equal(r.FLT, 1.5);
    assert.equal(r.BIG_FLT, -1.5e300);
    assert.equal(r.TENTH, 0.1);
    assert.equal(r.NAN, 'NaN');
    assert.equal(r.PINF, 'Infinity');
    assert.equal(r.NINF, '-Infinity');
  });

  it('text, unicode, binary, booleans and NULL vs empty', async () => {
    const { columns, rows } = await select(`select
      'héllo 🐻 日本語 ñ' as uni,
      'line1\nline2\ttab "dq" ''sq''' as special,
      '' as empty_str,
      null::varchar as null_str,
      to_binary('48656C6C6F00FF', 'HEX') as bin,
      true as t, false as f, null::boolean as nb`);
    const r = rows[0];
    assert.equal(r.UNI, 'héllo 🐻 日本語 ñ');
    assert.equal(r.SPECIAL, 'line1\nline2\ttab "dq" \'sq\'');
    assert.equal(r.EMPTY_STR, '');
    assert.equal(r.NULL_STR, null);
    assert.equal(typeOf(columns, 'BIN'), 'bytes');
    assert.equal(r.BIN, Buffer.from('48656C6C6F00FF', 'hex').toString('base64'));
    assert.equal(typeOf(columns, 'T'), 'boolean');
    assert.equal(r.T, true);
    assert.equal(r.F, false);
    assert.equal(r.NB, null);
  });

  it('dates and times keep every digit', async () => {
    const { columns, rows } = await select(`select
      '2024-02-29'::date as d,
      '0001-01-01'::date as d_min,
      '9999-12-31'::date as d_max,
      '1969-07-20'::date as d_pre_epoch,
      '13:45:12.123456789'::time(9) as t9,
      '13:45:12.123'::time(3) as t3,
      '23:59:59'::time(0) as t0,
      '00:00:00.000001'::time(6) as t_micro`);
    const r = rows[0];
    assert.equal(typeOf(columns, 'D'), 'date');
    assert.equal(r.D, '2024-02-29');
    assert.equal(r.D_MIN, '0001-01-01');
    assert.equal(r.D_MAX, '9999-12-31');
    assert.equal(r.D_PRE_EPOCH, '1969-07-20');
    assert.equal(typeOf(columns, 'T9'), 'time');
    assert.equal(r.T9, '13:45:12.123456789');
    assert.equal(r.T3, '13:45:12.123');
    assert.equal(r.T0, '23:59:59');
    assert.equal(r.T_MICRO, '00:00:00.000001');
  });

  it('timestamps keep precision and offsets', async () => {
    const { columns, rows } = await select(`select
      '2024-02-29 13:45:12.123456789'::timestamp_ntz(9) as ntz9,
      '2024-02-29 13:45:12.123456'::timestamp_ntz(6) as ntz6,
      '2024-02-29 13:45:12'::timestamp_ntz(0) as ntz0,
      '1960-01-01 00:00:00.5'::timestamp_ntz(1) as ntz_pre_epoch,
      '2024-02-29 13:45:12.123456789 -0800'::timestamp_tz(9) as tz9,
      '2024-06-01 08:00:00 +0530'::timestamp_tz(0) as tz_india,
      '2024-06-01 08:00:00 +1345'::timestamp_tz(0) as tz_chatham,
      convert_timezone('America/Los_Angeles', '2024-07-01 12:00:00 +0000'::timestamp_tz(3)) as tz_dst,
      '2024-01-15 12:00:00.000 +0000'::timestamp_ltz(3) as ltz_winter,
      '2024-07-15 12:00:00.000 +0000'::timestamp_ltz(3) as ltz_summer`);
    const r = rows[0];
    assert.equal(typeOf(columns, 'NTZ9'), 'datetime');
    assert.equal(r.NTZ9, '2024-02-29 13:45:12.123456789');
    assert.equal(r.NTZ6, '2024-02-29 13:45:12.123456');
    assert.equal(r.NTZ0, '2024-02-29 13:45:12');
    assert.equal(r.NTZ_PRE_EPOCH, '1960-01-01 00:00:00.5');
    assert.equal(typeOf(columns, 'TZ9'), 'timestamp');
    assert.equal(r.TZ9, '2024-02-29 13:45:12.123456789 -0800');
    assert.equal(r.TZ_INDIA, '2024-06-01 08:00:00 +0530');
    assert.equal(r.TZ_CHATHAM, '2024-06-01 08:00:00 +1345');
    // CONVERT_TIMEZONE returns TIMESTAMP_TZ(9), so 9 digits is the column's scale.
    assert.equal(r.TZ_DST, '2024-07-01 05:00:00.000000000 -0700');
    assert.equal(typeOf(columns, 'LTZ_WINTER'), 'timestamp');
    // LTZ renders in the session time zone (the account default here).
    assert.match(String(r.LTZ_WINTER), /^2024-01-15 \d{2}:00:00\.000 [+-]\d{4}$/);
    assert.match(String(r.LTZ_SUMMER), /^2024-07-15 \d{2}:00:00\.000 [+-]\d{4}$/);
  });
});

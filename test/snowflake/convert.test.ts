import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertResult,
  formatDate,
  formatTime,
  formatTimestampNtz,
  formatTimestampWithZone,
  parseJsonExact,
  uniqueFieldNames,
  zoneOffsetMinutes,
} from '../../src/snowflake/convert';
import { buildTabResult, toOutcome } from '../../src/snowflake/runSnowflake';

function sfDate(epochSeconds: number, nanos = 0, scale = 0, tz: unknown = 'UTC') {
  return {
    getEpochSeconds: () => epochSeconds,
    getNanoSeconds: () => nanos,
    getScale: () => scale,
    getTimezone: () => tz,
  };
}

// 2024-02-29T13:45:12Z
const LEAP = Date.UTC(2024, 1, 29, 13, 45, 12) / 1000;

describe('convert: temporal formatting', () => {
  it('DATE incl. pre-epoch and extremes', () => {
    assert.equal(formatDate(sfDate(LEAP)), '2024-02-29');
    assert.equal(formatDate(sfDate(Date.UTC(1969, 6, 20) / 1000)), '1969-07-20');
    assert.equal(formatDate(sfDate(Date.UTC(9999, 11, 31) / 1000)), '9999-12-31');
    assert.equal(formatDate(sfDate(-62135596800)), '0001-01-01');
  });

  it('TIMESTAMP_NTZ keeps exactly `scale` fractional digits', () => {
    assert.equal(formatTimestampNtz(sfDate(LEAP, 123456789, 9), 9), '2024-02-29 13:45:12.123456789');
    assert.equal(formatTimestampNtz(sfDate(LEAP, 123456000, 6), 6), '2024-02-29 13:45:12.123456');
    assert.equal(formatTimestampNtz(sfDate(LEAP, 5000000, 3), 3), '2024-02-29 13:45:12.005');
    assert.equal(formatTimestampNtz(sfDate(LEAP), 0), '2024-02-29 13:45:12');
  });

  it('TIMESTAMP_TZ with numeric offsets (incl. half-hour and +13:45)', () => {
    assert.equal(formatTimestampWithZone(sfDate(LEAP, 0, 0, -480), 0), '2024-02-29 05:45:12 -0800');
    assert.equal(formatTimestampWithZone(sfDate(LEAP, 0, 0, 330), 0), '2024-02-29 19:15:12 +0530');
    assert.equal(formatTimestampWithZone(sfDate(LEAP, 0, 0, 825), 0), '2024-03-01 03:30:12 +1345');
    assert.equal(formatTimestampWithZone(sfDate(LEAP, 1, 9, 0), 9), '2024-02-29 13:45:12.000000001 +0000');
  });

  it('TIMESTAMP_LTZ follows the zone\'s DST rules', () => {
    const winter = Date.UTC(2024, 0, 15, 20) / 1000;
    const summer = Date.UTC(2024, 6, 15, 20) / 1000;
    assert.equal(formatTimestampWithZone(sfDate(winter, 0, 3, 'America/Los_Angeles'), 3), '2024-01-15 12:00:00.000 -0800');
    assert.equal(formatTimestampWithZone(sfDate(summer, 0, 3, 'America/Los_Angeles'), 3), '2024-07-15 13:00:00.000 -0700');
    assert.equal(formatTimestampWithZone(sfDate(summer, 0, 0, 'Asia/Kolkata'), 0), '2024-07-16 01:30:00 +0530');
    assert.equal(formatTimestampWithZone(sfDate(summer, 0, 0, { name: 'Europe/Madrid' }), 0), '2024-07-15 22:00:00 +0200');
  });

  it('zone offsets: UTC aliases, unknown zones, DST edges', () => {
    assert.equal(zoneOffsetMinutes('UTC', LEAP), 0);
    assert.equal(zoneOffsetMinutes('Etc/GMT+5', LEAP), -300);
    assert.equal(zoneOffsetMinutes('Not/AZone', LEAP), 0);
    // 2024-03-10 09:59:59Z is still PST, 10:00:00Z is PDT.
    assert.equal(zoneOffsetMinutes('America/Los_Angeles', Date.UTC(2024, 2, 10, 9, 59, 59) / 1000), -480);
    assert.equal(zoneOffsetMinutes('America/Los_Angeles', Date.UTC(2024, 2, 10, 10) / 1000), -420);
  });

  it('TIME', () => {
    assert.equal(formatTime(49512, 123456789, 9), '13:45:12.123456789');
    assert.equal(formatTime(0, 1000, 6), '00:00:00.000001');
    assert.equal(formatTime(86399, 0, 0), '23:59:59');
  });
});

describe('convert: JSON with exact numbers', () => {
  it('keeps unsafe integers / long decimals as text when the runtime allows', () => {
    const v = parseJsonExact('{"big": 12345678901234567890, "ok": 7, "neg": -9007199254740993, "f": 0.1, "long": 3.14159265358979323846}') as Record<string, unknown>;
    assert.equal(v.ok, 7);
    assert.equal(v.f, 0.1);
    const supportsSource = typeof v.big === 'string';
    if (supportsSource) {
      assert.equal(v.big, '12345678901234567890');
      assert.equal(v.neg, '-9007199254740993');
      assert.equal(v.long, '3.14159265358979323846');
    }
  });
});

describe('convert: result sets', () => {
  it('maps every Snowflake type to the grid type', () => {
    const cols = [
      ['fixed', 0], ['fixed', 2], ['real', null], ['text', null], ['binary', null], ['boolean', null],
      ['date', null], ['time', 9], ['timestamp_ntz', 9], ['timestamp_ltz', 3], ['timestamp_tz', 9],
      ['variant', null], ['object', null], ['array', null], ['map', null], ['vector', null], ['decfloat', null],
      ['geography_or_future', null],
    ].map(([type, scale], i) => ({ name: `C${i}`, type: type as string, scale: scale as number | null }));
    const { columns } = convertResult(cols, []);
    assert.deepEqual(columns.map((c) => c.type), [
      'number', 'decimal', 'number', 'string', 'bytes', 'boolean',
      'date', 'time', 'datetime', 'timestamp', 'timestamp',
      'json', 'struct', 'array', 'struct', 'array', 'decimal',
      'string',
    ]);
  });

  it('integer columns: number when every value is safe, decimal when any is not', () => {
    const safe = convertResult([{ name: 'N', type: 'fixed', scale: 0 }], [['1'], ['-42'], [null]]);
    assert.equal(safe.columns[0].type, 'number');
    assert.deepEqual(safe.rows.map((r) => r.N), [1, -42, null]);
    const big = convertResult([{ name: 'N', type: 'fixed', scale: 0 }], [['1'], ['12345678901234567890']]);
    assert.equal(big.columns[0].type, 'decimal');
    assert.deepEqual(big.rows.map((r) => r.N), ['1', '12345678901234567890']);
  });

  it('floats, NaN and infinities', () => {
    const r = convertResult([{ name: 'F', type: 'real', scale: null }], [['1.5'], ['-1.5e+300'], ['NaN'], ['inf'], ['-inf'], [2.5]]);
    assert.deepEqual(r.rows.map((x) => x.F), [1.5, -1.5e300, 'NaN', 'Infinity', '-Infinity', 2.5]);
  });

  it('binary becomes base64; VARIANT strings are parsed; undefined array slots become null', () => {
    const r = convertResult(
      [{ name: 'B', type: 'binary', scale: null }, { name: 'V', type: 'variant', scale: null }, { name: 'A', type: 'array', scale: null }],
      [[Buffer.from([0, 255]), '{"a": [1, undefined, "undefined"]}', ['x', undefined, { y: undefined }]]],
    );
    assert.equal(r.rows[0].B, 'AP8=');
    assert.deepEqual(r.rows[0].V, { a: [1, null, 'undefined'] });
    assert.deepEqual(r.rows[0].A, ['x', null, { y: null }]);
  });

  it('unparseable VARIANT text is shown verbatim instead of failing', () => {
    const r = convertResult([{ name: 'V', type: 'variant', scale: null }], [['not json']]);
    assert.equal(r.rows[0].V, 'not json');
  });

  it('duplicate names get unique suffixes that never collide', () => {
    assert.deepEqual(uniqueFieldNames(['A', 'A', 'a', 'A_2', 'A']), ['A', 'A_3', 'a', 'A_2', 'A_4']);
  });
});

describe('convert: statement outcomes', () => {
  const ok = (columns: { name: string; type: string; scale: number | null }[], rows: unknown[][], numUpdatedRows: number | null = null) =>
    ({ ok: true as const, columns, rows, numUpdatedRows, queryId: 'q', elapsedMs: 12 });

  it('DML uses the update count, or sums MERGE action columns', () => {
    assert.deepEqual(toOutcome('insert into t values (1),(2)', ok([], [], 2)), { kind: 'dml', rowsAffected: 2, message: '2 rows affected', executionMs: 12 });
    const merge = toOutcome('MERGE into t using s on ...', ok(
      [{ name: 'number of rows inserted', type: 'fixed', scale: 0 }, { name: 'number of rows updated', type: 'fixed', scale: 0 }],
      [['3', '1']],
    ));
    assert.equal(merge.kind, 'dml');
    assert.equal((merge as { rowsAffected: number }).rowsAffected, 4);
    assert.equal((toOutcome('delete from t', ok([], [], 1)) as { message: string }).message, '1 row affected');
  });

  it('status-only results are DDL banners, except for SHOW/SELECT-like statements', () => {
    const status = [{ name: 'status', type: 'text', scale: null }];
    assert.deepEqual(toOutcome('create table t (x int)', ok(status, [['Table T successfully created.']])), {
      kind: 'ddl', message: 'Table T successfully created.', executionMs: 12,
    });
    assert.equal(toOutcome('select 1 as status', ok(status, [['1']])).kind, 'select');
    assert.equal(toOutcome('show x', ok(status, [['v']])).kind, 'select');
    assert.deepEqual(toOutcome('alter session set x = 1', ok([], [])), { kind: 'ddl', message: 'Statement executed successfully.', executionMs: 12 });
  });

  it('single SELECT unwraps to kind ok; errors / cancel to kind error; others to multi', () => {
    const timing = { totalMs: 1, dryMs: 0, realMs: 1, parseMs: 0, engine: 'snowflake' as const };
    const sel = { kind: 'select' as const, columns: [], rows: [] };
    assert.equal(buildTabResult(['select 1'], [sel], timing).kind, 'ok');
    assert.deepEqual(buildTabResult(['x'], [{ kind: 'error', message: 'boom' }], timing), { kind: 'error', message: 'boom' });
    assert.deepEqual(buildTabResult(['x'], [{ kind: 'cancelled' }], timing), { kind: 'error', message: 'Query cancelled.' });
    assert.deepEqual(buildTabResult(['a', 'b'], [{ kind: 'cancelled' }], timing), { kind: 'error', message: 'Query cancelled.' });
    const m = buildTabResult(['a', 'b', 'c'], [sel, { kind: 'error', message: 'e' }], timing);
    assert.equal(m.kind, 'multi');
    assert.deepEqual((m as { sqlPreviews: unknown[] }).sqlPreviews, ['a', 'b']);
  });
});

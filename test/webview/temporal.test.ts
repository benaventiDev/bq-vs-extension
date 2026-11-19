import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareTimestampStrings } from '../../src/webview/temporal';

describe('grid: timestamp sort', () => {
  it('orders Snowflake offsets by instant, not by text', () => {
    const vals = [
      '2024-01-01 10:00:00 -0800', // 18:00Z
      '2024-01-01 12:00:00 +0100', // 11:00Z
      '2024-01-01 17:30:00 +0530', // 12:00Z
    ];
    assert.deepEqual([...vals].sort(compareTimestampStrings), [vals[1], vals[2], vals[0]]);
  });

  it('BigQuery UTC strings keep their natural order, sub-ms digits break ties', () => {
    const vals = ['2026-04-15 18:17:12.418001 UTC', '2026-04-15 18:17:12.418000 UTC', '2025-01-01 00:00:00 UTC'];
    assert.deepEqual([...vals].sort(compareTimestampStrings), [vals[2], vals[1], vals[0]]);
  });

  it('nanosecond ties and nulls', () => {
    assert.ok(compareTimestampStrings('2024-01-01 00:00:00.000000001 +0000', '2024-01-01 00:00:00.000000002 +0000') < 0);
    assert.ok(compareTimestampStrings(null, '2024-01-01 00:00:00 UTC') < 0);
    assert.ok(compareTimestampStrings('2024-01-01 00:00:00 UTC', undefined) > 0);
    assert.equal(compareTimestampStrings(null, null), 0);
  });

  it('unparseable values fall back to text order', () => {
    assert.ok(compareTimestampStrings('abc', 'abd') < 0);
  });
});

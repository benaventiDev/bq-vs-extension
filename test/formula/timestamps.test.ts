import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../src/formula/parser';
import { buildContext, matches } from '../../src/formula/evaluator';
import type { ParsedColumn } from '../../src/bq/parseJson';

function check(formula: string, row: Record<string, unknown>, cols: ParsedColumn[]): boolean {
  const { ast, diagnostics } = parse(formula);
  assert.ok(ast, diagnostics[0]?.message);
  return matches(ast, row, buildContext(cols)).matched;
}

// Conditional formatting / formula rules on Snowflake temporal columns.
describe('formula: Snowflake timestamps with offsets', () => {
  const ts: ParsedColumn[] = [{ field: 'ts', type: 'timestamp' }];

  it('compares the instant, not the wall clock', () => {
    // 10:00 -0800 = 18:00Z, which is after 17:00Z.
    assert.equal(check('ts > "2024-01-01 17:00:00 UTC"', { ts: '2024-01-01 10:00:00 -0800' }, ts), true);
    assert.equal(check('ts < "2024-01-01 17:00:00 UTC"', { ts: '2024-01-01 10:00:00 -0800' }, ts), false);
    assert.equal(check('ts = "2024-01-01 18:00:00 UTC"', { ts: '2024-01-01 23:30:00.000000000 +0530' }, ts), true);
  });

  it('BigQuery-style values still work', () => {
    assert.equal(check('ts > "2024-01-01"', { ts: '2026-04-15 18:17:12.418000 UTC' }, ts), true);
  });

  it('NTZ (datetime) with a space separator and nanoseconds', () => {
    const dt: ParsedColumn[] = [{ field: 'dt', type: 'datetime' }];
    assert.equal(check('dt >= "2024-02-29"', { dt: '2024-02-29 13:45:12.123456789' }, dt), true);
    assert.equal(check('dt < "2024-02-29"', { dt: '2024-02-29 13:45:12.123456789' }, dt), false);
  });
});

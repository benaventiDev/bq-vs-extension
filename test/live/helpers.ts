import assert from 'node:assert/strict';
import { after } from 'node:test';
import { runSnowflake } from '../../src/snowflake/runSnowflake';
import { disposeAllConnections } from '../../src/snowflake/client';

// The shared session keeps heartbeat timers alive; close it so the file exits.
after(() => disposeAllConnections());
import type { StatementOutcome, TabResult } from '../../src/panel/types';
import type { ParsedColumn, ParsedRow } from '../../src/bq/parseJson';

/** Live tests run only with `node scripts/test.js --live`. */
export const LIVE = process.env.BQX_LIVE === '1';
export const TEST_DB = 'BQX_TEST';

export async function run(sql: string, opts: { maxBytes?: number; connection?: string } = {}): Promise<TabResult> {
  return runSnowflake(sql, opts.connection, { maxBytes: opts.maxBytes }).promise;
}

export async function select(sql: string): Promise<{ columns: ParsedColumn[]; rows: ParsedRow[] }> {
  const r = await run(sql);
  if (r.kind === 'error') assert.fail(`query failed: ${r.message}\nSQL: ${sql}`);
  assert.equal(r.kind, 'ok', `expected a single result set, got ${r.kind}`);
  return r as { kind: 'ok'; columns: ParsedColumn[]; rows: ParsedRow[] };
}

export async function multi(sql: string): Promise<StatementOutcome[]> {
  const r = await run(sql);
  if (r.kind === 'error') assert.fail(`script failed: ${r.message}`);
  assert.equal(r.kind, 'multi');
  return (r as { statements: StatementOutcome[] }).statements;
}

export function typeOf(columns: ParsedColumn[], field: string): string | undefined {
  return columns.find((c) => c.field === field)?.type;
}

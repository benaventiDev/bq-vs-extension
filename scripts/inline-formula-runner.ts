// Companion to scripts/smoke-formula.js — runs assertion-style smoke checks
// against the formula language. Not shipped, not imported by the extension.

import { parse } from '../src/formula/parser';
import { buildContext, matches } from '../src/formula/evaluator';
import type { ParsedColumn } from '../src/bq/parseJson';

interface Case {
  formula: string;
  row: Record<string, unknown>;
  cols: ParsedColumn[];
  // Optional full row set — required for COUNTIF / COUNTIFS cases.
  allRows?: Record<string, unknown>[];
  expectMatched?: boolean;
  expectMissing?: boolean;
  expectTypeMismatch?: boolean;
  expectParseError?: boolean;
  label: string;
}

const cases: Case[] = [
  {
    label: 'simple comparison',
    formula: 'num_col > 100',
    row: { num_col: 150 },
    cols: [{ field: 'num_col', type: 'number' }],
    expectMatched: true,
  },
  {
    label: 'simple comparison false',
    formula: 'num_col > 100',
    row: { num_col: 50 },
    cols: [{ field: 'num_col', type: 'number' }],
    expectMatched: false,
  },
  {
    label: 'AND with NOT and ISNULL',
    formula: 'AND(NOT(ISNULL(str_col)), num_col > 100)',
    row: { str_col: 'abc', num_col: 150 },
    cols: [
      { field: 'str_col', type: 'string' },
      { field: 'num_col', type: 'number' },
    ],
    expectMatched: true,
  },
  {
    label: 'AND fails when ISNULL true',
    formula: 'AND(NOT(ISNULL(str_col)), num_col > 100)',
    row: { str_col: null, num_col: 150 },
    cols: [
      { field: 'str_col', type: 'string' },
      { field: 'num_col', type: 'number' },
    ],
    expectMatched: false,
  },
  {
    label: 'missing column => NOT_APPLIED',
    formula: 'foo > 100',
    row: { bar: 5 },
    cols: [{ field: 'bar', type: 'number' }],
    expectMatched: false,
    expectMissing: true,
  },
  {
    label: 'type mismatch ordered compare',
    formula: 'name > 5',
    row: { name: 'hello' },
    cols: [{ field: 'name', type: 'string' }],
    expectMatched: false,
    expectTypeMismatch: true,
  },
  {
    label: 'equal-mixed-types => not equal (not type mismatch)',
    formula: 'a = "5"',
    row: { a: 5 },
    cols: [{ field: 'a', type: 'number' }],
    expectMatched: false,
  },
  {
    label: 'CONTAINS',
    formula: 'CONTAINS(LOWER(name), "admin")',
    row: { name: 'AdminUser' },
    cols: [{ field: 'name', type: 'string' }],
    expectMatched: true,
  },
  {
    label: 'MOD',
    formula: 'MOD(n, 2) = 0',
    row: { n: 10 },
    cols: [{ field: 'n', type: 'number' }],
    expectMatched: true,
  },
  {
    label: 'YEAR on Date',
    formula: 'YEAR(d) = 2026',
    row: { d: new Date('2026-05-23T00:00:00') },
    cols: [{ field: 'd', type: 'datetime' }],
    expectMatched: true,
  },
  {
    label: 'IF returning boolean',
    formula: 'IF(num_col > 100, TRUE, FALSE)',
    row: { num_col: 200 },
    cols: [{ field: 'num_col', type: 'number' }],
    expectMatched: true,
  },
  {
    label: 'case-insensitive column ref',
    formula: 'Num_Col > 100',
    row: { num_col: 150 },
    cols: [{ field: 'num_col', type: 'number' }],
    expectMatched: true,
  },
  {
    label: 'OR short-circuits NULL on first arg',
    formula: 'OR(ISNULL(x), x > 100)',
    row: { x: null },
    cols: [{ field: 'x', type: 'number' }],
    expectMatched: true,
  },
  {
    label: 'division by zero => NULL => no match',
    formula: '10 / x > 1',
    row: { x: 0 },
    cols: [{ field: 'x', type: 'number' }],
    expectMatched: false,
  },
  {
    label: 'parse error: unterminated string',
    formula: 'name = "hello',
    row: {},
    cols: [],
    expectParseError: true,
  },
  {
    label: 'parse error: chained comparison',
    formula: '1 = 1 = 1',
    row: {},
    cols: [],
    expectParseError: true,
  },
  {
    label: 'parse error: unknown function',
    formula: 'FOOBAR(x)',
    row: { x: 1 },
    cols: [{ field: 'x', type: 'number' }],
    expectParseError: true,
  },
  {
    label: 'parse error: wrong arg count',
    formula: 'IF(1, 2)',
    row: {},
    cols: [],
    expectParseError: true,
  },

  // -----------------------------------------------------------------------
  // COUNTIF / COUNTIFS — aggregations across the full result.
  // -----------------------------------------------------------------------
  {
    label: 'COUNTIF same-column self-count > threshold',
    formula: 'COUNTIF(str_col, str_col) > 2',
    row: { str_col: 'alice' },
    cols: [{ field: 'str_col', type: 'string' }],
    allRows: [
      { str_col: 'alice' }, { str_col: 'alice' }, { str_col: 'alice' },
      { str_col: 'bob' }, { str_col: 'carol' },
    ],
    expectMatched: true,
  },
  {
    label: 'COUNTIF same-column self-count <= threshold',
    formula: 'COUNTIF(str_col, str_col) > 2',
    row: { str_col: 'bob' },
    cols: [{ field: 'str_col', type: 'string' }],
    allRows: [
      { str_col: 'alice' }, { str_col: 'alice' }, { str_col: 'alice' },
      { str_col: 'bob' }, { str_col: 'carol' },
    ],
    expectMatched: false,
  },
  {
    label: 'COUNTIF operator-string ">N"',
    formula: 'COUNTIF(num_col, ">100") >= 2',
    row: {},
    cols: [{ field: 'num_col', type: 'number' }],
    allRows: [
      { num_col: 50 }, { num_col: 150 }, { num_col: 200 }, { num_col: 30 },
    ],
    expectMatched: true,
  },
  {
    label: 'COUNTIF operator-string "<>" with string',
    formula: 'COUNTIF(cat_col, "<>vip") = 2',
    row: {},
    cols: [{ field: 'cat_col', type: 'string' }],
    allRows: [
      { cat_col: 'vip' }, { cat_col: 'gold' }, { cat_col: 'silver' }, { cat_col: 'vip' },
    ],
    expectMatched: true,
  },
  {
    label: 'COUNTIF wildcard *',
    formula: 'COUNTIF(cat_col, "vip*") = 2',
    row: {},
    cols: [{ field: 'cat_col', type: 'string' }],
    allRows: [
      { cat_col: 'vip-1' }, { cat_col: 'vip-2' }, { cat_col: 'gold' }, { cat_col: 'other' },
    ],
    expectMatched: true,
  },
  {
    label: 'COUNTIF wildcard % (SQL alias)',
    formula: 'COUNTIF(notes, "%callback%") = 2',
    row: {},
    cols: [{ field: 'notes', type: 'string' }],
    allRows: [
      { notes: 'will callback later' }, { notes: 'callback today' }, { notes: 'no notes' },
    ],
    expectMatched: true,
  },
  {
    label: 'COUNTIF escaped wildcard \\* matches literal *',
    formula: 'COUNTIF(label, "vip\\*") = 1',
    row: {},
    cols: [{ field: 'label', type: 'string' }],
    allRows: [
      { label: 'vip*' }, { label: 'vip-1' }, { label: 'vipx' },
    ],
    expectMatched: true,
  },
  {
    label: 'COUNTIF NULL row excluded',
    formula: 'COUNTIF(str_col, str_col) >= 1',
    row: { str_col: null },
    cols: [{ field: 'str_col', type: 'string' }],
    allRows: [
      { str_col: null }, { str_col: 'alice' },
    ],
    // current row str_col is NULL; criterion is NULL; NULL doesn't match anything
    expectMatched: false,
  },
  {
    label: 'COUNTIF missing column => NOT_APPLIED',
    formula: 'COUNTIF(missing_col, "x") > 0',
    row: { str_col: 'alice' },
    cols: [{ field: 'str_col', type: 'string' }],
    allRows: [{ str_col: 'alice' }],
    expectMatched: false,
    expectMissing: true,
  },
  {
    label: 'COUNTIFS two criteria (AND)',
    formula: 'COUNTIFS(str_col, str_col, num_col, ">100") >= 2',
    row: { str_col: 'alice', num_col: 200 },
    cols: [
      { field: 'str_col', type: 'string' },
      { field: 'num_col', type: 'number' },
    ],
    allRows: [
      { str_col: 'alice', num_col: 50 },
      { str_col: 'alice', num_col: 150 },
      { str_col: 'alice', num_col: 200 },
      { str_col: 'bob', num_col: 999 },
    ],
    expectMatched: true,
  },
  {
    label: 'COUNTIFS odd-count arg fails to parse',
    formula: 'COUNTIFS(str_col, "a", num_col)',
    row: {},
    cols: [],
    expectParseError: true,
  },
  {
    label: 'COUNTIF first arg must be column ref',
    formula: 'COUNTIF(LOWER(str_col), "alice")',
    row: {},
    cols: [],
    expectParseError: true,
  },
  {
    label: 'COUNTIF "=" operator-string equals direct value',
    formula: 'COUNTIF(cat_col, "=vip") = 2',
    row: {},
    cols: [{ field: 'cat_col', type: 'string' }],
    allRows: [
      { cat_col: 'vip' }, { cat_col: 'gold' }, { cat_col: 'vip' },
    ],
    expectMatched: true,
  },

  // -----------------------------------------------------------------------
  // Backtick column references + single-quoted string literals.
  // Backticks = column ref (BQ identifier syntax); both "..." and '...' are
  // string literals. See session-notes/isnull-fix-notes.md.
  // -----------------------------------------------------------------------
  {
    label: 'backtick column ISNULL matches null cell (DATETIME)',
    formula: 'ISNULL(`sch end time`)',
    row: { 'sch end time': null },
    cols: [{ field: 'sch end time', type: 'datetime' }],
    expectMatched: true,
  },
  {
    label: 'backtick column ISNULL false on non-null TIMESTAMP cell',
    formula: 'ISNULL(`sch end time`)',
    row: { 'sch end time': '2026-04-15 18:00:00 UTC' },
    cols: [{ field: 'sch end time', type: 'timestamp' }],
    expectMatched: false,
  },
  {
    label: 'backtick column ISNULL matches null STRING',
    formula: 'ISNULL(`null string`)',
    row: { 'null string': null },
    cols: [{ field: 'null string', type: 'string' }],
    expectMatched: true,
  },
  {
    label: 'backtick column ISNULL matches null INT',
    formula: 'ISNULL(`null int`)',
    row: { 'null int': null },
    cols: [{ field: 'null int', type: 'number' }],
    expectMatched: true,
  },
  {
    label: 'backtick column ISNULL matches null BOOL',
    formula: 'ISNULL(`null bool`)',
    row: { 'null bool': null },
    cols: [{ field: 'null bool', type: 'boolean' }],
    expectMatched: true,
  },
  {
    label: 'backtick column ISBLANK matches null',
    formula: 'ISBLANK(`my col`)',
    row: { 'my col': null },
    cols: [{ field: 'my col', type: 'string' }],
    expectMatched: true,
  },
  {
    label: 'backtick column ISBLANK matches empty string',
    formula: 'ISBLANK(`my col`)',
    row: { 'my col': '' },
    cols: [{ field: 'my col', type: 'string' }],
    expectMatched: true,
  },
  {
    label: 'backtick column case-insensitive match',
    formula: 'ISNULL(`Sch End Time`)',
    row: { 'sch end time': null },
    cols: [{ field: 'sch end time', type: 'datetime' }],
    expectMatched: true,
  },
  {
    label: 'backtick column ordered comparison still works',
    formula: '`talk time` > 100',
    row: { 'talk time': 150 },
    cols: [{ field: 'talk time', type: 'number' }],
    expectMatched: true,
  },
  {
    label: 'backtick missing column => NOT_APPLIED + missingColumn',
    formula: 'ISNULL(`not here`)',
    row: { other: 1 },
    cols: [{ field: 'other', type: 'number' }],
    expectMatched: false,
    expectMissing: true,
  },
  {
    label: 'single-quoted string is a literal (equality match)',
    formula: "cat_col = 'vip'",
    row: { cat_col: 'vip' },
    cols: [{ field: 'cat_col', type: 'string' }],
    expectMatched: true,
  },
  {
    label: 'double-quoted string stays a literal (backward compat)',
    formula: 'cat_col = "vip"',
    row: { cat_col: 'vip' },
    cols: [{ field: 'cat_col', type: 'string' }],
    expectMatched: true,
  },
  {
    label: 'quoted string equal to a column NAME is NOT resolved as column',
    formula: 'cat_col = "status"',
    row: { cat_col: 'open', status: 'open' },
    cols: [
      { field: 'cat_col', type: 'string' },
      { field: 'status', type: 'string' },
    ],
    expectMatched: false,
  },
  {
    label: 'single-quoted ISNULL arg is a literal, never null',
    formula: "ISNULL('sch end time')",
    row: { 'sch end time': null },
    cols: [{ field: 'sch end time', type: 'datetime' }],
    expectMatched: false,
  },
  {
    label: 'COUNTIF with backtick column ref (self-count)',
    formula: 'COUNTIF(`agent id`, `agent id`) > 1',
    row: { 'agent id': 'a1' },
    cols: [{ field: 'agent id', type: 'string' }],
    allRows: [{ 'agent id': 'a1' }, { 'agent id': 'a1' }, { 'agent id': 'b2' }],
    expectMatched: true,
  },
  {
    label: 'single quotes no longer a parse error',
    formula: "name = 'hello'",
    row: { name: 'hello' },
    cols: [{ field: 'name', type: 'string' }],
    expectMatched: true,
  },
  {
    label: 'parse error: unterminated backtick',
    formula: 'ISNULL(`sch end time)',
    row: {},
    cols: [],
    expectParseError: true,
  },
];

export function run(): boolean {
  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    const { ast, diagnostics } = parse(c.formula);
    if (c.expectParseError) {
      if (ast === null && diagnostics.length > 0) {
        pass++;
        console.log(`PASS  ${c.label}`);
      } else {
        fail++;
        console.log(`FAIL  ${c.label} — expected parse error, got AST`);
      }
      continue;
    }
    if (!ast) {
      fail++;
      console.log(`FAIL  ${c.label} — unexpected parse error: ${diagnostics[0]?.message}`);
      continue;
    }
    const ctx = buildContext(c.cols, {
      allRows: c.allRows,
      countCache: new Map<string, number>(),
    });
    const { matched, report } = matches(ast, c.row, ctx);
    const matchedOk = c.expectMatched === undefined || matched === c.expectMatched;
    const missingOk = c.expectMissing === undefined || report.missingColumn === c.expectMissing;
    const typeOk = c.expectTypeMismatch === undefined || report.typeMismatch === c.expectTypeMismatch;
    if (matchedOk && missingOk && typeOk) {
      pass++;
      console.log(`PASS  ${c.label}`);
    } else {
      fail++;
      console.log(
        `FAIL  ${c.label} — matched=${matched} missing=${report.missingColumn} typeMismatch=${report.typeMismatch}`,
      );
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail === 0;
}

// Splits a Snowflake SQL script into top-level statements.
//
// We run multi-statement scripts one statement at a time on the same session
// (rather than Snowflake's MULTI_STATEMENT_COUNT mode) so a failure in
// statement N still shows the results of 1..N-1, each statement gets its own
// timing, and cancel stops between statements — the same experience as the
// BigQuery script overview.
//
// Semicolons don't split when they're inside:
//   'strings' (with '' and \' escapes), "quoted identifiers",
//   -- / // line comments, /* block comments */, $$dollar-quoted bodies$$,
//   Snowflake Scripting blocks: [DECLARE ...] BEGIN ... END
// `BEGIN;` / `BEGIN TRANSACTION` / `BEGIN WORK` are transaction starts, not
// blocks. CASE ... END (expression or scripting CASE ... END CASE) is tracked
// so its END doesn't close a BEGIN block early; END IF / END LOOP / END FOR /
// END WHILE / END REPEAT close constructs we don't count, so they're ignored.

export interface SqlPiece {
  /** Statement text without the trailing semicolon, trimmed. */
  sql: string;
}

const WORD_RE = /[A-Za-z_][A-Za-z0-9_$]*/y;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/** Next word after position `i`, skipping whitespace and comments. */
function peekWord(sql: string, i: number): string {
  let j = i;
  for (;;) {
    while (j < sql.length && /\s/.test(sql[j])) j++;
    if (sql.startsWith('--', j) || sql.startsWith('//', j)) {
      const nl = sql.indexOf('\n', j);
      j = nl < 0 ? sql.length : nl + 1;
      continue;
    }
    if (sql.startsWith('/*', j)) {
      const end = sql.indexOf('*/', j + 2);
      j = end < 0 ? sql.length : end + 2;
      continue;
    }
    break;
  }
  if (sql[j] === ';') return ';';
  WORD_RE.lastIndex = j;
  const m = WORD_RE.exec(sql);
  return m ? m[0].toUpperCase() : '';
}

/** True if the text has something other than whitespace and comments. */
export function hasCode(sql: string): boolean {
  return stripComments(sql).trim().length > 0;
}

function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(sql, i, ch);
      out += sql.slice(i, end);
      i = end;
    } else if (sql.startsWith('--', i) || sql.startsWith('//', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += ' ';
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (quote === "'" && ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

export function splitSnowflakeSql(sql: string): SqlPiece[] {
  const pieces: SqlPiece[] = [];
  let start = 0;
  let i = 0;
  // Stack of open constructs: 'BEGIN' blocks and 'CASE' expressions.
  const stack: string[] = [];
  // A top-level DECLARE section: semicolons don't split until its block ends.
  let inDeclare = false;

  const push = (end: number): void => {
    const text = sql.slice(start, end).trim();
    if (hasCode(text)) pieces.push({ sql: text });
  };

  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (sql.startsWith('--', i) || sql.startsWith('//', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (sql.startsWith('$$', i)) {
      const end = sql.indexOf('$$', i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (ch === ';') {
      if (stack.length === 0 && !inDeclare) {
        push(i);
        start = i + 1;
      }
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch) && !isWordChar(sql[i - 1])) {
      WORD_RE.lastIndex = i;
      const word = (WORD_RE.exec(sql) as RegExpExecArray)[0];
      const upper = word.toUpperCase();
      const after = i + word.length;
      // DECLARE also appears mid-statement: CREATE PROCEDURE ... AS DECLARE ...
      if (upper === 'DECLARE' && stack.length === 0) {
        inDeclare = true;
      } else if (upper === 'BEGIN') {
        const next = peekWord(sql, after);
        const isTxn =
          stack.length === 0 && !inDeclare &&
          (next === ';' || next === 'TRANSACTION' || next === 'WORK' || next === 'NAME' || next === '');
        if (!isTxn) stack.push('BEGIN');
      } else if (upper === 'CASE') {
        stack.push('CASE');
      } else if (upper === 'END') {
        const next = peekWord(sql, after);
        if (next === 'IF' || next === 'LOOP' || next === 'FOR' || next === 'WHILE' || next === 'REPEAT') {
          // closes a construct we don't track
        } else {
          stack.pop();
          if (next === 'CASE') {
            // `END CASE` — consume the CASE keyword so it isn't re-pushed.
            const ws = sql.slice(after).match(/^\s*/)?.[0].length ?? 0;
            i = after + ws + 4;
            continue;
          }
          if (stack.length === 0) inDeclare = false;
        }
      }
      i = after;
      continue;
    }
    i++;
  }
  push(sql.length);
  return pieces;
}

/** Leading keyword of a statement (comments / parens skipped), upper-cased. */
export function leadingKeyword(sql: string): string {
  const code = stripComments(sql).replace(/^[\s(]+/, '');
  const m = /^[A-Za-z_]+/.exec(code);
  return m ? m[0].toUpperCase() : '';
}

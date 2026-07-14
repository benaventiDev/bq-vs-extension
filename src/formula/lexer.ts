// Lexer for the M8 formula language. Produces a flat token stream from a
// formula string. Errors carry an offset + length so Monaco can squiggly the
// exact character range.

export type TokenType =
  | 'number'
  | 'string'
  | 'identifier'      // bare identifier, e.g. num_col
  | 'quoted-id'       // "column with space"
  | 'true'
  | 'false'
  | 'null'
  | 'and'
  | 'or'
  | 'not'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'plus'
  | 'minus'
  | 'star'
  | 'slash'
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte';

export interface Token {
  type: TokenType;
  value: string;        // raw text (for identifiers/numbers/strings: the source slice; for keywords: lowercased)
  start: number;        // offset in the source string (inclusive)
  end: number;          // offset in the source string (exclusive)
}

export class LexError extends Error {
  constructor(
    public readonly message: string,
    public readonly start: number,
    public readonly end: number,
  ) {
    super(message);
  }
}

const KEYWORD_MAP: Record<string, TokenType> = {
  TRUE: 'true',
  FALSE: 'false',
  NULL: 'null',
  AND: 'and',
  OR: 'or',
  NOT: 'not',
};

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}

function isIdentCont(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

// Read a quoted run starting at `start` (which points at the opening quote
// character `q`). A doubled quote (`qq`) inside the run is an escaped literal
// quote. Returns the unescaped content, the index just past the closing quote,
// and whether a closing quote was found. Shared by string literals (`"`, `'`)
// and backtick column references (`` ` ``).
function readQuoted(
  source: string,
  start: number,
  q: string,
): { value: string; end: number; closed: boolean } {
  const n = source.length;
  let i = start + 1;
  let value = '';
  let closed = false;
  while (i < n) {
    const ch = source[i];
    if (ch === q) {
      if (source[i + 1] === q) {
        value += q;
        i += 2;
        continue;
      }
      closed = true;
      i++;
      break;
    }
    value += ch;
    i++;
  }
  return { value, end: i, closed };
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i];

    // Whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }

    // Single-char punctuation
    if (c === '(') { tokens.push({ type: 'lparen', value: '(', start: i, end: i + 1 }); i++; continue; }
    if (c === ')') { tokens.push({ type: 'rparen', value: ')', start: i, end: i + 1 }); i++; continue; }
    if (c === ',') { tokens.push({ type: 'comma', value: ',', start: i, end: i + 1 }); i++; continue; }
    if (c === '+') { tokens.push({ type: 'plus', value: '+', start: i, end: i + 1 }); i++; continue; }
    if (c === '*') { tokens.push({ type: 'star', value: '*', start: i, end: i + 1 }); i++; continue; }
    if (c === '/') { tokens.push({ type: 'slash', value: '/', start: i, end: i + 1 }); i++; continue; }
    if (c === '=') { tokens.push({ type: 'eq', value: '=', start: i, end: i + 1 }); i++; continue; }

    // Multi-char comparison operators
    if (c === '<') {
      if (source[i + 1] === '=') {
        tokens.push({ type: 'lte', value: '<=', start: i, end: i + 2 });
        i += 2;
      } else if (source[i + 1] === '>') {
        tokens.push({ type: 'neq', value: '<>', start: i, end: i + 2 });
        i += 2;
      } else {
        tokens.push({ type: 'lt', value: '<', start: i, end: i + 1 });
        i++;
      }
      continue;
    }
    if (c === '>') {
      if (source[i + 1] === '=') {
        tokens.push({ type: 'gte', value: '>=', start: i, end: i + 2 });
        i += 2;
      } else {
        tokens.push({ type: 'gt', value: '>', start: i, end: i + 1 });
        i++;
      }
      continue;
    }

    // Minus: emitted as binary token; parser handles unary contextually
    if (c === '-') { tokens.push({ type: 'minus', value: '-', start: i, end: i + 1 }); i++; continue; }

    // Number literal
    if (isDigit(c)) {
      const start = i;
      while (i < n && isDigit(source[i])) i++;
      if (i < n && source[i] === '.') {
        i++;
        while (i < n && isDigit(source[i])) i++;
      }
      // Optional exponent (e.g. 1e3, 1.5e-2)
      if (i < n && (source[i] === 'e' || source[i] === 'E')) {
        const ePos = i;
        let j = i + 1;
        if (j < n && (source[j] === '+' || source[j] === '-')) j++;
        if (j < n && isDigit(source[j])) {
          i = j + 1;
          while (i < n && isDigit(source[i])) i++;
        } else {
          // bare 'e' / 'E' — not part of a number; stop here
          void ePos;
        }
      }
      tokens.push({ type: 'number', value: source.slice(start, i), start, end: i });
      continue;
    }

    // String literal — double- OR single-quoted. BigQuery accepts both quote
    // styles for strings, so the formula language does too (a single-quoted
    // string is no longer a parse error). Column references use backticks,
    // not quotes, so there's no ambiguity: `"..."` and `'...'` are always
    // string literals. A doubled quote (`""` / `''`) escapes a literal quote.
    if (c === '"' || c === "'") {
      const { value, end, closed } = readQuoted(source, i, c);
      if (!closed) {
        throw new LexError(
          'Unterminated string literal — missing closing quote.',
          i,
          end,
        );
      }
      tokens.push({ type: 'string', value, start: i, end });
      i = end;
      continue;
    }

    // Backtick-quoted column reference — BigQuery's identifier-quoting syntax.
    // Used for column names that aren't valid bare identifiers (spaces,
    // special characters): `sch end time`. Emitted as 'quoted-id'; the parser
    // turns it into a column-reference node.
    if (c === '`') {
      const { value, end, closed } = readQuoted(source, i, '`');
      if (!closed) {
        throw new LexError(
          'Unterminated column reference — missing closing backtick.',
          i,
          end,
        );
      }
      if (value.length === 0) {
        throw new LexError(
          'Empty column reference — backticks must enclose a column name.',
          i,
          end,
        );
      }
      tokens.push({ type: 'quoted-id', value, start: i, end });
      i = end;
      continue;
    }

    // Identifier or keyword
    if (isIdentStart(c)) {
      const start = i;
      while (i < n && isIdentCont(source[i])) i++;
      const raw = source.slice(start, i);
      const upper = raw.toUpperCase();
      const kw = KEYWORD_MAP[upper];
      if (kw) {
        tokens.push({ type: kw, value: raw, start, end: i });
      } else {
        tokens.push({ type: 'identifier', value: raw, start, end: i });
      }
      continue;
    }

    throw new LexError(`Unexpected character '${c}'.`, i, i + 1);
  }

  return tokens;
}

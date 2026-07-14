// Recursive-descent parser for the M8 formula language. Produces an AST and
// runs save-time semantic checks (unknown functions, wrong argument counts).
// Evaluate-time errors like missing columns are deferred to the evaluator.

import { LexError, tokenize, type Token, type TokenType } from './lexer';
import { findFunctionDoc, isFunctionName } from './docs';

export type Expr =
  | { type: 'number'; value: number; start: number; end: number }
  | { type: 'string'; value: string; start: number; end: number }
  | { type: 'boolean'; value: boolean; start: number; end: number }
  | { type: 'null'; start: number; end: number }
  | { type: 'column'; name: string; start: number; end: number }
  | { type: 'unary'; op: 'NOT' | '-'; operand: Expr; start: number; end: number }
  | { type: 'binary'; op: BinaryOp; left: Expr; right: Expr; start: number; end: number }
  | { type: 'call'; name: string; args: Expr[]; start: number; end: number };

export type BinaryOp =
  | '+' | '-' | '*' | '/'
  | '=' | '<>' | '<' | '<=' | '>' | '>='
  | 'AND' | 'OR';

export class ParseError extends Error {
  constructor(
    public readonly message: string,
    public readonly start: number,
    public readonly end: number,
  ) {
    super(message);
  }
}

export interface ParseDiagnostic {
  message: string;
  start: number;
  end: number;
  severity: 'error';
}

export interface ParseResult {
  ast: Expr | null;
  diagnostics: ParseDiagnostic[];
}

// Upper bound on formula size. A pathologically large formula can overflow the
// parser stack (deep parens / NOT / unary chains) or build a deeply left-nested
// AST (long infix OR/AND/+ chains) that overflows the evaluator — both surface
// as an uncaught RangeError. Cap well above any realistic formula (even a
// 100-value OR(...) is ~410 tokens) yet far below the empirical overflow points
// (~1465 nested parens, ~2198-deep AST), so parse() returns a clean diagnostic
// instead of throwing (FORM-3).
const MAX_TOKENS = 1000;

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly sourceLen: number,
  ) {}

  peek(offset = 0): Token | null {
    return this.tokens[this.pos + offset] ?? null;
  }

  consume(): Token {
    const t = this.tokens[this.pos];
    if (!t) {
      throw new ParseError('Unexpected end of formula.', this.sourceLen, this.sourceLen);
    }
    this.pos++;
    return t;
  }

  expect(type: TokenType, message: string): Token {
    const t = this.peek();
    if (!t || t.type !== type) {
      const start = t ? t.start : this.sourceLen;
      const end = t ? t.end : this.sourceLen;
      throw new ParseError(message, start, end);
    }
    return this.consume();
  }

  match(...types: TokenType[]): Token | null {
    const t = this.peek();
    if (t && types.includes(t.type)) {
      return this.consume();
    }
    return null;
  }

  // Grammar (lowest to highest precedence):
  //   expr        = or_expr
  //   or_expr     = and_expr ('OR' and_expr)*
  //   and_expr    = not_expr ('AND' not_expr)*
  //   not_expr    = 'NOT' not_expr | comparison
  //   comparison  = additive (cmp_op additive)?         // chained comparisons disallowed
  //   additive    = multiplicative (('+'|'-') multiplicative)*
  //   multiplicative = unary (('*'|'/') unary)*
  //   unary       = '-' unary | primary
  //   primary     = number | string | TRUE | FALSE | NULL
  //                 | identifier  ( '(' arglist ')' )?  // function call or column ref
  //                 | `quoted column name`              // backtick = column ref
  //                 | '(' expr ')'

  parseExpr(): Expr {
    const e = this.parseOr();
    if (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos];
      throw new ParseError(
        `Unexpected '${t.value}' — expression already complete.`,
        t.start,
        t.end,
      );
    }
    return e;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.match('or')) {
      const right = this.parseAnd();
      left = { type: 'binary', op: 'OR', left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.match('and')) {
      const right = this.parseNot();
      left = { type: 'binary', op: 'AND', left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private parseNot(): Expr {
    const notTok = this.match('not');
    if (notTok) {
      const operand = this.parseNot();
      return { type: 'unary', op: 'NOT', operand, start: notTok.start, end: operand.end };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    const left = this.parseAdditive();
    const opTok = this.peek();
    if (
      opTok &&
      (opTok.type === 'eq' || opTok.type === 'neq' ||
        opTok.type === 'lt' || opTok.type === 'lte' ||
        opTok.type === 'gt' || opTok.type === 'gte')
    ) {
      this.consume();
      const right = this.parseAdditive();
      // Reject a second comparison operator (x = 1 = 2 is ambiguous; we don't
      // do chained comparisons).
      const next = this.peek();
      if (next && (
        next.type === 'eq' || next.type === 'neq' ||
        next.type === 'lt' || next.type === 'lte' ||
        next.type === 'gt' || next.type === 'gte'
      )) {
        throw new ParseError(
          'Chained comparison is not supported — wrap with AND().',
          next.start,
          next.end,
        );
      }
      const cmpOp = opTok.type === 'eq' ? '='
        : opTok.type === 'neq' ? '<>'
        : opTok.type === 'lt' ? '<'
        : opTok.type === 'lte' ? '<='
        : opTok.type === 'gt' ? '>'
        : '>=';
      return { type: 'binary', op: cmpOp, left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (true) {
      const t = this.peek();
      if (!t) break;
      if (t.type !== 'plus' && t.type !== 'minus') break;
      this.consume();
      const right = this.parseMultiplicative();
      left = {
        type: 'binary',
        op: t.type === 'plus' ? '+' : '-',
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (true) {
      const t = this.peek();
      if (!t) break;
      if (t.type !== 'star' && t.type !== 'slash') break;
      this.consume();
      const right = this.parseUnary();
      left = {
        type: 'binary',
        op: t.type === 'star' ? '*' : '/',
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  private parseUnary(): Expr {
    const m = this.match('minus');
    if (m) {
      const operand = this.parseUnary();
      return { type: 'unary', op: '-', operand, start: m.start, end: operand.end };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (!t) {
      throw new ParseError(
        'Unexpected end of formula — expected a value or column reference.',
        this.sourceLen,
        this.sourceLen,
      );
    }

    if (t.type === 'number') {
      this.consume();
      const n = Number(t.value);
      if (!Number.isFinite(n)) {
        throw new ParseError(`Invalid number literal '${t.value}'.`, t.start, t.end);
      }
      return { type: 'number', value: n, start: t.start, end: t.end };
    }

    if (t.type === 'string') {
      this.consume();
      return { type: 'string', value: t.value, start: t.start, end: t.end };
    }

    if (t.type === 'true') {
      this.consume();
      return { type: 'boolean', value: true, start: t.start, end: t.end };
    }
    if (t.type === 'false') {
      this.consume();
      return { type: 'boolean', value: false, start: t.start, end: t.end };
    }
    if (t.type === 'null') {
      this.consume();
      return { type: 'null', start: t.start, end: t.end };
    }

    if (t.type === 'lparen') {
      this.consume();
      const inner = this.parseOr();
      this.expect('rparen', "Expected ')' to close parenthesized expression.");
      const closing = this.tokens[this.pos - 1];
      return { ...inner, start: t.start, end: closing.end };
    }

    // AND/OR/NOT can also appear as function-call form (Sheets/Excel allow
    // both AND() and infix AND). When we see one of them followed by '(' in
    // primary position, parse as a call. (Infix forms are handled in the
    // higher-precedence rules above.)
    if ((t.type === 'and' || t.type === 'or' || t.type === 'not') &&
        this.peek(1)?.type === 'lparen') {
      this.consume(); // keyword
      this.consume(); // '('
      const args: Expr[] = [];
      if (this.peek()?.type !== 'rparen') {
        args.push(this.parseOr());
        while (this.match('comma')) {
          args.push(this.parseOr());
        }
      }
      const closeParen = this.expect('rparen', "Expected ')' to close function call.");
      const upperName = t.value.toUpperCase();
      const doc = findFunctionDoc(upperName)!;
      if (args.length < doc.minArity || args.length > doc.maxArity) {
        const expected = doc.maxArity === Infinity
          ? `at least ${doc.minArity}`
          : doc.minArity === doc.maxArity
            ? `${doc.minArity}`
            : `${doc.minArity}-${doc.maxArity}`;
        throw new ParseError(
          `${upperName}() expects ${expected} argument${doc.maxArity === 1 ? '' : 's'}, got ${args.length}.`,
          t.start,
          closeParen.end,
        );
      }
      return { type: 'call', name: upperName, args, start: t.start, end: closeParen.end };
    }

    if (t.type === 'identifier') {
      this.consume();
      const next = this.peek();
      if (next && next.type === 'lparen') {
        // Function call.
        this.consume(); // '('
        const args: Expr[] = [];
        if (this.peek()?.type !== 'rparen') {
          args.push(this.parseOr());
          while (this.match('comma')) {
            args.push(this.parseOr());
          }
        }
        const closeParen = this.expect('rparen', "Expected ')' to close function call.");
        const upperName = t.value.toUpperCase();
        if (!isFunctionName(upperName)) {
          throw new ParseError(
            `Unknown function '${t.value}'.`,
            t.start,
            t.end,
          );
        }
        const doc = findFunctionDoc(upperName)!;
        if (args.length < doc.minArity || args.length > doc.maxArity) {
          const expected = doc.maxArity === Infinity
            ? `at least ${doc.minArity}`
            : doc.minArity === doc.maxArity
              ? `${doc.minArity}`
              : `${doc.minArity}-${doc.maxArity}`;
          throw new ParseError(
            `${upperName}() expects ${expected} argument${doc.maxArity === 1 ? '' : 's'}, got ${args.length}.`,
            t.start,
            closeParen.end,
          );
        }
        // COUNTIF / COUNTIFS: the column-position args (every even-indexed
        // arg) must be bare column references, not expressions. COUNTIFS
        // also needs an even total arg count (column, criterion) pairs.
        // Caught at parse time so users get a Monaco squiggly immediately.
        if (upperName === 'COUNTIFS' && args.length % 2 !== 0) {
          throw new ParseError(
            `COUNTIFS() expects pairs of (column, criterion) — got ${args.length} arguments.`,
            t.start,
            closeParen.end,
          );
        }
        if (upperName === 'COUNTIF' || upperName === 'COUNTIFS') {
          for (let i = 0; i < args.length; i += 2) {
            if (args[i].type !== 'column') {
              throw new ParseError(
                `${upperName}() expects a column reference at argument ${i + 1}, not an expression.`,
                args[i].start,
                args[i].end,
              );
            }
          }
        }
        return { type: 'call', name: upperName, args, start: t.start, end: closeParen.end };
      }
      // Bare identifier = column reference.
      return { type: 'column', name: t.value, start: t.start, end: t.end };
    }

    // Backtick-quoted column reference (e.g. `sch end time`). The lexer emits
    // this only for backticked runs, so there's no ambiguity with string
    // literals: `"..."` / `'...'` are always strings, backticks are always a
    // column reference. This is how the user already quotes the column in
    // their BigQuery SQL.
    if (t.type === 'quoted-id') {
      this.consume();
      return { type: 'column', name: t.value, start: t.start, end: t.end };
    }

    // (Reached only when we somehow have a non-handled token type.)
    throw new ParseError(`Unexpected token '${t.value}'.`, t.start, t.end);
  }
}

export function parse(source: string): ParseResult {
  const diagnostics: ParseDiagnostic[] = [];
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch (e) {
    if (e instanceof LexError) {
      diagnostics.push({ message: e.message, start: e.start, end: e.end, severity: 'error' });
      return { ast: null, diagnostics };
    }
    throw e;
  }
  if (tokens.length === 0) {
    diagnostics.push({
      message: 'Formula is empty.',
      start: 0,
      end: Math.max(0, source.length),
      severity: 'error',
    });
    return { ast: null, diagnostics };
  }
  // Reject pathologically large formulas before recursing — see MAX_TOKENS.
  if (tokens.length > MAX_TOKENS) {
    diagnostics.push({
      message: `Formula is too long or complex (${tokens.length} tokens; limit ${MAX_TOKENS}). Simplify it or split into multiple rules.`,
      start: 0,
      end: Math.max(0, source.length),
      severity: 'error',
    });
    return { ast: null, diagnostics };
  }
  const parser = new Parser(tokens, source.length);
  try {
    const ast = parser.parseExpr();
    return { ast, diagnostics };
  } catch (e) {
    if (e instanceof ParseError) {
      diagnostics.push({ message: e.message, start: e.start, end: e.end, severity: 'error' });
      return { ast: null, diagnostics };
    }
    throw e;
  }
}

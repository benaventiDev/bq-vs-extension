import type { SchemaField } from './dryRun';

export type ColumnType =
  | 'string'
  | 'number'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'timestamp'
  | 'time'
  | 'bytes'
  | 'struct'
  | 'array'
  | 'json'
  | 'null';

export type CellValue =
  | string
  | number
  | boolean
  | Date
  | null
  | unknown[]
  | Record<string, unknown>;

export interface ParsedColumn {
  field: string;
  type: ColumnType;
}

export type ParsedRow = Record<string, unknown>;

export interface ParsedJson {
  columns: ParsedColumn[];
  rows: ParsedRow[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;
// TIMESTAMP uses space separator; microseconds + TZ both optional (bq CLI's
// --format=json emits '2026-04-16 18:35:50' for round seconds, with no UTC).
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?( ?UTC| ?Z| ?[+-]\d{2}:?\d{2})?$/;
const TIME_RE = /^\d{2}:\d{2}:\d{2}(\.\d+)?$/;
const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?\d+\.\d+(?:[eE][+-]?\d+)?$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date)
  );
}

function safeInt(s: string): number | null {
  try {
    const big = BigInt(s);
    if (
      big > BigInt(Number.MAX_SAFE_INTEGER) ||
      big < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      return null;
    }
    return Number(big);
  } catch {
    return null;
  }
}

function maybeParseJsonString(v: string): unknown | undefined {
  const t = v.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

interface ColumnInfo {
  field: string;
  type: ColumnType;
  coerceNumeric: boolean;
}

function inferValueType(v: unknown): ColumnType {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (Array.isArray(v)) return 'array';
  if (isPlainObject(v)) return 'struct';
  if (typeof v === 'string') {
    if (TIMESTAMP_RE.test(v)) return 'timestamp';
    if (DATETIME_RE.test(v)) return 'datetime';
    if (DATE_RE.test(v)) return 'date';
    if (TIME_RE.test(v)) return 'time';
    if (INT_RE.test(v) || FLOAT_RE.test(v)) return 'number';
    return 'string';
  }
  return 'string';
}

function gatherFields(rows: unknown[]): string[] {
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        fields.push(k);
      }
    }
  }
  return fields;
}

function anyInt64Overflow(field: string, rows: unknown[]): boolean {
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const v = row[field];
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && INT_RE.test(v)) {
      if (safeInt(v) === null) return true;
    }
  }
  return false;
}

function columnInfoFromSchema(field: SchemaField, rows: unknown[]): ColumnInfo {
  const t = (field.type ?? '').toUpperCase();
  const mode = (field.mode ?? '').toUpperCase();
  if (mode === 'REPEATED') {
    return { field: field.name, type: 'array', coerceNumeric: false };
  }
  switch (t) {
    case 'INTEGER':
    case 'INT64': {
      const overflow = anyInt64Overflow(field.name, rows);
      return overflow
        ? { field: field.name, type: 'string', coerceNumeric: false }
        : { field: field.name, type: 'number', coerceNumeric: true };
    }
    case 'NUMERIC':
    case 'BIGNUMERIC':
      // Exact decimal types. Keep BigQuery's raw string verbatim — Number()
      // coercion silently drops precision past ~17 significant digits and can
      // flip large/small values to scientific notation (DATA-1/2). The
      // 'decimal' column type displays the string as-is; sort + the
      // number-style condition filter use an exact decimal comparator, and
      // formula/conditional-format math parses to a double on demand.
      return { field: field.name, type: 'decimal', coerceNumeric: false };
    case 'FLOAT':
    case 'FLOAT64':
      return { field: field.name, type: 'number', coerceNumeric: true };
    case 'BOOLEAN':
    case 'BOOL':
      return { field: field.name, type: 'boolean', coerceNumeric: false };
    case 'TIMESTAMP':
      return { field: field.name, type: 'timestamp', coerceNumeric: false };
    case 'DATETIME':
      return { field: field.name, type: 'datetime', coerceNumeric: false };
    case 'DATE':
      return { field: field.name, type: 'date', coerceNumeric: false };
    case 'TIME':
      return { field: field.name, type: 'time', coerceNumeric: false };
    case 'BYTES':
      return { field: field.name, type: 'bytes', coerceNumeric: false };
    case 'RECORD':
    case 'STRUCT':
      return { field: field.name, type: 'struct', coerceNumeric: false };
    case 'JSON':
      return { field: field.name, type: 'json', coerceNumeric: false };
    case 'STRING':
    case 'GEOGRAPHY':
    case 'INTERVAL':
    case 'RANGE':
    default:
      return { field: field.name, type: 'string', coerceNumeric: false };
  }
}

function inferColumnInfoFromValues(field: string, rows: unknown[]): ColumnInfo {
  let firstType: ColumnType | null = null;
  let sawNonNull = false;

  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const v = row[field];
    if (v === null || v === undefined) continue;
    sawNonNull = true;
    firstType = inferValueType(v);
    break;
  }

  if (!sawNonNull || firstType === null) {
    return { field, type: 'null', coerceNumeric: false };
  }

  if (firstType === 'number') {
    return anyInt64Overflow(field, rows)
      ? { field, type: 'string', coerceNumeric: false }
      : { field, type: 'number', coerceNumeric: true };
  }

  if (firstType === 'string') {
    // JSON-as-string sniff: BigQuery JSON type round-trips as a quoted string
    // that JSON-parses to an object/array.
    for (const row of rows) {
      if (!isPlainObject(row)) continue;
      const v = row[field];
      if (v === null || v === undefined) continue;
      if (typeof v === 'string') {
        const parsed = maybeParseJsonString(v);
        if (
          parsed !== undefined &&
          (Array.isArray(parsed) || isPlainObject(parsed))
        ) {
          return { field, type: 'json', coerceNumeric: false };
        }
      }
      break;
    }
    // Name heuristic for BYTES (only used when schema is absent).
    if (/(_bytes$|_hash$|bytes)/i.test(field)) {
      return { field, type: 'bytes', coerceNumeric: false };
    }
    return { field, type: 'string', coerceNumeric: false };
  }

  return { field, type: firstType, coerceNumeric: false };
}

function coerceValue(raw: unknown, info: ColumnInfo): unknown {
  if (raw === null || raw === undefined) return null;
  switch (info.type) {
    case 'number':
      if (info.coerceNumeric && typeof raw === 'string') {
        if (INT_RE.test(raw)) {
          const n = safeInt(raw);
          return n !== null ? n : raw;
        }
        if (FLOAT_RE.test(raw)) {
          return Number(raw);
        }
        return raw;
      }
      return raw;
    case 'json':
      if (typeof raw === 'string') {
        const parsed = maybeParseJsonString(raw);
        return parsed !== undefined ? parsed : raw;
      }
      return raw;
    // DATE / DATETIME / TIMESTAMP / TIME: keep the raw BigQuery string as-is.
    // Coercing to a JS Date loses microsecond precision and the original
    // formatting (UTC suffix, space-vs-T separator, etc.) — the renderer
    // displays this string verbatim, and sort/filter/formula code parses
    // on demand. See session-notes/timestamp-fidelity-patch-notes.md.
    // NUMERIC / BIGNUMERIC: keep the raw BigQuery string verbatim (see
    // columnInfoFromSchema). Coercing to a JS number would lose precision.
    case 'decimal':
    case 'date':
    case 'datetime':
    case 'timestamp':
    case 'time':
    case 'struct':
    case 'array':
    case 'boolean':
    case 'string':
    case 'bytes':
    case 'null':
    default:
      return raw;
  }
}

export function parseJson(
  jsonText: string,
  schema?: SchemaField[],
): ParsedJson {
  const trimmed = jsonText.trim();
  if (!trimmed) {
    return { columns: [], rows: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    throw new Error(
      `bq returned non-JSON output. First 200 chars: ${trimmed.slice(0, 200)}`,
    );
  }
  if (!Array.isArray(raw)) {
    raw = [raw];
  }
  const rawRows = raw as unknown[];

  const useSchema = Array.isArray(schema) && schema.length > 0;
  const columnInfos: ColumnInfo[] = useSchema
    ? schema!.map((f) => columnInfoFromSchema(f, rawRows))
    : gatherFields(rawRows).map((f) => inferColumnInfoFromValues(f, rawRows));

  const rows: ParsedRow[] = rawRows.map((row) => {
    const out: ParsedRow = {};
    if (!isPlainObject(row)) return out;
    for (const ci of columnInfos) {
      out[ci.field] = coerceValue(row[ci.field], ci);
    }
    return out;
  });

  const columns: ParsedColumn[] = columnInfos.map((ci) => ({
    field: ci.field,
    type: ci.type,
  }));

  return { columns, rows };
}

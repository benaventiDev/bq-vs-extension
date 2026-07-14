import type { ColumnType, ParsedColumn, ParsedRow } from '../bq/parseJson';

export interface ExplodedResult {
  columns: ParsedColumn[];
  rows: ParsedRow[];
}

const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?\d+\.\d+(?:[eE][+-]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?( ?UTC| ?Z| ?[+-]\d{2}:?\d{2})?$/;

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

// Walk a struct/json object recursively, emitting dotted keys at leaves.
// Stops at arrays — they remain as opaque leaf values (rendered later via the
// nested-cell preview path). Matches the inline-mode `flattenStruct` shape so
// the dotted column names are familiar to users switching between modes.
function flattenDotted(
  value: Record<string, unknown>,
  prefix: string,
  out: Map<string, unknown>,
): void {
  for (const [k, v] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) {
      flattenDotted(v, full, out);
    } else {
      out.set(full, v);
    }
  }
}

function discoverStructKeys(rows: ParsedRow[], field: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const row of rows) {
    const v = row[field];
    if (!isPlainObject(v)) continue;
    const tmp = new Map<string, unknown>();
    flattenDotted(v, field, tmp);
    for (const k of tmp.keys()) {
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
  }
  return order;
}

function discoverArrayStructKeys(rows: ParsedRow[], field: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const row of rows) {
    const arr = row[field];
    if (!Array.isArray(arr)) continue;
    for (const elem of arr) {
      if (!isPlainObject(elem)) continue;
      const tmp = new Map<string, unknown>();
      flattenDotted(elem, field, tmp);
      for (const k of tmp.keys()) {
        if (!seen.has(k)) {
          seen.add(k);
          order.push(k);
        }
      }
    }
  }
  return order;
}

type ArrayShape = 'objects' | 'scalars' | 'empty-or-mixed';

function detectArrayShape(rows: ParsedRow[], field: string): ArrayShape {
  let sawObj = false;
  let sawScalar = false;
  for (const row of rows) {
    const arr = row[field];
    if (!Array.isArray(arr)) continue;
    for (const elem of arr) {
      if (isPlainObject(elem)) sawObj = true;
      else sawScalar = true;
    }
  }
  if (sawObj && !sawScalar) return 'objects';
  if (sawScalar && !sawObj) return 'scalars';
  return 'empty-or-mixed';
}

function jsonHasObjects(rows: ParsedRow[], field: string): boolean {
  for (const row of rows) {
    if (isPlainObject(row[field])) return true;
  }
  return false;
}

function inferLeafType(v: unknown): ColumnType {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (v instanceof Date) return 'datetime';
  if (Array.isArray(v)) return 'array';
  if (isPlainObject(v)) return 'struct';
  if (typeof v === 'string') {
    if (INT_RE.test(v) || FLOAT_RE.test(v)) return 'number';
    if (TIMESTAMP_RE.test(v)) return 'timestamp';
    if (DATETIME_RE.test(v)) return 'datetime';
    if (DATE_RE.test(v)) return 'date';
    return 'string';
  }
  return 'string';
}

function coerceValueForType(raw: unknown, type: ColumnType): unknown {
  if (raw === null || raw === undefined) return null;
  if (type === 'number' && typeof raw === 'string') {
    if (INT_RE.test(raw)) {
      const n = safeInt(raw);
      return n !== null ? n : raw;
    }
    if (FLOAT_RE.test(raw)) return Number(raw);
    return raw;
  }
  if ((type === 'date' || type === 'datetime') && typeof raw === 'string') {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return raw;
}

type ColPlan =
  | { kind: 'scalar'; col: ParsedColumn }
  | { kind: 'flatten'; col: ParsedColumn; keys: string[] }
  | { kind: 'keep-nested'; col: ParsedColumn }
  | { kind: 'explode-struct'; col: ParsedColumn; keys: string[] }
  | { kind: 'explode-scalar'; col: ParsedColumn };

// Build per-column plan. Plans drive both column-list generation and per-row
// emission so the two stay in lockstep.
function buildPlans(columns: ParsedColumn[], rows: ParsedRow[]): ColPlan[] {
  const firstArrayIdx = columns.findIndex((c) => c.type === 'array');

  return columns.map((col, idx) => {
    if (col.type === 'struct') {
      const keys = discoverStructKeys(rows, col.field);
      return keys.length > 0
        ? { kind: 'flatten' as const, col, keys }
        : { kind: 'keep-nested' as const, col };
    }
    if (col.type === 'json') {
      // Non-object JSON (scalar / array-at-root) → keep as scalar nested cell.
      // Mixed shapes still flatten by union of object-keyed rows; non-object
      // rows just emit nulls for those dotted columns.
      if (!jsonHasObjects(rows, col.field)) {
        return { kind: 'keep-nested' as const, col };
      }
      const keys = discoverStructKeys(rows, col.field);
      return keys.length > 0
        ? { kind: 'flatten' as const, col, keys }
        : { kind: 'keep-nested' as const, col };
    }
    if (col.type === 'array' && idx === firstArrayIdx) {
      const shape = detectArrayShape(rows, col.field);
      if (shape === 'objects') {
        return {
          kind: 'explode-struct' as const,
          col,
          keys: discoverArrayStructKeys(rows, col.field),
        };
      }
      if (shape === 'scalars') {
        return { kind: 'explode-scalar' as const, col };
      }
      // Always-empty or mixed → render as scalar nested cell (shows `[]`).
      return { kind: 'keep-nested' as const, col };
    }
    if (col.type === 'array' || col.type === 'bytes') {
      return { kind: 'keep-nested' as const, col };
    }
    return { kind: 'scalar' as const, col };
  });
}

function inferDottedColType(
  rows: ParsedRow[],
  origField: string,
  dottedKey: string,
): ColumnType {
  for (const row of rows) {
    const root = row[origField];
    if (!isPlainObject(root)) continue;
    const m = new Map<string, unknown>();
    flattenDotted(root, origField, m);
    const v = m.get(dottedKey);
    if (v === null || v === undefined) continue;
    return inferLeafType(v);
  }
  return 'null';
}

function inferExplodedArrayColType(
  rows: ParsedRow[],
  origField: string,
  dottedKey: string,
): ColumnType {
  for (const row of rows) {
    const arr = row[origField];
    if (!Array.isArray(arr)) continue;
    for (const elem of arr) {
      if (!isPlainObject(elem)) continue;
      const m = new Map<string, unknown>();
      flattenDotted(elem, origField, m);
      const v = m.get(dottedKey);
      if (v === null || v === undefined) continue;
      return inferLeafType(v);
    }
  }
  return 'null';
}

function inferArrayElementType(
  rows: ParsedRow[],
  field: string,
): ColumnType {
  for (const row of rows) {
    const arr = row[field];
    if (!Array.isArray(arr)) continue;
    for (const elem of arr) {
      if (elem === null || elem === undefined) continue;
      return inferLeafType(elem);
    }
  }
  return 'null';
}

// Pre-process result data for explode mode:
//   - STRUCT / object-JSON columns flatten to dotted top-level columns
//   - First ARRAY column drives row explosion (1 sub-row per element)
//   - Remaining ARRAY + BYTES columns stay as nested cells (rendered inline)
//   - Parent scalars / nested cells repeat only on the first sub-row of each
//     source row; subsequent sub-rows get nulls so the eye doesn't read
//     duplicate parent values
//   - NULL / empty exploding-array → ONE sub-row with array sub-columns null
//
// Pure: no DOM access, no globals. Same inputs → same outputs.
export function explodeRows(
  columns: ParsedColumn[],
  rows: ParsedRow[],
): ExplodedResult {
  const plans = buildPlans(columns, rows);

  const outCols: ParsedColumn[] = [];
  for (const p of plans) {
    if (p.kind === 'scalar' || p.kind === 'keep-nested') {
      outCols.push(p.col);
    } else if (p.kind === 'flatten') {
      for (const key of p.keys) {
        outCols.push({ field: key, type: inferDottedColType(rows, p.col.field, key) });
      }
    } else if (p.kind === 'explode-struct') {
      for (const key of p.keys) {
        outCols.push({
          field: key,
          type: inferExplodedArrayColType(rows, p.col.field, key),
        });
      }
    } else if (p.kind === 'explode-scalar') {
      outCols.push({
        field: p.col.field,
        type: inferArrayElementType(rows, p.col.field),
      });
    }
  }

  // Snapshot column types so we coerce values once per output column.
  const colTypeByField = new Map<string, ColumnType>(
    outCols.map((c) => [c.field, c.type]),
  );

  const explodePlan = plans.find(
    (p): p is Extract<ColPlan, { kind: 'explode-struct' | 'explode-scalar' }> =>
      p.kind === 'explode-struct' || p.kind === 'explode-scalar',
  );

  const outRows: ParsedRow[] = [];

  for (const row of rows) {
    let elements: unknown[];
    if (explodePlan) {
      const v = row[explodePlan.col.field];
      // null / empty array still produces ONE row so the parent data isn't lost.
      // Use a single `undefined` element as the sentinel for "no element here".
      elements = Array.isArray(v) && v.length > 0 ? v : [undefined];
    } else {
      elements = [undefined];
    }

    for (let i = 0; i < elements.length; i++) {
      const isFirst = i === 0;
      const out: ParsedRow = {};

      for (const p of plans) {
        if (p.kind === 'scalar' || p.kind === 'keep-nested') {
          out[p.col.field] = isFirst ? row[p.col.field] ?? null : null;
          continue;
        }
        if (p.kind === 'flatten') {
          const v = row[p.col.field];
          if (isFirst && isPlainObject(v)) {
            const m = new Map<string, unknown>();
            flattenDotted(v, p.col.field, m);
            for (const key of p.keys) {
              const raw = m.has(key) ? m.get(key) : null;
              out[key] = coerceValueForType(raw, colTypeByField.get(key) ?? 'string');
            }
          } else {
            for (const key of p.keys) out[key] = null;
          }
          continue;
        }
        if (p.kind === 'explode-struct') {
          const elem = elements[i];
          if (isPlainObject(elem)) {
            const m = new Map<string, unknown>();
            flattenDotted(elem, p.col.field, m);
            for (const key of p.keys) {
              const raw = m.has(key) ? m.get(key) : null;
              out[key] = coerceValueForType(raw, colTypeByField.get(key) ?? 'string');
            }
          } else {
            for (const key of p.keys) out[key] = null;
          }
          continue;
        }
        // explode-scalar
        const elem = elements[i];
        out[p.col.field] =
          elem === undefined
            ? null
            : coerceValueForType(elem, colTypeByField.get(p.col.field) ?? 'string');
      }

      outRows.push(out);
    }
  }

  return { columns: outCols, rows: outRows };
}

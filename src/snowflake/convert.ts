import type { ColumnType, ParsedColumn, ParsedRow } from '../bq/parseJson';

// Converts snowflake-sdk result values into the grid's engine-agnostic
// ParsedColumn / ParsedRow shape. Same fidelity rules as the BigQuery path:
//   - exact numbers stay exact (NUMBER with scale, or integers past 2^53,
//     are kept as their decimal string → 'decimal' column)
//   - temporal values keep every fractional digit the column's scale carries
//     and their offset, formatted the way Snowflake prints them
//   - semi-structured values (VARIANT / OBJECT / ARRAY) become real JS
//     objects/arrays so the struct / array / JSON viewers work, with big
//     integers inside them preserved as strings where the runtime allows
//
// The SDK is configured (see client.ts) with fetchAsString: ['Number',
// 'JSON'] and rowMode 'array', and TIME values come pre-formatted at full
// precision (see the toSfTime patch in client.ts).

/** Column metadata as exposed by the SDK's Column objects. */
export interface SfColumnMeta {
  name: string;
  /** Lower-case SDK type: fixed, real, text, binary, boolean, date, time,
   *  timestamp_ntz/ltz/tz, variant, object, array, map, vector, ... */
  type: string;
  scale: number | null;
}

/** The subset of the SDK's SfDate we use. */
interface SfDateLike {
  getEpochSeconds(): number;
  getNanoSeconds(): number;
  getScale(): number;
  getTimezone(): unknown;
}

function isSfDate(v: unknown): v is SfDateLike {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as SfDateLike).getEpochSeconds === 'function' &&
    typeof (v as SfDateLike).getNanoSeconds === 'function'
  );
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

function fraction(nanos: number, scale: number): string {
  if (!scale || scale <= 0) return '';
  const s = Math.min(9, scale);
  return '.' + pad(nanos, 9).slice(0, s);
}

/** Wall-clock parts for an epoch-seconds value shifted by `offsetMinutes`. */
function wallClock(epochSeconds: number, offsetMinutes: number): string {
  const d = new Date((epochSeconds + offsetMinutes * 60) * 1000);
  const y = d.getUTCFullYear();
  const year = y < 0 ? '-' + pad(-y, 4) : pad(y, 4);
  return (
    `${year}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const m = Math.abs(minutes);
  return `${sign}${pad(Math.floor(m / 60))}${pad(m % 60)}`;
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** Offset (minutes east of UTC) of an IANA zone at a given instant. */
export function zoneOffsetMinutes(zone: string, epochSeconds: number): number {
  if (!zone || /^(utc|gmt|z)$/i.test(zone)) return 0;
  let fmt = offsetFormatters.get(zone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch {
      return 0;
    }
    offsetFormatters.set(zone, fmt);
  }
  const ms = epochSeconds * 1000;
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - ms) / 60000);
}

export function formatDate(v: SfDateLike): string {
  return wallClock(v.getEpochSeconds(), 0).slice(0, 10);
}

export function formatTimestampNtz(v: SfDateLike, scale: number): string {
  return wallClock(v.getEpochSeconds(), 0) + fraction(v.getNanoSeconds(), scale);
}

export function formatTimestampWithZone(v: SfDateLike, scale: number): string {
  const tz = v.getTimezone();
  const epoch = v.getEpochSeconds();
  let offset = 0;
  if (typeof tz === 'number') offset = tz;
  else if (typeof tz === 'string') offset = zoneOffsetMinutes(tz, epoch);
  else if (tz && typeof (tz as { name?: unknown }).name === 'string') {
    offset = zoneOffsetMinutes((tz as { name: string }).name, epoch);
  }
  return `${wallClock(epoch, offset)}${fraction(v.getNanoSeconds(), scale)} ${formatOffset(offset)}`;
}

/** HH:MM:SS[.fraction] from seconds-since-midnight + nanos. */
export function formatTime(midnightSeconds: number, nanos: number, scale: number): string {
  const s = Math.floor(midnightSeconds);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}${fraction(nanos, scale)}`;
}

const INT_RE = /^-?\d+$/;

function isSafeIntString(s: string): boolean {
  if (!INT_RE.test(s)) return false;
  const n = Number(s);
  return Number.isSafeInteger(n);
}

/**
 * JSON.parse that keeps integers beyond 2^53 (and long decimals) as their
 * exact source text. Uses the reviver `context.source` (V8 ≥ 11.4); older
 * runtimes silently fall back to plain numbers.
 */
export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, function (this: unknown, _key: string, value: unknown, ctx?: { source?: string }) {
    if (typeof value === 'number' && ctx && typeof ctx.source === 'string') {
      const src = ctx.source;
      const significant = src.replace(/^-/, '').replace(/[eE].*$/, '').replace('.', '').replace(/^0+/, '');
      if (INT_RE.test(src) ? !Number.isSafeInteger(value) : significant.length > 15) return src;
    }
    return value;
  } as (key: string, value: unknown) => unknown);
}

/**
 * Snowflake prints SQL NULL elements of an ARRAY as a bare `undefined`
 * (`["a", undefined, "c"]`), which isn't JSON. Turn those into null, leaving
 * string contents alone.
 */
function undefinedToNull(text: string): string {
  if (!text.includes('undefined')) return text;
  return text.replace(/("(?:[^"\\]|\\.)*")|\bundefined\b/g, (_m, str: string | undefined) => (str !== undefined ? str : 'null'));
}

/** Deep-replace `undefined` (SDK-parsed arrays with NULL elements) by null. */
function normalizeUndefined(v: unknown): unknown {
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.map(normalizeUndefined);
  if (typeof v === 'object' && v !== null && !(v instanceof Date) && !(v instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = normalizeUndefined(val);
    return out;
  }
  return v;
}

function semiStructured(v: unknown): unknown {
  if (typeof v === 'string') {
    try {
      return parseJsonExact(undefinedToNull(v));
    } catch {
      return v;
    }
  }
  return normalizeUndefined(v);
}

function realValue(v: unknown): unknown {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return v;
  const lower = v.toLowerCase();
  if (lower === 'nan') return 'NaN';
  if (lower === 'inf' || lower === 'infinity') return 'Infinity';
  if (lower === '-inf' || lower === '-infinity') return '-Infinity';
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

function bytesValue(v: unknown): unknown {
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  return v;
}

interface Converter {
  type: ColumnType;
  convert: (v: unknown) => unknown;
}

function converterFor(col: SfColumnMeta, values: unknown[]): Converter {
  const scale = col.scale ?? 0;
  switch (col.type) {
    case 'fixed': {
      if (scale > 0) return { type: 'decimal', convert: (v) => (v === null ? null : String(v)) };
      const allSafe = values.every((v) => v === null || v === undefined || typeof v === 'number' || isSafeIntString(String(v)));
      return allSafe
        ? { type: 'number', convert: (v) => (v === null ? null : typeof v === 'number' ? v : Number(v)) }
        : { type: 'decimal', convert: (v) => (v === null ? null : String(v)) };
    }
    case 'decfloat':
      return { type: 'decimal', convert: (v) => (v === null ? null : String(v)) };
    case 'real':
      return { type: 'number', convert: realValue };
    case 'boolean':
      return { type: 'boolean', convert: (v) => v };
    case 'binary':
      return { type: 'bytes', convert: bytesValue };
    case 'date':
      return { type: 'date', convert: (v) => (isSfDate(v) ? formatDate(v) : v) };
    case 'time':
      return { type: 'time', convert: (v) => v };
    case 'timestamp_ntz':
      return { type: 'datetime', convert: (v) => (isSfDate(v) ? formatTimestampNtz(v, scale) : v) };
    case 'timestamp_ltz':
    case 'timestamp_tz':
      return { type: 'timestamp', convert: (v) => (isSfDate(v) ? formatTimestampWithZone(v, scale) : v) };
    case 'variant':
      return { type: 'json', convert: semiStructured };
    case 'object':
    case 'map':
      return { type: 'struct', convert: semiStructured };
    case 'array':
    case 'vector':
      return { type: 'array', convert: semiStructured };
    case 'text':
    default:
      return { type: 'string', convert: (v) => v };
  }
}

/** Unique field names: Snowflake allows `select 1 a, 2 a`; the grid keys rows by name. */
export function uniqueFieldNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  const taken = new Set(names);
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) return name;
    let n = count + 1;
    let candidate = `${name}_${n}`;
    while (taken.has(candidate)) candidate = `${name}_${++n}`;
    taken.add(candidate);
    return candidate;
  });
}

/** Convert one result set (rows in SDK array mode). */
export function convertResult(
  columns: SfColumnMeta[],
  rawRows: unknown[][],
): { columns: ParsedColumn[]; rows: ParsedRow[] } {
  const fields = uniqueFieldNames(columns.map((c) => c.name));
  const converters = columns.map((c, i) => converterFor(c, rawRows.map((r) => r[i])));
  const rows: ParsedRow[] = rawRows.map((raw) => {
    const out: ParsedRow = {};
    for (let i = 0; i < fields.length; i++) {
      const v = raw[i];
      out[fields[i]] = v === null || v === undefined ? null : converters[i].convert(v);
    }
    return out;
  });
  return {
    columns: fields.map((field, i) => ({ field, type: converters[i].type })),
    rows,
  };
}

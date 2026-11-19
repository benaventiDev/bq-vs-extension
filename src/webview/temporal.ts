// Chronological comparator for TIMESTAMP cells. BigQuery values are all UTC
// so plain string order is already chronological, but Snowflake TIMESTAMP_TZ
// / LTZ values carry per-row offsets ('... -0800' vs '... +0100'), where
// string order isn't. Parse to the instant (plus sub-millisecond digits for
// ties) and fall back to string order for anything unparseable.

const TS_RE = /^(-?\d{4,})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:\s?(?:UTC|Z)|\s?([+-])(\d{2}):?(\d{2}))?$/;

interface Instant {
  ms: number;
  sub: string; // fractional digits past milliseconds, right-padded
}

function parseInstant(s: string): Instant | null {
  const m = TS_RE.exec(s);
  if (!m) return null;
  const frac = (m[7] ?? '').padEnd(9, '0');
  const offsetMin = m[8] ? (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10])) : 0;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(frac.slice(0, 3)));
  return { ms: base - offsetMin * 60000, sub: frac.slice(3) };
}

export function compareTimestampStrings(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  const sa = String(a);
  const sb = String(b);
  const ia = parseInstant(sa);
  const ib = parseInstant(sb);
  if (ia && ib) {
    if (ia.ms !== ib.ms) return ia.ms < ib.ms ? -1 : 1;
    if (ia.sub !== ib.sub) return ia.sub < ib.sub ? -1 : 1;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

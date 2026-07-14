// Exact decimal comparison for NUMERIC / BIGNUMERIC columns.
//
// These columns are stored verbatim as the string BigQuery returns: a
// Number() coercion silently drops precision past ~17 significant digits
// (DATA-1/2 in pre-publish-bugs.md). The 'decimal' column type therefore
// displays the raw string as-is. To keep sort and the number-style condition
// filter behaving NUMERICALLY on top of a string column, we compare the
// decimal strings digit-by-digit with no float conversion — so a 38-digit
// BIGNUMERIC sorts and filters exactly.

const DECIMAL_RE = /^[+-]?\d+(?:\.\d+)?$/;

export function isDecimalString(s: string): boolean {
  return DECIMAL_RE.test(s.trim());
}

function stripLeadingZeros(s: string): string {
  const t = s.replace(/^0+/, '');
  return t === '' ? '0' : t;
}

// True for "0", "0.0", "00", "", ".0" etc. Used so "-0" is not treated as
// negative.
function isZeroMagnitude(mag: string): boolean {
  return /^0*(?:\.0*)?$/.test(mag);
}

// Compare two non-negative decimal magnitude strings. Returns -1 / 0 / 1.
function compareMagnitude(a: string, b: string): number {
  const [aiRaw, afRaw = ''] = a.split('.');
  const [biRaw, bfRaw = ''] = b.split('.');
  const ai = stripLeadingZeros(aiRaw);
  const bi = stripLeadingZeros(biRaw);
  // More integer digits = larger magnitude (both are zero-stripped).
  if (ai.length !== bi.length) return ai.length < bi.length ? -1 : 1;
  // Same number of integer digits: a plain lexical compare is correct.
  if (ai !== bi) return ai < bi ? -1 : 1;
  // Integer parts equal: compare fractions, right-padded to equal length.
  const len = Math.max(afRaw.length, bfRaw.length);
  const af = afRaw.padEnd(len, '0');
  const bf = bfRaw.padEnd(len, '0');
  if (af === bf) return 0;
  return af < bf ? -1 : 1;
}

// Compare two decimal strings exactly. Assumes both pass isDecimalString.
// Returns -1 / 0 / 1.
export function compareDec(a: string, b: string): number {
  const at = a.trim();
  const bt = b.trim();
  const aMag = at.replace(/^[+-]/, '');
  const bMag = bt.replace(/^[+-]/, '');
  const aNeg = at[0] === '-' && !isZeroMagnitude(aMag);
  const bNeg = bt[0] === '-' && !isZeroMagnitude(bMag);
  if (aNeg !== bNeg) return aNeg ? -1 : 1;
  const mag = compareMagnitude(aMag, bMag);
  return aNeg ? -mag : mag;
}

// AG Grid comparator for a 'decimal' column. Cell values are exact strings or
// null. Nulls sort last (ascending). Non-decimal stragglers fall back to a
// lexical compare so sorting never throws.
export function compareDecimalStrings(a: unknown, b: unknown): number {
  const aNull = a === null || a === undefined || a === '';
  const bNull = b === null || b === undefined || b === '';
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  const sa = String(a);
  const sb = String(b);
  if (sa === sb) return 0;
  if (isDecimalString(sa) && isDecimalString(sb)) return compareDec(sa, sb);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

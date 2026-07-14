// JSON serializer. Pretty-printed array of row objects with native nested
// types preserved (struct → object, array → array, json → unwrapped value).

import type { ParsedColumn, ParsedRow } from '../../bq/parseJson';
import { serializeForJson } from './serialize';

export function buildJson(columns: ParsedColumn[], rows: ParsedRow[]): string {
  const out = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (const c of columns) {
      obj[c.field] = serializeForJson(row[c.field], c.type);
    }
    return obj;
  });
  return JSON.stringify(out, null, 2);
}

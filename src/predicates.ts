import { isValueIndexed } from './db.js';

const KEY_RE = /^[a-zA-Z0-9_:.-]+$/;

/** Collects bind values so SQL can be assembled with $n placeholders. */
export class Params {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);

    return `$${this.values.length}`;
  }
}

/** A filter the API cannot serve; surfaces as 400 with the message. */
export class FilterError extends Error {}

/** Tag-key syntax, as far as any query parameter is concerned. */
export function isValidKey(key: string): boolean {
  return KEY_RE.test(key);
}

function assertKey(key: string): void {
  if (!isValidKey(key)) {
    throw new FilterError(`not a valid tag key: ${key}`);
  }
}

/**
 * One `f` value → one SQL condition. Predicates are comma-separated and ANDed:
 * `k=v` matches a value, `k` the key's presence, `!k` its absence. All the
 * positive ones collapse into a single `kv @> ARRAY[…]` containment test.
 */
export function clauseToSql(clause: string, params: Params): string {
  const contains: string[] = [];

  const conditions: string[] = [];

  for (const raw of clause.split(',')) {
    const predicate = raw.trim();

    if (!predicate) {
      continue;
    }

    if (predicate.startsWith('!')) {
      const key = predicate.slice(1).trim();

      assertKey(key);

      conditions.push(`NOT jsonb_exists(tags, ${params.add(key)})`);

      continue;
    }

    const eq = predicate.indexOf('=');

    if (eq < 0) {
      assertKey(predicate);

      contains.push(predicate);

      continue;
    }

    // Both halves are trimmed: `amenity = restaurant` is the natural thing for
    // a hand-written query to contain.
    const key = predicate.slice(0, eq).trim();

    const value = predicate
      .slice(eq + 1)
      .trim()
      .toLowerCase();

    assertKey(key);

    if (!value) {
      throw new FilterError(`empty value in predicate: ${predicate}`);
    }

    if (isValueIndexed(key, value)) {
      contains.push(`${key}=${value}`);
    } else {
      // Free text or an over-long value, so `kv` does not carry the pair. The
      // key still anchors the lookup on the index; the value is rechecked on
      // the rows that come back.
      contains.push(key);

      conditions.push(
        `fm_tag_matches(tags, ${params.add(key)}, ${params.add(value)})`,
      );
    }
  }

  // Without one, the condition could only be answered by a full scan.
  if (contains.length === 0) {
    throw new FilterError(
      `filter needs at least one positive predicate: ${clause}`,
    );
  }

  conditions.unshift(`kv @> ${params.add(contains)}::text[]`);

  return conditions.length === 1
    ? (conditions[0] as string)
    : `(${conditions.join(' AND ')})`;
}

/** The `f` values ORed together, or `true` when nothing was asked for. */
export function clausesToSql(clauses: string[], params: Params): string {
  if (clauses.length === 0) {
    throw new FilterError('at least one f parameter is required');
  }

  return clauses.map((clause) => clauseToSql(clause, params)).join(' OR ');
}

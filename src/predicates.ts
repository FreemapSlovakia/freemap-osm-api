import { getKeySets } from './db.js';

const KEY_RE = /^[a-zA-Z0-9_:.-]+$/;

/**
 * What `fm_kv()` in sql/post-import.sql still puts in the index — longer values
 * are free text. Rejecting them here is the difference between an explanation
 * and an empty collection nothing accounts for.
 */
const MAX_VALUE_LENGTH = 100;

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

function assertKey(key: string): void {
  if (!KEY_RE.test(key)) {
    throw new FilterError(`not a valid tag key: ${key}`);
  }
}

/**
 * One `f` value → one SQL condition. Predicates are comma-separated and ANDed:
 * `k=v` matches a value, `k` the key's presence, `!k` its absence. All the
 * positive ones collapse into a single `kv @> ARRAY[…]` containment test.
 */
export function clauseToSql(clause: string, params: Params): string {
  const { indexed, valued } = getKeySets();

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

      if (!indexed.has(predicate)) {
        throw new FilterError(`tag key is not searchable: ${predicate}`);
      }

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

    if (value.length > MAX_VALUE_LENGTH) {
      throw new FilterError(
        `tag value is longer than ${MAX_VALUE_LENGTH} characters, ` +
          `so it is not indexed: ${key}`,
      );
    }

    if (!valued.has(key)) {
      throw new FilterError(`tag values are not searchable for key: ${key}`);
    }

    contains.push(`${key}=${value}`);
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

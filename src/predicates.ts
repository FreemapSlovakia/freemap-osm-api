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

/**
 * How the generated SQL reaches the `kv` column. `KV_INDEXED` lets the GIN index
 * answer the containment test. `KV_HIDDEN` is the same value read through an
 * expression, which no index can match — concatenating the empty array changes
 * nothing about the value, and verified against 581M production rows to select
 * exactly the same set. The route picks it to keep the tag index out of a plan
 * that should lead with geometry, where offering both is what lets the planner
 * build the bitmap AND neither side wants.
 */
export const KV_INDEXED = 'kv';

export const KV_HIDDEN = "(kv || '{}'::text[])";

/** Tag-key syntax, as far as any query parameter is concerned. */
export function isValidKey(key: string): boolean {
  return KEY_RE.test(key);
}

/**
 * A comma-separated key list parameter. An explicit one that names nothing is
 * a client bug, not "no restriction", so it is a 400 like an invalid key.
 */
export function parseKeys(value: string, param: string): string[] {
  const list = value
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

  if (list.length === 0) {
    throw new FilterError(`${param} must not be empty`);
  }

  const invalid = list.filter((key) => !isValidKey(key));

  if (invalid.length > 0) {
    throw new FilterError(`not valid tag keys: ${invalid.join(', ')}`);
  }

  return list;
}

function assertKey(key: string): void {
  if (!isValidKey(key)) {
    throw new FilterError(`not a valid tag key: ${key}`);
  }
}

/**
 * One `f` value, compiled: the SQL condition, the `kv` elements it looks the
 * rows up by, and whether answering it needs `fm_tag_matches` on every one of
 * them. The caller sizes the match set from all three before running anything —
 * see `estimateTagRows`.
 */
export type Clause = {
  sql: string;
  contains: string[];
  recheck: boolean;
  /** Every key the clause mentions, negated ones included. */
  keys: string[];
};

/**
 * One `f` value → one SQL condition. Predicates are comma-separated and ANDed:
 * `k=v` matches a value, `k` the key's presence, `!k` its absence. All the
 * positive ones collapse into a single `kv @> ARRAY[…]` containment test.
 */
export function clauseToSql(
  clause: string,
  params: Params,
  kv: string = KV_INDEXED,
): Clause {
  const contains: string[] = [];

  const conditions: string[] = [];

  const keys: string[] = [];

  let recheck = false;

  for (const raw of clause.split(',')) {
    const predicate = raw.trim();

    if (!predicate) {
      continue;
    }

    if (predicate.startsWith('!')) {
      const key = predicate.slice(1).trim();

      assertKey(key);

      keys.push(key);

      conditions.push(`NOT jsonb_exists(tags, ${params.add(key)})`);

      continue;
    }

    const eq = predicate.indexOf('=');

    if (eq < 0) {
      assertKey(predicate);

      contains.push(predicate);

      keys.push(predicate);

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

    keys.push(key);

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

      recheck = true;

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

  conditions.unshift(`${kv} @> ${params.add(contains)}::text[]`);

  return {
    sql:
      conditions.length === 1
        ? (conditions[0] as string)
        : `(${conditions.join(' AND ')})`,
    contains,
    recheck,
    keys,
  };
}

/** The whole `f` filter: the ORed condition, and what each clause will cost. */
export type Filter = { sql: string; clauses: Clause[] };

/** The `f` values ORed together. */
export function clausesToSql(
  clauses: string[],
  params: Params,
  kv: string = KV_INDEXED,
): Filter {
  if (clauses.length === 0) {
    throw new FilterError('at least one f parameter is required');
  }

  const compiled = clauses.map((clause) => clauseToSql(clause, params, kv));

  return {
    sql: compiled.map(({ sql }) => sql).join(' OR '),
    clauses: compiled,
  };
}

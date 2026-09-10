import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  application_name: 'freemap-osm-api',
  max: config.PG_POOL_MAX,
  statement_timeout: config.STATEMENT_TIMEOUT,
});

// `pg` emits this when an *idle* client dies — a Postgres restart, an admin
// terminating the backend, a proxy reaping the connection. The pool drops the
// client and reconnects on its own; without a listener the EventEmitter would
// instead rethrow it as an uncaught exception and take the process down.
pool.on('error', (err) => {
  console.error('postgres pool error', err);
});

/** Runs a query returning exactly one row of one already-serialized JSON text. */
export async function queryJson(
  sql: string,
  values: unknown[],
): Promise<string> {
  const { rows } = await pool.query<{ doc: string | null }>(sql, values);

  return rows[0]?.doc ?? 'null';
}

/**
 * Which values `kv` carries, read from the database at startup so the rules
 * live in one place (fm_value_deny_patterns and fm_max_value_length in
 * sql/post-import.sql). A predicate on a value outside them is answered by a
 * recheck, not refused.
 */
type ValueIndexRules = { denied: RegExp[]; maxLength: number };

let valueIndexRules: ValueIndexRules | undefined;

/**
 * A `LIKE` pattern as a whole-string regex, with both of `LIKE`'s wildcards:
 * `%` for any run of characters, `_` for exactly one. Missing the second would
 * make `%_name` and `check_date%` deny a different set of keys here than they
 * do in `fm_kv`, and the API would then ask the index for entries it never got.
 */
function likeToRegExp(pattern: string): RegExp {
  return new RegExp(
    `^${pattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/[%_]/g, (wildcard) => (wildcard === '%' ? '.*' : '.'))}$`,
  );
}

export async function loadValueIndexRules(): Promise<void> {
  const { rows } = await pool.query<{
    deny_patterns: string[];
    max_length: number;
  }>(
    `SELECT fm_value_deny_patterns() AS deny_patterns,
            fm_max_value_length() AS max_length`,
  );

  const row = rows[0];

  if (!row) {
    throw new Error('fm_value_deny_patterns() returned nothing');
  }

  valueIndexRules = {
    denied: row.deny_patterns.map(likeToRegExp),
    maxLength: row.max_length,
  };
}

/** Whether `kv` holds this pair, or the query has to recheck the tags. */
export function isValueIndexed(key: string, value: string): boolean {
  if (!valueIndexRules) {
    throw new Error('value index rules not loaded');
  }

  return (
    value.length <= valueIndexRules.maxLength &&
    !valueIndexRules.denied.some((pattern) => pattern.test(key))
  );
}

/**
 * How often each `kv` element occurs, read from the most-common-element
 * statistics the planner itself uses. /v1/features chooses between two query
 * shapes with this, and the two are orders of magnitude apart, so a frequency
 * that merely lands in the right decade decides it — which is why this is read
 * once at startup and not tracked afterwards. How common `amenity=restaurant`
 * is relative to `building` is a property of the map, not of the minute.
 */
type TagFrequencies = {
  /** Element → the fraction of rows carrying it. */
  freqs: Map<string, number>;
  /** What Postgres assumes for an element too rare to have made the list. */
  defaultFreq: number;
  rows: number;
};

let tagFrequencies: TagFrequencies | undefined;

export async function loadTagFrequencies(): Promise<void> {
  try {
    await readTagFrequencies();
  } catch (err) {
    // Unlike the value-index rules, nothing here decides what a query *means* —
    // only which of two correct plans runs. That is not worth refusing to
    // start for, so a failure degrades to the plan the route used before it
    // weighed anything.
    tagFrequencies = undefined;

    console.warn('could not read kv element statistics', err);
  }
}

async function readTagFrequencies(): Promise<void> {
  const { rows } = await pool.query<{
    reltuples: number;
    elems: string[] | null;
    freqs: number[] | null;
  }>(`
    SELECT cls.reltuples::float8 AS reltuples,
           -- most_common_elems is anyarray: it casts to no concrete array type
           -- and cannot be subscripted, but its own text form parses as text[].
           st.most_common_elems::text::text[] AS elems,
           st.most_common_elem_freqs::float8[] AS freqs
    FROM pg_class cls
    JOIN pg_namespace ns ON ns.oid = cls.relnamespace
    LEFT JOIN pg_stats st ON st.schemaname = ns.nspname
                         AND st.tablename = cls.relname
                         AND st.attname = 'kv'
    WHERE cls.oid = 'osm_object'::regclass
  `);

  const row = rows[0];

  // Nothing has been ANALYZEd yet. Not fatal: estimateTagRows then answers
  // Infinity, and every filter takes the plan the route used before there was
  // anything to choose with.
  if (!row?.elems || !row.freqs || row.reltuples <= 0) {
    tagFrequencies = undefined;

    console.warn('no kv element statistics; run ANALYZE osm_object');

    return;
  }

  const { elems, freqs } = row;

  // The frequency array holds one entry per listed element and then three more:
  // the smallest of those frequencies, the largest, and how often the array is
  // null. Postgres always appends all three, so anything shorter is not the
  // shape this reads — and guessing at it is the one mistake worth avoiding
  // here, since a frequency that came out too low reads as a rare tag and sends
  // the route down the branch that walks the whole match set.
  if (freqs.length < elems.length + 3) {
    tagFrequencies = undefined;

    console.warn('unexpected kv element statistics; ignoring them');

    return;
  }

  // The smallest is the ceiling for everything that did not make the list.
  const minFreq = freqs[elems.length] as number;

  tagFrequencies = {
    // The fallback is unreachable after the length check above, and is `1`
    // rather than `0` so that even an impossible read errs towards "common".
    freqs: new Map(elems.map((elem, index) => [elem, freqs[index] ?? 1])),
    defaultFreq: minFreq / 2,
    rows: row.reltuples,
  };
}

/** Rows in `osm_object`, as the last ANALYZE counted them. */
export function tableRows(): number | undefined {
  return tagFrequencies?.rows;
}

/**
 * How many rows the viewport holds, which is the other half of the choice
 * /v1/features makes — a filter only leads if it is more selective than the box
 * being asked about. PostGIS answers it from the N-D histogram behind its own
 * planner estimates, and answers it well: on the Slovakia extract, 1.76M
 * against 1.75M actual for a box over central Europe, 44.6k against 46.2k for a
 * city one. The cost tracks the box — 0.2 ms for a viewport, 20 ms for a
 * continent, which is the same histogram walk the planner would do anyway on
 * the branch this may choose.
 *
 * Answers 0 — "let the geometry index lead", which is what the route did before
 * there was anything to weigh — if the estimate cannot be had.
 */
let viewportEstimates = true;

export async function estimateViewportRows(
  bbox: readonly [number, number, number, number],
): Promise<number> {
  if (!tagFrequencies || !viewportEstimates) {
    return 0;
  }

  try {
    const { rows } = await pool.query<{ selectivity: number | null }>(
      `SELECT _postgis_selectivity('osm_object', 'geom',
         ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, 4326), 3857))
         AS selectivity`,
      [...bbox],
    );

    const selectivity = rows[0]?.selectivity;

    return typeof selectivity === 'number' && selectivity > 0
      ? selectivity * tagFrequencies.rows
      : 0;
  } catch (err) {
    // The name is PostGIS-internal, so a release that renames it must not take
    // the route down with it — and must not be asked again on every request.
    if ((err as { code?: string }).code === '42883') {
      viewportEstimates = false;

      console.warn(
        '_postgis_selectivity is unavailable; ' +
          '/v1/features will always lead with the geometry index',
      );
    } else {
      console.warn('viewport estimate failed', err);
    }

    return 0;
  }
}

/**
 * How many rows a clause's `kv @> ARRAY[…]` is expected to match. A row has to
 * carry every element, so the rarest one bounds the result: its frequency is
 * the answer rather than the product of them all. That overestimates a clause
 * naming several tags, which is the safe direction — the caller's threshold
 * guards against a match set too large to walk, and an overestimate keeps it on
 * the shape that copes with one.
 */
export function estimateTagRows(elements: string[]): number {
  if (!tagFrequencies) {
    return Number.POSITIVE_INFINITY;
  }

  const { freqs, defaultFreq, rows } = tagFrequencies;

  let selectivity = 1;

  for (const element of elements) {
    selectivity = Math.min(selectivity, freqs.get(element) ?? defaultFreq);
  }

  return selectivity * rows;
}

type Status = {
  dataTimestamp: string | null;
  importTimestamp: string | null;
  coverage: [number, number, number, number] | null;
};

let status: { value: Status; at: number } | undefined;

let pendingStatus: Promise<Status> | undefined;

const STATUS_TTL_MS = 30_000;

/**
 * Data freshness and coverage. `current_timestamp` is what osm2pgsql's
 * replication run last applied; the coverage box is a planner estimate, so it
 * needs no scan but is only as good as the last ANALYZE.
 */
export async function getStatus(): Promise<Status> {
  if (status && Date.now() - status.at < STATUS_TTL_MS) {
    return status.value;
  }

  // Every response asks for this through the onSend hook, so the in-flight
  // query is shared: otherwise each expiry would put one status query per
  // concurrent request into a pool the routes are queueing for too.
  pendingStatus ??= queryStatus().finally(() => {
    pendingStatus = undefined;
  });

  return pendingStatus;
}

async function queryStatus(): Promise<Status> {
  const { rows } = await pool.query<{
    data_timestamp: string | null;
    import_timestamp: string | null;
    coverage: [number, number, number, number] | null;
  }>(`
    SELECT
      (SELECT value FROM osm2pgsql_properties
        WHERE property = 'current_timestamp') AS data_timestamp,
      (SELECT value FROM osm2pgsql_properties
        WHERE property = 'import_timestamp') AS import_timestamp,
      (SELECT json_build_array(
          ST_XMin(e), ST_YMin(e), ST_XMax(e), ST_YMax(e))
        FROM (
          SELECT ST_Transform(ST_SetSRID(
            ST_EstimatedExtent('osm_object', 'geom')::geometry, 3857), 4326) AS e
        ) AS s
        WHERE e IS NOT NULL) AS coverage
  `);

  const row = rows[0];

  status = {
    at: Date.now(),
    value: {
      dataTimestamp: row?.data_timestamp ?? null,
      importTimestamp: row?.import_timestamp ?? null,
      coverage: row?.coverage ?? null,
    },
  };

  return status.value;
}

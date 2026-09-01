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
 * live in one place (fm_value_index_rules in sql/post-import.sql). A predicate
 * on a value outside them is answered by a recheck, not refused.
 */
export type ValueIndexRules = { denied: RegExp[]; maxLength: number };

let valueIndexRules: ValueIndexRules | undefined;

/** A `LIKE` pattern as a whole-string regex; only `%` is a wildcard here. */
function likeToRegExp(pattern: string): RegExp {
  return new RegExp(
    `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('%', '.*')}$`,
  );
}

export async function loadValueIndexRules(): Promise<ValueIndexRules> {
  const { rows } = await pool.query<{
    deny_patterns: string[];
    max_length: number;
  }>('SELECT * FROM fm_value_index_rules()');

  const row = rows[0];

  if (!row) {
    throw new Error('fm_value_index_rules() returned nothing');
  }

  valueIndexRules = {
    denied: row.deny_patterns.map(likeToRegExp),
    maxLength: row.max_length,
  };

  return valueIndexRules;
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

/**
 * A GeoJSON Feature built in the database, so a response never becomes
 * JavaScript objects on the way out. Expects the row source to be aliased `f`.
 * `extra` adds foreign members (distance, area). `properties` is the SQL
 * expression the tags come from — all of them unless the caller narrowed it,
 * see `pickedTags`. `withBbox` false drops the whole geometry's `bbox`: a
 * client that only pins the label point has no use for it, and it is a
 * quarter of the answer and an `ST_Transform(ST_Envelope())` a row.
 */
export function featureJson(
  extra = '',
  properties = 'f.tags',
  withBbox = true,
): string {
  return `json_build_object(
    'type', 'Feature',
    'id', CASE f.osm_type
            WHEN 'N' THEN 'node/' WHEN 'W' THEN 'way/' ELSE 'relation/'
          END || f.osm_id,${withBbox ? "\n    'bbox', fm_bbox(f.geom)," : ''}
    'geometry', ST_AsGeoJSON(ST_Transform(fm_point(f.geom), 4326), 6)::json,
    'properties', ${properties}${extra}
  )`;
}

/**
 * Only the tags whose keys are in the bound `text[]` at `keysParam`, as an
 * object — a key the object lacks is absent, `{}` when it has none of them,
 * so `properties` keeps its shape.
 *
 * Walks the requested keys and looks each up, rather than unpacking every tag
 * of the row and filtering: the list is a few keys, the row can carry dozens.
 * What that costs against the query that found the rows is not measured yet;
 * the point of the pick is the wire — see the README — not the database.
 */
export function pickedTags(keysParam: string): string {
  return `(
    SELECT coalesce(jsonb_object_agg(k.key, f.tags ->> k.key), '{}'::jsonb)
    FROM unnest(${keysParam}::text[]) AS k(key)
    WHERE jsonb_exists(f.tags, k.key)
  )`;
}

/**
 * Like `featureJson`, but carrying the object's own geometry rather than the
 * label point — what a caller naming an element by id is asking for, since it
 * draws the thing rather than pinning it.
 */
export function fullFeatureJson(): string {
  return `json_build_object(
    'type', 'Feature',
    'id', CASE f.osm_type
            WHEN 'N' THEN 'node/' WHEN 'W' THEN 'way/' ELSE 'relation/'
          END || f.osm_id,
    'bbox', fm_bbox(f.geom),
    'geometry', ST_AsGeoJSON(ST_Transform(f.geom, 4326), 6)::json,
    'properties', f.tags
  )`;
}

/** Meters per EPSG:3857 unit at this latitude — the Mercator scale factor. */
export function metersPerUnit(lat: number): number {
  return Math.cos((lat * Math.PI) / 180);
}

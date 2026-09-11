/**
 * A GeoJSON Feature built in the database, so a response never becomes
 * JavaScript objects on the way out. Expects the row source to be aliased `f`.
 * `extra` adds foreign members (distance, area). `properties` is the SQL
 * expression the tags come from — all of them unless the caller narrowed it,
 * see `pickedTags`.
 */
export function featureJson(extra = '', properties = 'f.tags'): string {
  return `json_build_object(
    'type', 'Feature',
    'id', CASE f.osm_type
            WHEN 'N' THEN 'node/' WHEN 'W' THEN 'way/' ELSE 'relation/'
          END || f.osm_id,
    'bbox', fm_bbox(f.geom),
    'geometry', ST_AsGeoJSON(ST_Transform(fm_point(f.geom), 4326), 6)::json,
    'properties', ${properties}${extra}
  )`;
}

/**
 * Only the tags whose keys are in the bound `text[]` at `keysParam`, as an
 * object — `{}` when none of them is set, so `properties` keeps its shape.
 *
 * A viewport of 2000 objects with every tag is ~350 kB of JSON before gzip
 * (addresses, opening hours, contacts, wikidata…), and a client that draws
 * pins reads two of them. Picking in the database is what keeps that off the
 * wire and out of the client's parser; the query itself is not touched.
 */
export function pickedTags(keysParam: string): string {
  return `(
    SELECT coalesce(jsonb_object_agg(t.key, t.value), '{}'::jsonb)
    FROM jsonb_each_text(f.tags) AS t
    WHERE t.key = ANY(${keysParam}::text[])
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

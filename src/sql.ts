/**
 * A GeoJSON Feature built in the database, so a response never becomes
 * JavaScript objects on the way out. Expects the row source to be aliased `f`.
 * `extra` adds foreign members (distance, area). `properties` narrows the tags,
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
 * The tags whose keys are in the bound `text[]` at `keysParam`; `{}` when the
 * object has none. Looks the requested keys up rather than unpacking every tag
 * of the row: the list is short, the row can carry dozens.
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

/**
 * A GeoJSON Feature built in the database, so a response never becomes
 * JavaScript objects on the way out. Expects the row source to be aliased `f`.
 * `extra` adds foreign members (distance, area).
 */
export function featureJson(extra = ''): string {
  return `json_build_object(
    'type', 'Feature',
    'id', CASE f.osm_type
            WHEN 'N' THEN 'node/' WHEN 'W' THEN 'way/' ELSE 'relation/'
          END || f.osm_id,
    'bbox', fm_bbox(f.geom),
    'geometry', ST_AsGeoJSON(ST_Transform(fm_point(f.geom), 4326), 6)::json,
    'properties', f.tags${extra}
  )`;
}

/** Meters per EPSG:3857 unit at this latitude — the Mercator scale factor. */
export function metersPerUnit(lat: number): number {
  return Math.cos((lat * Math.PI) / 180);
}

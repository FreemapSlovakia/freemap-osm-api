-- Run once against a freshly imported (osm2pgsql --create) database, before
-- switching on replication. `ADD COLUMN … GENERATED` rewrites the table, so it
-- has to happen while nothing else is writing.

-- The keys the API can filter on. Union of the objects tool's category tree
-- (src/osm/osmTagToNameMapping-en.messages.ts in freemap-v3-react), the keys
-- the map-details click query asks for, and the tags the outdoor map's
-- /legend endpoint emits. The API reads this list at startup and rejects
-- filters on anything outside it, so it is the one place to widen.
CREATE OR REPLACE FUNCTION fm_indexed_keys() RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT ARRAY[
    'abandoned', 'abandoned:building', 'access', 'admin_level', 'aerialway',
    'aeroway', 'amenity', 'artwork_type', 'attraction', 'barrier', 'bicycle',
    'border', 'boundary', 'bridge', 'building', 'club', 'covered', 'craft',
    'denotation', 'disused', 'disused:building', 'drinking_water', 'emergency',
    'entrance', 'fireplace', 'fixme', 'foot', 'ford', 'generator:source',
    'healthcare', 'highway', 'historic', 'information', 'intermittent',
    'junction', 'landuse', 'leisure', 'location', 'lock', 'man_made',
    'military', 'motor_vehicle', 'mountain_pass', 'natural', 'network',
    'obstacle', 'office', 'oneway', 'place', 'plant:source', 'power',
    'protect_class', 'protected', 'public_transport', 'railway', 'refitted',
    'route', 'ruins', 'ruins:building', 'sauna', 'seasonal', 'service',
    'shelter_type', 'shop', 'social_facility', 'sport', 'tourism',
    'tower:type', 'tracktype', 'trail_visibility', 'tunnel', 'type', 'vehicle',
    'vending', 'water', 'water_characteristic', 'waterway', 'wetland'
  ]
$$;

-- Keys whose *values* are indexed too. `fixme` is free text, so it is
-- searchable only as "the key is present".
CREATE OR REPLACE FUNCTION fm_valued_keys() RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT array_remove(fm_indexed_keys(), 'fixme')
$$;

-- `kv` holds a bare `key` element per indexed key plus a `key=value` element
-- per valued key, lowercased and with semicolon lists exploded — so
-- `cuisine=Pizza;Kebab` is found by both `cuisine=pizza` and `cuisine=kebab`.
--
-- To widen the key list: edit fm_indexed_keys() above, then
--   ALTER TABLE osm_object ALTER COLUMN kv SET EXPRESSION AS (fm_kv(tags));
--   REINDEX INDEX CONCURRENTLY osm_object_kv_idx;
-- No re-import — osm_object holds every tag of every tagged object.
CREATE OR REPLACE FUNCTION fm_kv(tags jsonb) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT coalesce(array_agg(DISTINCT entry), '{}')
  FROM jsonb_each_text(tags) AS t(key, value)
  CROSS JOIN LATERAL (
    SELECT t.key AS entry
    UNION ALL
    SELECT t.key || '=' || lower(btrim(part))
    FROM unnest(string_to_array(t.value, ';')) AS part
    WHERE t.key = ANY (fm_valued_keys())
      AND btrim(part) <> ''
      -- Free-text values are never searched for and would bloat the index. The
      -- cap is on the entry as stored, so whitespace does not count towards it;
      -- the API rejects a longer value rather than search for what is not here.
      AND length(btrim(part)) <= 100
  ) AS e
  WHERE t.key = ANY (fm_indexed_keys())
$$;

-- The label point. ST_PointOnSurface stays inside the polygon where a centroid
-- can fall outside; the fallback is for geometries GEOS refuses.
CREATE OR REPLACE FUNCTION fm_point(g geometry) RETURNS geometry
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE STRICT
AS $$
BEGIN
  RETURN ST_PointOnSurface(g);
EXCEPTION
  WHEN OTHERS THEN
    RETURN ST_Centroid(g);
END;
$$;

-- GeoJSON bbox in WGS84. The envelope is transformed rather than the geometry:
-- 3857 → 4326 is monotonic per axis, so the corners still bound it.
CREATE OR REPLACE FUNCTION fm_bbox(g geometry) RETURNS json
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT json_build_array(
    round(ST_XMin(e)::numeric, 6), round(ST_YMin(e)::numeric, 6),
    round(ST_XMax(e)::numeric, 6), round(ST_YMax(e)::numeric, 6)
  )
  FROM (SELECT ST_Transform(ST_Envelope(g), 4326) AS e) AS s
$$;

ALTER TABLE osm_object
  ADD COLUMN IF NOT EXISTS kv text[] GENERATED ALWAYS AS (fm_kv(tags)) STORED;

-- Every predicate the API supports is an array test on this one index:
-- `kv @> ARRAY['amenity=restaurant','cuisine=pizza']` for an AND of key=value,
-- `kv && ARRAY['amenity','natural']` for "has any of these keys".
CREATE INDEX IF NOT EXISTS osm_object_kv_idx ON osm_object USING gin (kv);

CREATE INDEX IF NOT EXISTS osm_object_geom_idx ON osm_object USING gist (geom);

-- Serves /v1/features/at's "areas containing the point" on its own; a fraction
-- of the size of the full geometry index.
CREATE INDEX IF NOT EXISTS osm_object_area_geom_idx
  ON osm_object USING gist (geom) WHERE area IS NOT NULL;

ANALYZE osm_object;

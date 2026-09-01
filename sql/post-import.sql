-- Run once against a freshly imported (osm2pgsql --create) database, before
-- switching on replication. `ADD COLUMN … GENERATED` rewrites the table, so it
-- has to happen while nothing else is writing.

-- Every key is searchable; what these rules exclude is *value* indexing, for
-- keys whose values are free text or near-unique. What that saves, and what it
-- costs, is in "Data model" in the README — the numbers live there only.
--
-- The API reads these at startup and applies the same rules when it decides
-- between an index lookup and a recheck, so this is the one place to change.
--
-- Two zero-argument functions rather than one with OUT parameters: `fm_kv`
-- reads them per row, and only this shape folds to a constant at plan time.
-- Behind a record they need a lateral join, and the 45 LIKE patterns are then
-- recompiled for every tag — measured at a fifth of the column's build time.
CREATE OR REPLACE FUNCTION fm_value_deny_patterns() RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT ARRAY[
    'name%', '%_name', '%:name', 'addr:%', 'ref', 'ref:%', '%:ref',
    'description%', 'note%', 'comment', 'fixme', 'FIXME',
    'website%', 'url%', 'contact:%', 'phone%', 'fax', 'email',
    'opening_hours%', 'service_times', 'collection_times', '%_hours',
    'wikipedia%', 'wikidata%', 'wikimedia_commons', '%:wikidata',
    '%:wikipedia', 'image%', 'mapillary', 'panoramax',
    'source%', 'attribution', 'operator%', 'brand:%', 'ele',
    'height', 'width', 'capacity%', 'population', 'start_date',
    'end_date', 'inscription', 'check_date%', 'survey:date', '%:date'
  ]
$$;

-- Beyond this a value is free text whatever its key.
CREATE OR REPLACE FUNCTION fm_max_value_length() RETURNS int
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT 40
$$;

-- How a tag value becomes searchable terms: semicolon lists exploded, trimmed,
-- lowercased, empties dropped. The index and the recheck below both go through
-- this, so a predicate cannot mean one thing at import and another at query.
CREATE OR REPLACE FUNCTION fm_tag_values(value text) RETURNS SETOF text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT lower(btrim(part))
  FROM unnest(string_to_array(value, ';')) AS part
  WHERE btrim(part) <> ''
$$;

-- `kv` holds a bare `key` element per key plus a `key=value` element per
-- indexable value, lowercased and with semicolon lists exploded — so
-- `cuisine=Pizza;Kebab` is found by both `cuisine=pizza` and `cuisine=kebab`.
--
-- After changing the rules above:
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
    SELECT t.key || '=' || part
    FROM fm_tag_values(t.value) AS part
    -- The cap is on the entry as stored, so whitespace does not count towards
    -- it; a longer value is answered by a recheck instead. Tested before the
    -- patterns because it is one comparison against forty-five.
    WHERE length(part) <= fm_max_value_length()
      AND NOT (t.key LIKE ANY (fm_value_deny_patterns()))
  ) AS e
$$;

-- Answers a value predicate the index cannot, against the row's own tags.
-- Always ANDed with an indexed key test, so it is a recheck over few rows
-- rather than a scan.
CREATE OR REPLACE FUNCTION fm_tag_matches(tags jsonb, key text, value text)
  RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT EXISTS (
    SELECT 1 FROM fm_tag_values(tags ->> key) AS part WHERE part = value
  )
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

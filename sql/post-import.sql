-- Run once against a freshly imported (osm2pgsql --create) database, before
-- switching on replication. `ADD COLUMN … GENERATED` rewrites the table, so it
-- has to happen while nothing else is writing.

-- Every key is searchable; what these rules exclude is *value* indexing, for
-- keys whose values are free text or near-unique. Indexing those costs far more
-- than it buys: on the Slovakia extract, values for every key make the index
-- 333 MB against 65 MB with these rules and 22 MB for a hand-kept allowlist —
-- and `ref:minvskaddress` alone contributes 1.5 M distinct terms nobody will
-- ever search for.
--
-- The API reads these at startup and applies the same rules when it decides
-- between an index lookup and a recheck, so this is the one place to change.
CREATE OR REPLACE FUNCTION fm_value_index_rules(
  OUT deny_patterns text[], OUT max_length int
) LANGUAGE sql IMMUTABLE PARALLEL SAFE
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
  ], 40
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
    SELECT t.key || '=' || lower(btrim(part))
    FROM unnest(string_to_array(t.value, ';')) AS part,
         LATERAL fm_value_index_rules() AS r
    WHERE btrim(part) <> ''
      AND NOT (t.key LIKE ANY (r.deny_patterns))
      -- The cap is on the entry as stored, so whitespace does not count
      -- towards it; a longer value is answered by a recheck instead.
      AND length(btrim(part)) <= r.max_length
  ) AS e
$$;

-- Answers a value predicate the index cannot: the same normalisation as fm_kv,
-- run against the row's own tags. Always ANDed with an indexed key test, so it
-- is a recheck over few rows rather than a scan.
CREATE OR REPLACE FUNCTION fm_tag_matches(tags jsonb, key text, value text)
  RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM unnest(string_to_array(tags ->> key, ';')) AS part
    WHERE lower(btrim(part)) = value
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

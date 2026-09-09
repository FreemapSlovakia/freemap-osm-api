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
-- Always ANDed with a key test, so the index bounds it — but only as tightly as
-- that key is rare, and the denied keys are the common ones: `name` anchors on
-- 457k rows of the Slovakia extract, `addr:housenumber` on 1.6M. Cheap next to a
-- selective predicate, a second or more on its own over a wide bbox.
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

-- What /v1/features/by-id looks up. osm2pgsql's flex output creates this index
-- itself under `--slim` (`ids.create_index` defaults to `auto`), so this is
-- normally a no-op — but the route would seq-scan the whole table without it,
-- and an import done differently would leave nothing to say so.
--
-- The name is not free: it has to be the one Postgres gives osm2pgsql's own
-- unnamed CREATE INDEX, because IF NOT EXISTS matches on the name and not on
-- the definition. Under any other name this builds a second, identical btree —
-- 167 MB beside a 2.7 GB table on the Slovakia extract, tens of GB on Europe —
-- and every minutely diff then maintains both.
CREATE INDEX IF NOT EXISTS osm_object_osm_type_osm_id_idx
  ON osm_object (osm_type, osm_id);

-- PostGIS prices ST_Intersects at COST 5000 — 12.5 planner units a row, set
-- for geometries far heavier than the ones this answers about. /v1/features
-- pays it only on rows the tag index has already found, but the planner cannot
-- see that: at that price it would sooner spend 8500 units on a second index
-- than recheck 1200 rows, so it ANDs the tag bitmap with a GiST scan of every
-- geometry in the viewport. `aeroway=aerodrome` across central Europe then
-- walks 1.76M index entries — 66 MB, 400 ms — to save a thousand heap fetches
-- from a 114-row answer. At COST 100 the recheck is priced nearer what a POI
-- really costs and the plan collapses to the tag index alone: 400 ms to 0.4.
--
-- Only the public ST_Intersects matters; lowering _ST_Intersects changes
-- nothing, because that is not what the query calls. The setting is
-- database-wide, but PostGIS is installed per database and /v1/features is its
-- only caller here — osm2pgsql does its geometry work in C++, and
-- /v1/features/at asks with ST_DWithin.
--
-- Wrapped because this file is run as the import role, which does not own the
-- extension. Nothing downstream depends on the cost — it only tips a plan the
-- API also steers from its own side — so being refused is worth a warning
-- rather than a failed import. ALTER EXTENSION postgis UPDATE puts the old cost
-- back, which is the other reason this belongs in a file meant to be re-run.
DO $$
BEGIN
  ALTER FUNCTION st_intersects(geometry, geometry) COST 100;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE WARNING 'could not lower the cost of ST_Intersects: %', SQLERRM
      USING HINT =
        'run "ALTER FUNCTION st_intersects(geometry, geometry) COST 100;" as '
        'the owner of the postgis extension, or /v1/features plans a needless '
        'index scan over every geometry in the viewport';
END
$$;

ANALYZE osm_object;

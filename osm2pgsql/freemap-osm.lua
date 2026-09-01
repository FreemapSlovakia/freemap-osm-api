-- osm2pgsql flex config for the Freemap OSM API.
--
-- Writes one row per tagged object into `osm_object`. Deliberately does no tag
-- filtering: which keys are *searchable* is decided by the `kv` generated
-- column in sql/post-import.sql, so widening it never needs a re-import.

-- Keeps only objects intersecting a region, which is what lets a database
-- imported from an extract take the planet's minutely diffs: the diffs carry
-- the nodes of foreign ways too, so without this their geometry assembles and
-- the table fills with a partial world map. Unset for a planet import.
--
--   FM_REGION_QUERY="SELECT 'europe', geom FROM fm_region"
--
-- The query returns (name, geometry in WGS84); the README loads the extract's
-- own .poly into that table. Needs osm2pgsql 2.2+.
local region_query = os.getenv('FM_REGION_QUERY')

local region

if region_query then
  region = osm2pgsql.define_locator({ name = 'region' })
  region:add_from_db(region_query)

  -- A query that matches nothing loads no regions, and every object is then
  -- outside the region: the import runs to the end and writes an empty table.
  -- osm2pgsql logs the count only as information, and the locator has no size()
  -- in Lua — but it prints one, as `osm2pgsql.Locator[name=region,size=N]`.
  local size = tonumber(tostring(region):match('size=(%d+)'))

  if not size or size == 0 then
    error('FM_REGION_QUERY loaded no regions: ' .. region_query)
  end

  print(('Region locator: %d regions from %s'):format(size, region_query))
end

local osm_object = osm2pgsql.define_table({
  name = 'osm_object',
  ids = { type = 'any', id_column = 'osm_id', type_column = 'osm_type' },
  columns = {
    { column = 'tags', type = 'jsonb', not_null = true },
    { column = 'geom', type = 'geometry', projection = 3857, not_null = true },
    -- Mercator area, polygons only. Only ever compared between candidates at
    -- one click point, where the projection distortion is a common factor.
    { column = 'area', type = 'real' },
  },
})

-- Tags that say nothing about what an object *is*.
local IGNORED_TAGS = {
  'created_by',
  'source',
  'source:ref',
  'source:date',
  'note',
  'odbl',
  'attribution',
}

-- Closed ways carrying one of these are areas rather than rings.
local AREA_KEYS = {
  'aeroway',
  'amenity',
  'building',
  'harbour',
  'historic',
  'landuse',
  'leisure',
  'man_made',
  'military',
  'natural',
  'office',
  'place',
  'power',
  'public_transport',
  'shop',
  'sport',
  'tourism',
  'water',
  'waterway',
}

local function clean_tags(tags)
  for _, key in ipairs(IGNORED_TAGS) do
    tags[key] = nil
  end

  return next(tags) == nil
end

local function is_area(tags)
  if tags.area == 'yes' then
    return true
  end

  if tags.area == 'no' then
    return false
  end

  for _, key in ipairs(AREA_KEYS) do
    if tags[key] then
      return true
    end
  end

  return false
end

local function add(object, geom)
  if geom:is_null() then
    return
  end

  if region and not region:first_intersecting(geom) then
    return
  end

  local merc = geom:transform(3857)

  local geom_type = merc:geometry_type()

  local area = nil

  if geom_type == 'POLYGON' or geom_type == 'MULTIPOLYGON' then
    area = merc:area()
  end

  osm_object:insert({ tags = object.tags, geom = merc, area = area })
end

function osm2pgsql.process_node(object)
  if clean_tags(object.tags) then
    return
  end

  add(object, object:as_point())
end

function osm2pgsql.process_way(object)
  if clean_tags(object.tags) then
    return
  end

  if object.is_closed and is_area(object.tags) then
    add(object, object:as_polygon())
  else
    add(object, object:as_linestring())
  end
end

function osm2pgsql.process_relation(object)
  if clean_tags(object.tags) then
    return
  end

  local relation_type = object.tags.type

  if relation_type == 'multipolygon' or relation_type == 'boundary' then
    add(object, object:as_multipolygon())
  elseif relation_type then
    -- Routes, waterways, networks: everything else that is a chain of ways.
    -- Relations whose members carry no line geometry drop out as null.
    add(object, object:as_multilinestring())
  end
end

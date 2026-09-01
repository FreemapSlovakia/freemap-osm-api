-- osm2pgsql flex config for the Freemap OSM API.
--
-- Writes one row per tagged object into `osm_object`. Deliberately does no tag
-- filtering: which keys are *searchable* is decided by the `kv` generated
-- column in sql/post-import.sql, so widening it never needs a re-import.

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

  local geom_type = geom:geometry_type()

  local area = nil

  if geom_type == 'POLYGON' or geom_type == 'MULTIPOLYGON' then
    area = geom:area()
  end

  osm_object:insert({ tags = object.tags, geom = geom, area = area })
end

function osm2pgsql.process_node(object)
  if clean_tags(object.tags) then
    return
  end

  add(object, object:as_point():transform(3857))
end

function osm2pgsql.process_way(object)
  if clean_tags(object.tags) then
    return
  end

  if object.is_closed and is_area(object.tags) then
    add(object, object:as_polygon():transform(3857))
  else
    add(object, object:as_linestring():transform(3857))
  end
end

function osm2pgsql.process_relation(object)
  if clean_tags(object.tags) then
    return
  end

  local relation_type = object.tags.type

  if relation_type == 'multipolygon' or relation_type == 'boundary' then
    add(object, object:as_multipolygon():transform(3857))
  elseif relation_type then
    -- Routes, waterways, networks: everything else that is a chain of ways.
    -- Relations whose members carry no line geometry drop out as null.
    add(object, object:as_multilinestring():transform(3857))
  end
end

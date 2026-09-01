import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { queryJson } from '../db.js';
import { FilterError, Params } from '../predicates.js';
import { FeaturesAtResponseSchema } from '../schemas.js';
import { featureJson, metersPerUnit } from '../sql.js';

/**
 * `Number('')` is 0, so a coordinate has to be rejected before coercion: a
 * client that sends `lon=&lat=` means a bug, not a point in the Atlantic. The
 * params below are saved from that by their `min(1)`.
 */
const numeric = z.string().trim().min(1).pipe(z.coerce.number());

const QuerySchema = z.object({
  // The range moves into the description because the pipe documents its input.
  lon: numeric
    .pipe(z.number().min(-180).max(180))
    .meta({ example: '19.1', description: 'WGS84 longitude, -180 to 180.' }),
  lat: numeric
    .pipe(z.number().min(-85.0511).max(85.0511))
    .meta({ example: '48.7', description: 'WGS84 latitude, ±85.0511.' }),
  /** Meters. */
  radius: z.coerce.number().min(1).max(1000).default(33),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** Comma-separated tag keys; an object must carry one of them. */
  keys: z.string().optional().meta({ example: 'amenity,natural,tourism' }),
});

export const featuresAtRoute: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: 'GET',
    url: '/v1/features/at',
    schema: {
      summary: 'What is at a point: nearby objects and the areas containing it',
      querystring: QuerySchema,
      response: { 200: FeaturesAtResponseSchema },
    },
    serializerCompiler: () => (data) => data as string,
    handler: async (request, reply) => {
      const { lon, lat, radius, limit, keys } = request.query;

      const params = new Params();

      const point =
        `ST_Transform(ST_SetSRID(ST_MakePoint(${params.add(lon)}, ` +
        `${params.add(lat)}), 4326), 3857)`;

      // Distances and areas are computed in Mercator units and scaled back;
      // over a radius of this size the scale factor is constant enough.
      const mpu = metersPerUnit(lat);

      const mpuParam = params.add(mpu);

      const radiusParam = params.add(radius / mpu);

      const limitParam = params.add(limit);

      // An explicit `keys=` is a client that meant to filter, so it goes to
      // parseKeys and 400s there, the same as `keys=,`. Only an absent
      // parameter means "no filter".
      const keyFilter =
        keys === undefined
          ? ''
          : `AND kv && ${params.add(parseKeys(keys))}::text[]`;

      const doc = await queryJson(
        `SELECT json_build_object(
           'nearby', json_build_object(
             'type', 'FeatureCollection',
             'features', coalesce((
               SELECT json_agg(${featureJson(
                 ",\n    'distance', round(f.distance::numeric, 1)",
               )} ORDER BY round(f.distance::numeric, 1), f.osm_id, f.osm_type)
               FROM (
                 SELECT osm_type, osm_id, tags, geom,
                        dist * ${mpuParam}::float8 AS distance
                 FROM (
                   SELECT osm_type, osm_id, tags, geom,
                          CASE
                            WHEN area IS NULL THEN ST_Distance(geom, ${point})
                            -- The point sits deeper inside the area than the
                            -- radius, so its linework is out of range whatever
                            -- the exact distance is. Checked before taking the
                            -- boundary, because ST_DWithin says yes to any area
                            -- containing the point however large: without this,
                            -- every click inside an admin boundary or a big
                            -- landuse materializes that whole multipolygon's
                            -- linework only for the row to be dropped below.
                            WHEN ST_ContainsProperly(
                                   geom,
                                   ST_Expand(${point}, ${radiusParam}::float8))
                              THEN NULL
                            ELSE ST_Distance(ST_Boundary(geom), ${point})
                          END AS dist
                   FROM osm_object
                   WHERE ST_DWithin(geom, ${point}, ${radiusParam}::float8)
                     ${keyFilter}
                 ) AS c
                 -- Areas the point merely falls inside belong in "containing",
                 -- so the distance is to the linework, as Overpass around does.
                 WHERE dist <= ${radiusParam}::float8
                 -- Sorted on the distance as answered, to 0.1 m: below that the
                 -- float noise between two geometries is not an order. The id
                 -- decides the rest, so which of them the limit keeps, and the
                 -- order they are listed in, stay the same between calls.
                 ORDER BY round((dist * ${mpuParam}::float8)::numeric, 1),
                          osm_id, osm_type
                 LIMIT ${limitParam}::int
               ) AS f
             ), '[]'::json)
           ),
           'containing', json_build_object(
             'type', 'FeatureCollection',
             'features', coalesce((
               SELECT json_agg(${featureJson(
                 ",\n    'area', round(f.area::numeric, 1)",
               )} ORDER BY f.area, f.osm_id, f.osm_type)
               FROM (
                 SELECT osm_type, osm_id, tags, geom,
                        area * ${mpuParam}::float8 * ${mpuParam}::float8 AS area
                 FROM osm_object
                 WHERE area IS NOT NULL
                   AND ST_Contains(geom, ${point})
                   ${keyFilter}
                 ORDER BY area, osm_id, osm_type
                 LIMIT ${limitParam}::int
               ) AS f
             ), '[]'::json)
           )
         )::text AS doc`,
        params.values,
      );

      // Already serialized by Postgres; the route's serializer passes it on.
      return reply.type('application/json').send(doc as never);
    },
  });
};

const KEY_RE = /^[a-zA-Z0-9_:.-]+$/;

function parseKeys(keys: string): string[] {
  const list = keys
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

  if (list.length === 0) {
    throw new FilterError('keys must not be empty');
  }

  const invalid = list.filter((key) => !KEY_RE.test(key));

  if (invalid.length > 0) {
    throw new FilterError(`not valid tag keys: ${invalid.join(', ')}`);
  }

  return list;
}

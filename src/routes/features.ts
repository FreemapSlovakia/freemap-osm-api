import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { queryJson } from '../db.js';
import { clausesToSql, Params } from '../predicates.js';
import { FeaturesResponseSchema } from '../schemas.js';
import { featureJson } from '../sql.js';

/** Web Mercator is undefined beyond this. */
const MAX_LAT = 85.0511;

type Bbox = [number, number, number, number];

function parseBbox(value: string): Bbox | null {
  const parts = value.split(',').map(Number);

  if (parts.length !== 4 || !parts.every((part) => Number.isFinite(part))) {
    return null;
  }

  const [west, south, east, north] = (parts as Bbox).map((coord, index) =>
    index % 2 === 0
      ? Math.min(Math.max(coord, -180), 180)
      : Math.min(Math.max(coord, -MAX_LAT), MAX_LAT),
  ) as Bbox;

  // Checked after clamping, so a box that lies wholly outside the valid range
  // is rejected instead of coming back reversed (190,10,200,20 → 190…180).
  if (west >= east || south >= north) {
    return null;
  }

  return [west, south, east, north];
}

const stringArray = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : [value]));

const QuerySchema = z.object({
  bbox: z
    .string()
    .meta({ example: '19.0,48.6,19.3,48.8' })
    .refine((value) => parseBbox(value) !== null, {
      message: 'expected four numbers: west,south,east,north',
    })
    .transform((value) => parseBbox(value) as Bbox),
  /** Repeatable; the clauses are ORed. */
  f: stringArray.meta({ example: 'amenity=restaurant' }),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

export const featuresRoute: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: 'GET',
    url: '/v1/features',
    schema: {
      summary: 'POI search in a bounding box',
      querystring: QuerySchema,
      response: { 200: FeaturesResponseSchema },
    },
    serializerCompiler: () => (data) => data as string,
    handler: async (request, reply) => {
      const { bbox, f, limit } = request.query;

      const params = new Params();

      const envelope =
        'ST_Transform(ST_MakeEnvelope(' +
        bbox.map((coord) => params.add(coord)).join(', ') +
        ', 4326), 3857)';

      const filter = clausesToSql(f, params);

      const limitParam = params.add(limit);

      const doc = await queryJson(
        `WITH hits AS (
           SELECT osm_type, osm_id, tags, geom
           FROM osm_object
           -- The overlap operator picks the candidates off the GiST index,
           -- ST_Intersects then drops the ones only their bounding box put in
           -- the viewport: a country-wide route relation would otherwise match
           -- every viewport inside its box, which Overpass does not do either.
           WHERE geom && ${envelope}
             AND ST_Intersects(geom, ${envelope})
             AND (${filter})
           LIMIT ${limitParam}::int + 1
         )
         SELECT json_build_object(
           'type', 'FeatureCollection',
           'truncated', (SELECT count(*) FROM hits) > ${limitParam}::int,
           'features', coalesce((
             SELECT json_agg(${featureJson()})
             FROM (SELECT * FROM hits LIMIT ${limitParam}::int) AS f
           ), '[]'::json)
         )::text AS doc`,
        params.values,
      );

      // Already serialized by Postgres; the route's serializer passes it on.
      return reply.type('application/json').send(doc as never);
    },
  });
};

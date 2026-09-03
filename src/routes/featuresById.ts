import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { queryJson } from '../db.js';
import { Params } from '../predicates.js';
import { FeaturesByIdResponseSchema } from '../schemas.js';
import { fullFeatureJson } from '../sql.js';

/**
 * The form `featureJson` emits, so an id can be handed straight back. Eighteen
 * digits at most: a nineteenth fits the pattern but not `bigint`, and the cast
 * would raise where nothing turns it into a 400.
 */
const ID_RE = /^(node|way|relation)\/([1-9][0-9]{0,17})$/;

const typeLetter = { node: 'N', way: 'W', relation: 'R' } as const;

// One request answers a whole map's worth of pins; past this it is a bulk
// export, which the bounding-box route serves better. Held below what the URL
// can carry — real ids run to ten digits, so 500 of them is already ~7 kB of
// query string, and a request too long to send fails as a transport error
// rather than as anything this route could explain.
const MAX_IDS = 500;

/**
 * Vertices a response may carry before it is cut short. Unlike the other
 * routes, this one emits whole geometry, so nothing else bounds it: one
 * country boundary is ~45 000 vertices and near a megabyte of JSON, and a few
 * hundred of them would be hundreds of megabytes materialised twice, once by
 * `json_agg` and once as a JavaScript string.
 *
 * The first feature is always whole — the budget is tested against what
 * precedes a feature, so asking for one large relation still answers with it.
 */
const MAX_POINTS = 300_000;

const QuerySchema = z.object({
  /** Repeatable, and comma-separated within each value. */
  ids: z
    .union([z.string(), z.array(z.string())])
    .transform((value) =>
      (Array.isArray(value) ? value : [value])
        .flatMap((part) => part.split(','))
        .filter(Boolean),
    )
    .refine((ids) => ids.length > 0 && ids.length <= MAX_IDS, {
      message: `expected between 1 and ${MAX_IDS} ids`,
    })
    .refine((ids) => ids.every((id) => ID_RE.test(id)), {
      message: 'expected ids like node/240109189, way/27865468, relation/14296',
    })
    .meta({ example: 'node/240109189,way/27865468' }),
});

export const featuresByIdRoute: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: 'GET',
    url: '/v1/features/by-id',
    schema: {
      summary: 'Look up features by OSM id',
      description:
        'Answers with each object’s own geometry. An id the database does ' +
        'not hold is simply absent from the result — the import keeps only ' +
        'tagged objects, and only within its region.',
      querystring: QuerySchema,
      response: { 200: FeaturesByIdResponseSchema },
    },
    serializerCompiler: () => (data) => data as string,
    handler: async (request, reply) => {
      const { ids } = request.query;

      const params = new Params();

      const pairs = ids
        .map((id) => {
          const [, elementType, osmId] = ID_RE.exec(id) as RegExpExecArray;

          return `(${params.add(
            typeLetter[elementType as keyof typeof typeLetter],
          )}, ${params.add(osmId)}::bigint)`;
        })
        .join(', ');

      const budget = params.add(MAX_POINTS);

      const doc = await queryJson(
        `WITH hits AS (
           SELECT osm_type, osm_id, tags, geom,
                  -- What the features before this one already cost. Ordered so
                  -- both which features come back and the order they come back
                  -- in are the same for the same request.
                  coalesce(sum(ST_NPoints(geom)) OVER (
                    ORDER BY osm_type, osm_id
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                  ), 0) AS preceding_points
           FROM osm_object
           WHERE (osm_type, osm_id) IN (${pairs})
         )
         SELECT json_build_object(
           'type', 'FeatureCollection',
           'truncated', (
             SELECT count(*) FROM hits WHERE preceding_points >= ${budget}::int
           ) > 0,
           'features', coalesce((
             SELECT json_agg(${fullFeatureJson()} ORDER BY f.osm_type, f.osm_id)
             FROM (
               SELECT * FROM hits WHERE preceding_points < ${budget}::int
             ) AS f
           ), '[]'::json)
         )::text AS doc`,
        params.values,
      );

      // Already serialized by Postgres; the route's serializer passes it on.
      return reply.type('application/json').send(doc as never);
    },
  });
};

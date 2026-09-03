import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { queryJson } from '../db.js';
import { Params } from '../predicates.js';
import { FeaturesByIdResponseSchema } from '../schemas.js';
import { fullFeatureJson } from '../sql.js';

/** The form `featureJson` emits, so an id can be handed straight back. */
const ID_RE = /^(node|way|relation)\/([1-9][0-9]{0,18})$/;

const typeLetter = { node: 'N', way: 'W', relation: 'R' } as const;

// One request answers a whole map's worth of pins; past this it is a bulk
// export, which the bounding-box route serves better.
const MAX_IDS = 1000;

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

      const doc = await queryJson(
        `SELECT json_build_object(
           'type', 'FeatureCollection',
           'features', coalesce((
             SELECT json_agg(${fullFeatureJson()})
             FROM (
               SELECT osm_type, osm_id, tags, geom
               FROM osm_object
               WHERE (osm_type, osm_id) IN (${pairs})
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

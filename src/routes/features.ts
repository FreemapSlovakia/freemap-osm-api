import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  estimateTagRows,
  estimateViewportRows,
  queryJson,
  tableRows,
} from '../db.js';
import { clausesToSql, KV_HIDDEN, Params, parseKeys } from '../predicates.js';
import { FeaturesResponseSchema } from '../schemas.js';
import { featureJson, pickedTags } from '../sql.js';

/** Web Mercator is undefined beyond this. */
const MAX_LAT = 85.0511;

/**
 * Under this many expected matches the tag index leads without the viewport
 * being sized at all: a couple of thousand rows walk in single-digit
 * milliseconds whatever the box holds, and that is cheaper than the round trip
 * it would take to find out.
 */
const TAG_LEAD_ALWAYS_ROWS = 2_000;

/**
 * A predicate whose value `kv` could not carry is answered by `fm_tag_matches`
 * on every row its key anchors, and in the tag-leading shape the viewport
 * cannot prune any of them. Measured at ~3.6 µs a row against ~1.4 µs for a
 * plain containment hit, so those rows count treble when the two sides are
 * weighed — `f=website=…` anchors 42k rows on the Slovakia extract and is 148 ms
 * that way against 19 ms the other, while `f=amenity=restaurant,name=…` anchors
 * few enough that it stays on the cheap side of the same comparison.
 */
const RECHECK_ROW_WEIGHT = 3;

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
  fields: z
    .string()
    .optional()
    .meta({
      example: 'name,brand',
      description:
        'Tag keys to keep in properties, comma-separated. Absent keeps every ' +
        'tag; the keys used in f are always kept.',
    }),
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
      const { bbox, f, limit, fields } = request.query;

      // Before the estimates, so a bad list is a 400 without a round trip.
      const fieldKeys =
        fields === undefined ? undefined : parseKeys(fields, 'fields');

      const params = new Params();

      const envelope =
        'ST_Transform(ST_MakeEnvelope(' +
        bbox.map((coord) => params.add(coord)).join(', ') +
        ', 4326), 3857)';

      // Parsed once against throwaway bind values, only to size the match set:
      // which index leads decides how the real SQL has to be written, so it has
      // to be known before the filter is built for keeps.
      const { clauses } = clausesToSql(f, new Params());

      // The clauses are ORed, so their match sets add up.
      const tagRows = clauses.reduce(
        (total, { contains, recheck }) =>
          total +
          estimateTagRows(contains) * (recheck ? RECHECK_ROW_WEIGHT : 1),
        0,
      );

      // Which index leads: the more selective half of the question. Neither
      // side wins on its own terms — `natural=scrub` anchors 49k rows, which
      // beats a continent (63 ms against 189) and loses to a city block (74 ms
      // against 14) — so the filter is weighed against the box rather than
      // against a constant.
      //
      // Left to itself the planner takes a third option here, a bitmap AND of
      // both indexes, that a LIMIT can never make cheap: both bitmaps have to
      // be built in full before one row comes out, and the geometry side of
      // that is every geometry in the viewport. Asking for aerodromes across
      // central Europe it walked 1.76M index entries to narrow 114 rows to 32.
      // Choosing a side here is what takes that plan off the table.
      //
      // Tag-leading walks the whole match set — the GIN bitmap is built in
      // full before a row comes out, so the limit cannot bound it. Geometry-
      // leading streams the viewport in index order and stops at the limit,
      // reading about `limit × tableRows / tagRows` rows to find that many
      // matches. The two meet at sqrt(limit × tableRows): a ceiling with
      // nothing to tune that follows the import instead of the machine it was
      // measured on — 55k rows on the Slovakia extract, 561k on Europe, and on
      // Europe that is where `amenity=pharmacy` (213k, 0.31 s against 1.14 s)
      // and `tourism=information` (1.14M, 0.73 s against 0.09 s) fall either
      // side of it. An unknown table size reads as 0 and sends everything to
      // the geometry index, which is how the route ran before it weighed
      // anything; an unknown tag estimate is Infinity and lands there too.
      //
      // The ceiling prices that early exit, which a clause carrying a recheck
      // cannot count on: its match set is the rows its *key* anchors, while
      // what survives `fm_tag_matches` may be almost none of them, so the
      // geometry scan runs to the end of the viewport instead of stopping.
      // `f=website=…` over a continent is 0.15 s leading with tags and 0.63 s
      // the other way, for exactly that reason — so the ceiling is not applied
      // to those, and the viewport comparison below decides them alone.
      const rows = tableRows();

      const recheck = clauses.some((clause) => clause.recheck);

      const tagLead =
        rows !== undefined &&
        (recheck || tagRows < Math.sqrt(limit * rows)) &&
        (tagRows <= TAG_LEAD_ALWAYS_ROWS ||
          tagRows < (await estimateViewportRows(bbox)));

      // Built for keeps, now that the shape is settled. Leading with geometry
      // means the tag index must not be offered at all, or the planner puts the
      // two together into the bitmap AND again.
      const filter = clausesToSql(f, params, tagLead ? undefined : KV_HIDDEN);

      const limitParam = params.add(limit);

      // The filter's keys are kept, negated ones too: `!wheelchair` in one
      // clause must not strip the `wheelchair` of an object another matched.
      const properties =
        fieldKeys &&
        pickedTags(
          params.add([
            ...new Set([
              ...fieldKeys,
              ...filter.clauses.flatMap((clause) => clause.keys),
            ]),
          ]),
        );

      // In both shapes the cheap overlap operator runs before ST_Intersects,
      // which drops the objects only their bounding box put in the viewport: a
      // country-wide route relation would otherwise match every viewport inside
      // its box, which Overpass does not do either.
      const source = tagLead
        ? // The mirror of KV_HIDDEN. OFFSET 0 is an optimization barrier: it
          // keeps the geometry tests from being pushed down into the subquery,
          // where they would reach the GiST index and bring the bitmap AND
          // back. Out here they are filters on the rows the tag index found.
          `(
             SELECT osm_type, osm_id, tags, geom
             FROM osm_object
             WHERE (${filter.sql})
             OFFSET 0
           ) AS c
           WHERE c.geom && ${envelope}
             AND ST_Intersects(c.geom, ${envelope})`
        : // The viewport is the selective half: the geometry index leads, and
          // with the tag test unable to reach an index it streams rows in index
          // order and stops at the limit.
          `osm_object
           WHERE geom && ${envelope}
             AND ST_Intersects(geom, ${envelope})
             AND (${filter.sql})`;

      const doc = await queryJson(
        `WITH hits AS (
           SELECT osm_type, osm_id, tags, geom
           FROM ${source}
           LIMIT ${limitParam}::int + 1
         )
         SELECT json_build_object(
           'type', 'FeatureCollection',
           'truncated', (SELECT count(*) FROM hits) > ${limitParam}::int,
           'features', coalesce((
             SELECT json_agg(${featureJson('', properties)})
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

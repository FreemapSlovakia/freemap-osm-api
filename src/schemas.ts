import { z } from 'zod';

export const TagsSchema = z.record(z.string(), z.string());

export const BBoxSchema = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
]);

export const PointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number(), z.number()]),
});

export const FeatureSchema = z.object({
  type: z.literal('Feature'),
  id: z.string().meta({ example: 'way/123456' }),
  /** Of the whole geometry, in WGS84 — the point geometry is only its label. */
  bbox: BBoxSchema,
  geometry: PointSchema,
  properties: TagsSchema,
});

export const NearbyFeatureSchema = z.object({
  ...FeatureSchema.shape,
  /** Meters from the queried point to the geometry. */
  distance: z.number(),
});

export const ContainingFeatureSchema = z.object({
  ...FeatureSchema.shape,
  /** Square meters. */
  area: z.number(),
});

/**
 * The object's own geometry, as PostGIS renders it. Any GeoJSON type, so the
 * members are described rather than the types enumerated — `coordinates` is
 * named so a generated client can reach it at all.
 */
export const GeometrySchema = z.looseObject({
  type: z.string().meta({ example: 'LineString' }),
  /** Absent only on a GeometryCollection, which carries `geometries` instead. */
  coordinates: z.unknown().optional(),
});

/** A feature drawn rather than pinned: real geometry in place of the label point. */
export const FullFeatureSchema = z.object({
  ...FeatureSchema.omit({ geometry: true }).shape,
  geometry: GeometrySchema,
});

export function featureCollection<T extends z.ZodType>(feature: T) {
  return z.object({
    type: z.literal('FeatureCollection'),
    features: z.array(feature),
  });
}

/** The limit was reached, so the result is an arbitrary subset of the matches. */
export const FeaturesResponseSchema = z.object({
  type: z.literal('FeatureCollection'),
  truncated: z.boolean(),
  features: z.array(FeatureSchema),
});

/** `truncated`: the vertex budget was reached, so some ids have no feature here. */
export const FeaturesByIdResponseSchema = z.object({
  type: z.literal('FeatureCollection'),
  truncated: z.boolean(),
  features: z.array(FullFeatureSchema),
});

export const FeaturesAtResponseSchema = z.object({
  nearby: featureCollection(NearbyFeatureSchema),
  containing: featureCollection(ContainingFeatureSchema),
});

export const StatusResponseSchema = z.object({
  /** Timestamp of the last OSM change applied, ISO 8601. */
  dataTimestamp: z.string().nullable(),
  importTimestamp: z.string().nullable(),
  /** Rough WGS84 extent of the imported data. */
  coverage: BBoxSchema.nullable(),
});

import { z } from 'zod';

// Connection settings come from the standard PG* variables that libpq and the
// `pg` package already read (PGHOST, PGDATABASE, PGUSER, PGPASSWORD, …).
const ConfigSchema = z.object({
  HTTP_HOST: z.string().default('127.0.0.1'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default('info'),
  PG_POOL_MAX: z.coerce.number().int().min(1).default(10),
  /** Comma-separated allowlist; empty disables CORS entirely. */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  /** Serve the OpenAPI document and the Scalar reference at /docs. */
  DOCS: z.stringbool().default(false),
  /** Statement timeout for every query, in milliseconds. */
  STATEMENT_TIMEOUT: z.coerce.number().int().min(100).default(15_000),
});

export const config = ConfigSchema.parse(process.env);

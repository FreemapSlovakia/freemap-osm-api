import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import Fastify, { type FastifyError } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { config } from './config.js';
import { getStatus } from './db.js';
import { FilterError } from './predicates.js';
import { featuresRoute } from './routes/features.js';
import { featuresAtRoute } from './routes/featuresAt.js';
import { statusRoute } from './routes/status.js';

export async function buildApp() {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);

  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof FilterError) {
      return reply.status(400).send({ error: error.message });
    }

    request.log.error(error);

    // Fastify's own FST_ERR_* errors carry statusCode 500, so "has a status
    // code" is not "is safe to show" — only a 4xx message is meant for a client.
    const statusCode = error.statusCode ?? 500;

    return reply.status(statusCode).send({
      error: statusCode < 500 ? error.message : 'internal server error',
    });
  });

  if (config.CORS_ORIGINS.length > 0) {
    await app.register(cors, {
      origin: config.CORS_ORIGINS,
      methods: ['GET'],
      // Without this the browser hides X-Data-Timestamp from the cross-origin
      // client the header exists for.
      exposedHeaders: ['X-Data-Timestamp'],
    });
  }

  // Lets the client tell "the data is old" from "the object is gone". Never
  // fails a response that otherwise worked.
  app.addHook('onSend', async (request, reply) => {
    try {
      const { dataTimestamp } = await getStatus();

      if (dataTimestamp) {
        reply.header('X-Data-Timestamp', dataTimestamp);
      }
    } catch (err) {
      request.log.warn(err);
    }
  });

  if (config.DOCS) {
    await app.register(swagger, {
      openapi: {
        info: { title: 'Freemap OSM API', version: '1.0.0' },
        servers: [{ url: 'https://osm.freemap.sk' }],
      },
      transform: jsonSchemaTransform,
    });

    await app.register(scalar, { routePrefix: '/docs' });
  }

  await app.register(featuresRoute);

  await app.register(featuresAtRoute);

  await app.register(statusRoute);

  return app;
}

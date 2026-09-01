import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getStatus } from '../db.js';
import { StatusResponseSchema } from '../schemas.js';

export const statusRoute: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: 'GET',
    url: '/v1/status',
    schema: {
      summary: 'Data freshness and coverage',
      response: { 200: StatusResponseSchema },
    },
    handler: () => getStatus(),
  });
};

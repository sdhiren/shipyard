import fs from 'node:fs';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError } from './lib/util.js';
import { itemRoutes } from './routes/items.js';
import { projectRoutes } from './routes/projects.js';
import { systemRoutes } from './routes/system.js';

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: 'info', transport: undefined },
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(cors, { origin: (origin, cb) => cb(null, !origin || LOCAL_ORIGIN.test(origin)) });

  /**
   * This server can make Claude edit code on your machine, so state-changing
   * requests must come from the Shipyard UI: a custom header forces a CORS
   * preflight, which other websites cannot pass.
   */
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (req.headers['x-shipyard'] !== '1') {
      return reply.code(403).send({ error: 'Missing X-Shipyard header' });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid request', issues: err.issues });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: (err as Error).message || 'Internal error' });
  });

  await app.register(systemRoutes);
  await app.register(projectRoutes);
  await app.register(itemRoutes);

  // In production the API also serves the built web app.
  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}

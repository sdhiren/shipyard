import { RUN_STATUSES, type LiveEvent } from '@shipyard/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { bus } from '../lib/events.js';
import { hasBinary } from '../lib/exec.js';
import { cancelLogin, getAuthStatus, getLoginSession, startLogin, submitLoginCode } from '../services/claude/auth.js';
import { getDashboard } from '../services/dashboard.js';
import { ghAvailable } from '../services/github.js';
import { pollOpenPrs, startPrTracker } from '../services/pr-tracker.js';
import { cancelRun, getRun, getRunEvents, listRuns, queueSnapshot } from '../services/runs.js';
import { getSettings, updateSettings } from '../services/settings.js';

const idParams = z.object({ id: z.string() });

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    const [claude, gh, claudeAuth] = await Promise.all([hasBinary(config.claudeBin), ghAvailable(), getAuthStatus()]);
    return { ok: true, claude, claudeAuth, gh, dataDir: config.dataDir, queue: queueSnapshot() };
  });

  // Claude Code sign-in ---------------------------------------------------------

  app.get('/api/claude/auth', async (req) => {
    const { refresh } = z.object({ refresh: z.enum(['true', 'false']).optional() }).parse(req.query);
    return { status: await getAuthStatus({ force: refresh === 'true' }), login: getLoginSession() };
  });

  app.post('/api/claude/login', async (req, reply) => {
    const { method } = z.object({ method: z.enum(['claudeai', 'console']).default('claudeai') }).parse(req.body ?? {});
    return reply.code(202).send(startLogin(method));
  });

  app.post('/api/claude/login/code', async (req) => submitLoginCode(z.object({ code: z.string().min(1).max(4000) }).parse(req.body).code));

  app.delete('/api/claude/login', async (_req, reply) => {
    cancelLogin();
    return reply.code(204).send();
  });

  app.get('/api/dashboard', async () => getDashboard());

  app.get('/api/settings', async () => getSettings());

  app.put('/api/settings', async (req) => {
    const next = updateSettings(z.record(z.string(), z.unknown()).parse(req.body));
    startPrTracker((m) => app.log.info(m));
    return next;
  });

  app.post('/api/prs/sync', async () => pollOpenPrs());

  // Runs ------------------------------------------------------------------

  app.get('/api/runs', async (req) => {
    const q = z
      .object({
        projectId: z.string().optional(),
        status: z
          .string()
          .optional()
          .transform((s) => (s ? s.split(',') : undefined))
          .pipe(z.array(z.enum(RUN_STATUSES)).optional()),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(req.query);
    return listRuns(q);
  });

  app.get('/api/runs/:id', async (req) => getRun(idParams.parse(req.params).id));

  app.get('/api/runs/:id/events', async (req) => {
    const { after } = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    return getRunEvents(idParams.parse(req.params).id, after);
  });

  app.post('/api/runs/:id/cancel', async (req) => cancelRun(idParams.parse(req.params).id));

  // Live updates (Server-Sent Events) ------------------------------------------

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const send = (event: LiveEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = bus.subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}

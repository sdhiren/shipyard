import { analyzeSchema, createItemSchema, createProjectSchema, ITEM_STATUSES, ITEM_TYPES, updateProjectSchema } from '@shipyard/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listActivity } from '../services/activity.js';
import { getAnalysis, listAnalyses, startAnalysis } from '../services/agent.js';
import { createItem, listItems } from '../services/items.js';
import { applyImports, createProject, deleteProject, discover, getProject, listProjects, previewImports, rescanProject, updateProject } from '../services/projects.js';

const idParams = z.object({ id: z.string() });
const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').filter(Boolean) : undefined))
    .pipe(z.array(z.enum(values)).optional());

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/projects', async (req) => {
    const q = z.object({ archived: z.coerce.boolean().optional() }).parse(req.query);
    return listProjects({ includeArchived: q.archived });
  });

  app.post('/api/projects', async (req, reply) => {
    const project = await createProject(createProjectSchema.parse(req.body));
    return reply.code(201).send(project);
  });

  app.get('/api/projects/discover', async () => discover());

  app.get('/api/projects/:id', async (req) => getProject(idParams.parse(req.params).id));

  app.patch('/api/projects/:id', async (req) => updateProject(idParams.parse(req.params).id, updateProjectSchema.parse(req.body)));

  app.delete('/api/projects/:id', async (req, reply) => {
    deleteProject(idParams.parse(req.params).id);
    return reply.code(204).send();
  });

  app.post('/api/projects/:id/rescan', async (req) => rescanProject(idParams.parse(req.params).id));

  app.get('/api/projects/:id/imports', async (req) => previewImports(idParams.parse(req.params).id));

  app.post('/api/projects/:id/imports', async (req) => {
    const { sourceRefs } = z.object({ sourceRefs: z.array(z.string()).min(1) }).parse(req.body);
    return { imported: await applyImports(idParams.parse(req.params).id, sourceRefs) };
  });

  app.get('/api/projects/:id/items', async (req) => {
    const q = z
      .object({
        status: csv(ITEM_STATUSES),
        type: csv(ITEM_TYPES),
        q: z.string().optional(),
        includeSnoozed: z.coerce.boolean().optional(),
      })
      .parse(req.query);
    return listItems(idParams.parse(req.params).id, q);
  });

  app.post('/api/projects/:id/items', async (req, reply) => {
    const item = createItem(idParams.parse(req.params).id, createItemSchema.parse(req.body));
    return reply.code(201).send(item);
  });

  app.get('/api/projects/:id/analyses', async (req) => listAnalyses(idParams.parse(req.params).id));

  app.post('/api/projects/:id/analyses', async (req, reply) => {
    const analysis = startAnalysis(idParams.parse(req.params).id, analyzeSchema.parse(req.body ?? {}));
    return reply.code(202).send(analysis);
  });

  app.get('/api/analyses/:id', async (req) => getAnalysis(idParams.parse(req.params).id));

  app.get('/api/projects/:id/activity', async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
    return listActivity({ projectId: idParams.parse(req.params).id, limit });
  });
}

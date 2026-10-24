import {
  bulkDecisionSchema,
  decisionSchema,
  ITEM_STATUSES,
  linkPrSchema,
  noteSchema,
  reviseSchema,
  updateItemSchema,
  type DecisionInput,
} from '@shipyard/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listActivity } from '../services/activity.js';
import {
  discardWorkspace,
  getItemDiff,
  linkPr,
  mergePr,
  openPr,
  startImplementation,
  startPlan,
  startRevision,
  syncPr,
} from '../services/agent.js';
import { addNote, decide, getItem, hardDelete, moveItem, updateItem } from '../services/items.js';
import { listRuns } from '../services/runs.js';

const idParams = z.object({ id: z.string() });

/** `implement` and `plan` start Claude runs; everything else is a state change. */
function applyDecision(id: string, input: DecisionInput) {
  if (input.decision === 'implement') return { run: startImplementation(id), item: getItem(id) };
  if (input.decision === 'plan') return { run: startPlan(id), item: getItem(id) };
  return { run: null, item: decide(id, input) };
}

export async function itemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/items/:id', async (req) => getItem(idParams.parse(req.params).id));

  app.patch('/api/items/:id', async (req) => updateItem(idParams.parse(req.params).id, updateItemSchema.parse(req.body)));

  app.delete('/api/items/:id', async (req, reply) => {
    hardDelete(idParams.parse(req.params).id);
    return reply.code(204).send();
  });

  app.post('/api/items/:id/move', async (req) => {
    const body = z.object({ status: z.enum(ITEM_STATUSES), position: z.number() }).parse(req.body);
    return moveItem(idParams.parse(req.params).id, body.status, body.position);
  });

  app.post('/api/items/:id/decision', async (req) => applyDecision(idParams.parse(req.params).id, decisionSchema.parse(req.body)));

  app.post('/api/items/bulk-decision', async (req) => {
    const { itemIds, ...decision } = bulkDecisionSchema.parse(req.body);
    const results = itemIds.map((id) => {
      try {
        applyDecision(id, decision);
        return { id, ok: true as const };
      } catch (err) {
        return { id, ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    });
    return { results };
  });

  app.post('/api/items/:id/notes', async (req, reply) => {
    addNote(idParams.parse(req.params).id, noteSchema.parse(req.body).body);
    return reply.code(201).send({ ok: true });
  });

  app.get('/api/items/:id/activity', async (req) => listActivity({ itemId: idParams.parse(req.params).id, limit: 200 }));

  app.get('/api/items/:id/runs', async (req) => listRuns({ itemId: idParams.parse(req.params).id }));

  app.post('/api/items/:id/plan', async (req, reply) => reply.code(202).send(startPlan(idParams.parse(req.params).id)));

  app.post('/api/items/:id/implement', async (req, reply) => reply.code(202).send(startImplementation(idParams.parse(req.params).id)));

  app.post('/api/items/:id/revise', async (req, reply) =>
    reply.code(202).send(startRevision(idParams.parse(req.params).id, reviseSchema.parse(req.body).feedback)),
  );

  app.get('/api/items/:id/diff', async (req) => getItemDiff(idParams.parse(req.params).id));

  app.delete('/api/items/:id/workspace', async (req) => discardWorkspace(idParams.parse(req.params).id));

  app.post('/api/items/:id/pr', async (req) => openPr(idParams.parse(req.params).id));

  app.post('/api/items/:id/pr/link', async (req) => linkPr(idParams.parse(req.params).id, linkPrSchema.parse(req.body).prUrlOrNumber));

  app.post('/api/items/:id/pr/sync', async (req) => syncPr(idParams.parse(req.params).id));

  app.post('/api/items/:id/pr/merge', async (req) => {
    const { method } = z.object({ method: z.enum(['squash', 'merge', 'rebase']).default('squash') }).parse(req.body ?? {});
    return mergePr(idParams.parse(req.params).id, method);
  });
}

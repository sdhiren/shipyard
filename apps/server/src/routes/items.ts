import {
  bulkDecisionSchema,
  createCommentSchema,
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
import { addComment, deleteComment, listComments } from '../services/comments.js';
import {
  discardWorkspace,
  getItemDiff,
  linkPr,
  mergePr,
  openPr,
  startImplementation,
  startDiscussion,
  startPlan,
  startRebase,
  startRevision,
  syncPr,
} from '../services/agent.js';
import { addNote, decide, getItem, hardDelete, moveItem, updateItem } from '../services/items.js';
import { isItemBusy, listRuns } from '../services/runs.js';
import { conflict } from '../lib/util.js';

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

  app.post('/api/items/:id/revise', async (req, reply) => {
    const id = idParams.parse(req.params).id;
    const { feedback } = reviseSchema.parse(req.body);
    if (isItemBusy(id)) throw conflict('Claude is already working on this item');
    addComment({ itemId: id, author: 'user', kind: 'change_request', body: feedback });
    return reply.code(202).send(startRevision(id, feedback));
  });

  app.get('/api/items/:id/diff', async (req) => getItemDiff(idParams.parse(req.params).id));

  app.delete('/api/items/:id/workspace', async (req) => discardWorkspace(idParams.parse(req.params).id));

  app.post('/api/items/:id/pr', async (req) => openPr(idParams.parse(req.params).id));

  app.post('/api/items/:id/pr/link', async (req) => linkPr(idParams.parse(req.params).id, linkPrSchema.parse(req.body).prUrlOrNumber));

  app.post('/api/items/:id/pr/sync', async (req) => syncPr(idParams.parse(req.params).id));

  // Discussion ---------------------------------------------------------------

  app.get('/api/items/:id/comments', async (req) => listComments(idParams.parse(req.params).id));

  /** Post to the thread; `intent` decides whether Claude replies or revises the branch. */
  app.post('/api/items/:id/comments', async (req, reply) => {
    const id = idParams.parse(req.params).id;
    const input = createCommentSchema.parse(req.body);
    if (input.intent !== 'comment' && isItemBusy(id)) {
      throw conflict('Claude is already working on this item. Post it as a plain comment, or wait until it finishes.');
    }
    const comment = addComment({ itemId: id, author: 'user', kind: input.intent === 'change_request' ? 'change_request' : input.kind, body: input.body });
    const run = input.intent === 'ask' ? startDiscussion(id) : input.intent === 'change_request' ? startRevision(id, input.body) : null;
    return reply.code(201).send({ comment, run });
  });

  /** Ask Claude to reply to the thread again (e.g. after a failed reply). */
  app.post('/api/items/:id/discuss', async (req, reply) => reply.code(202).send(startDiscussion(idParams.parse(req.params).id)));

  app.delete('/api/comments/:id', async (req, reply) => {
    deleteComment(idParams.parse(req.params).id);
    return reply.code(204).send();
  });

  app.post('/api/items/:id/rebase', async (req, reply) => reply.code(202).send(startRebase(idParams.parse(req.params).id)));

  app.post('/api/items/:id/pr/merge', async (req) => {
    const { method } = z.object({ method: z.enum(['squash', 'merge', 'rebase']).default('squash') }).parse(req.body ?? {});
    return mergePr(idParams.parse(req.params).id, method);
  });
}

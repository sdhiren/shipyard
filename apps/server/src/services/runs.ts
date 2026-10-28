import type { Run, RunEvent, RunEventType, RunKind, RunStatus } from '@shipyard/shared';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { items, projects, runEvents, runs, type RunRow } from '../db/schema.js';
import { bus } from '../lib/events.js';
import { conflict, newId, notFound, now } from '../lib/util.js';
import { toRun } from './mappers.js';
import { getSettings } from './settings.js';

/**
 * A small persistent job queue for Claude runs. Run rows and their event logs
 * live in SQLite; the work itself is an in-process closure, so runs that were
 * mid-flight when the server stopped are marked failed on boot.
 *
 * Two limits apply: a global cap on concurrent runs, and an optional per-group
 * cap (used to limit how many runs may change one repository at once). Queued
 * runs that are blocked record why, so the UI can say what they're waiting for.
 */

export interface RunContext {
  runId: string;
  signal: AbortSignal;
  emit: (type: RunEventType, text: string, data?: unknown) => void;
  update: (patch: Partial<RunRow>) => void;
}

type Task = (ctx: RunContext) => Promise<{ status: RunStatus; summary?: string | null; error?: string | null }>;

export interface QueueGroup {
  /** Runs sharing a key count toward the same limit, e.g. `write:<projectId>`. */
  key: string;
  /** Read each time the queue is pumped, so setting changes apply immediately. */
  limit: () => number;
  /** Used in the waiting message, e.g. the project name. */
  label: string;
}

interface Pending {
  runId: string;
  task: Task;
  group?: QueueGroup;
}

const queue: Pending[] = [];
const active = new Map<string, AbortController>();
/** runId → group key, for runs that are executing. */
const activeGroups = new Map<string, string>();
/** runId → why it's still queued. */
const waiting = new Map<string, string>();
const seqs = new Map<string, number>();

function publishRun(row: RunRow): void {
  bus.publish({ type: 'run.changed', runId: row.id, projectId: row.projectId, itemId: row.itemId, status: row.status });
}

export function getRunRow(id: string): RunRow {
  const row = db.select().from(runs).where(eq(runs.id, id)).get();
  if (!row) throw notFound('Run');
  return row;
}

function updateRun(id: string, patch: Partial<RunRow>): RunRow {
  db.update(runs).set(patch).where(eq(runs.id, id)).run();
  const row = getRunRow(id);
  publishRun(row);
  return row;
}

function emit(runId: string, type: RunEventType, text: string, data?: unknown): void {
  if (!seqs.has(runId)) primeSeq(runId);
  const seq = (seqs.get(runId) ?? 0) + 1;
  seqs.set(runId, seq);
  const createdAt = now();
  const inserted = db
    .insert(runEvents)
    .values({ runId, seq, type, text, data: data ?? null, createdAt })
    .returning({ id: runEvents.id })
    .get();
  const event: RunEvent = { id: inserted.id, runId, seq, type, text, data: data ?? null, createdAt };
  bus.publish({ type: 'run.event', runId, event });
}

export function createRun(input: {
  projectId: string;
  itemId?: string | null;
  analysisId?: string | null;
  kind: RunKind;
  model: string;
  prompt: string;
  cwd: string;
  branch?: string | null;
}): RunRow {
  const row: RunRow = {
    id: newId('run'),
    projectId: input.projectId,
    itemId: input.itemId ?? null,
    analysisId: input.analysisId ?? null,
    kind: input.kind,
    status: 'queued',
    model: input.model,
    prompt: input.prompt,
    sessionId: null,
    cwd: input.cwd,
    branch: input.branch ?? null,
    summary: null,
    error: null,
    costUsd: null,
    durationMs: null,
    numTurns: null,
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
  };
  db.insert(runs).values(row).run();
  publishRun(row);
  return row;
}

export function enqueue(runId: string, task: Task, group?: QueueGroup): void {
  queue.push({ runId, task, group });
  emit(runId, 'status', 'Queued');
  pumpQueue();
}

/** Item keys (e.g. "US-3") of the given runs, for waiting messages. */
function itemKeysFor(runIds: string[]): string[] {
  if (!runIds.length) return [];
  return db
    .select({ number: items.number, prefix: projects.keyPrefix })
    .from(runs)
    .innerJoin(items, eq(items.id, runs.itemId))
    .innerJoin(projects, eq(projects.id, items.projectId))
    .where(inArray(runs.id, runIds))
    .all()
    .map((r) => `${r.prefix}-${r.number}`);
}

function setWaiting(runId: string, reason: string): void {
  if (waiting.get(runId) === reason) return;
  waiting.set(runId, reason);
  emit(runId, 'status', reason);
  publishRun(getRunRow(runId));
}

/** Start every queued run whose global and group limits allow it, in order. */
export function pumpQueue(): void {
  const limit = getSettings().maxConcurrentRuns;
  for (let i = 0; i < queue.length; ) {
    const next = queue[i]!;
    if (next.group) {
      const max = Math.max(1, next.group.limit());
      const busy = [...activeGroups].filter(([, key]) => key === next.group!.key).map(([id]) => id);
      if (busy.length >= max) {
        const keys = itemKeysFor(busy);
        setWaiting(
          next.runId,
          `Waiting for ${keys.length ? keys.join(', ') : 'another run'} to finish: ${next.group.label} allows ${max} implementation${max === 1 ? '' : 's'} at a time`,
        );
        i++;
        continue;
      }
    }
    if (active.size >= limit) {
      setWaiting(next.runId, `Waiting for a free run slot (${active.size} of ${limit} in use)`);
      i++;
      continue;
    }
    queue.splice(i, 1);
    void execute(next);
  }
}


async function execute({ runId, task, group }: Pending): Promise<void> {
  const controller = new AbortController();
  active.set(runId, controller);
  waiting.delete(runId);
  if (group) activeGroups.set(runId, group.key);
  updateRun(runId, { status: 'running', startedAt: now() });
  emit(runId, 'status', 'Running');
  const ctx: RunContext = {
    runId,
    signal: controller.signal,
    emit: (type, text, data) => emit(runId, type, text, data),
    update: (patch) => updateRun(runId, patch),
  };
  try {
    const result = await task(ctx);
    const status: RunStatus = controller.signal.aborted ? 'cancelled' : result.status;
    updateRun(runId, {
      status,
      summary: result.summary ?? null,
      error: result.error ?? null,
      finishedAt: now(),
    });
    emit(runId, 'status', status === 'succeeded' ? 'Finished' : status === 'cancelled' ? 'Cancelled' : `Failed: ${result.error ?? 'unknown error'}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateRun(runId, { status: controller.signal.aborted ? 'cancelled' : 'failed', error: message, finishedAt: now() });
    emit(runId, 'status', `Failed: ${message}`);
  } finally {
    active.delete(runId);
    activeGroups.delete(runId);
    seqs.delete(runId);
    pumpQueue();
  }
}

export function cancelRun(id: string): Run {
  const row = getRunRow(id);
  const idx = queue.findIndex((q) => q.runId === id);
  if (idx >= 0) {
    queue.splice(idx, 1);
    waiting.delete(id);
    emit(id, 'status', 'Cancelled before it started');
    const row = toRun(updateRun(id, { status: 'cancelled', finishedAt: now() }));
    pumpQueue();
    return row;
  }
  const ctrl = active.get(id);
  if (!ctrl) throw conflict(`Run is already ${row.status}`);
  ctrl.abort();
  return toRun(getRunRow(id));
}

/** Called on boot: anything that was queued/running belonged to a dead process. */
export function recoverInterruptedRuns(): number {
  const stale = db
    .select()
    .from(runs)
    .where(inArray(runs.status, ['queued', 'running']))
    .all();
  for (const r of stale) {
    updateRun(r.id, { status: 'failed', error: 'Interrupted: the Shipyard server stopped while this run was active', finishedAt: now() });
  }
  return stale.length;
}

export function isItemBusy(itemId: string): boolean {
  return !!db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.itemId, itemId), inArray(runs.status, ['queued', 'running'])))
    .get();
}

export function listRuns(f: { projectId?: string; itemId?: string; status?: RunStatus[]; limit?: number }): Run[] {
  const where = [];
  if (f.projectId) where.push(eq(runs.projectId, f.projectId));
  if (f.itemId) where.push(eq(runs.itemId, f.itemId));
  if (f.status?.length) where.push(inArray(runs.status, f.status));
  return db
    .select()
    .from(runs)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(runs.createdAt))
    .limit(f.limit ?? 50)
    .all()
    .map(runToDto);
}

/** API shape of a run, including why it's waiting if it is queued. */
export function runToDto(row: RunRow): Run {
  return toRun(row, waiting.get(row.id) ?? null);
}

export function getRun(id: string): Run & { prompt: string } {
  const row = getRunRow(id);
  return { ...runToDto(row), prompt: row.prompt };
}

export function getRunEvents(runId: string, afterSeq = 0): RunEvent[] {
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
    .orderBy(asc(runEvents.seq))
    .all()
    .map((e) => ({ ...e, data: e.data ?? null }));
}

/** Resume sequence numbers when appending to an existing run (e.g. post-run steps). */
export function primeSeq(runId: string): void {
  const last = db.select({ seq: runEvents.seq }).from(runEvents).where(eq(runEvents.runId, runId)).orderBy(desc(runEvents.seq)).limit(1).get();
  seqs.set(runId, last?.seq ?? 0);
}

export function queueSnapshot(): { running: string[]; queued: string[] } {
  return { running: [...active.keys()], queued: queue.map((q) => q.runId) };
}

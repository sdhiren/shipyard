import type { Run, RunEvent, RunEventType, RunKind, RunStatus } from '@shipyard/shared';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runEvents, runs, type RunRow } from '../db/schema.js';
import { bus } from '../lib/events.js';
import { conflict, newId, notFound, now } from '../lib/util.js';
import { toRun } from './mappers.js';
import { getSettings } from './settings.js';

/**
 * A small persistent job queue for Claude runs. Run rows and their event logs
 * live in SQLite; the work itself is an in-process closure, so runs that were
 * mid-flight when the server stopped are marked failed on boot.
 */

export interface RunContext {
  runId: string;
  signal: AbortSignal;
  emit: (type: RunEventType, text: string, data?: unknown) => void;
  update: (patch: Partial<RunRow>) => void;
}

type Task = (ctx: RunContext) => Promise<{ status: RunStatus; summary?: string | null; error?: string | null }>;

interface Pending {
  runId: string;
  task: Task;
}

const queue: Pending[] = [];
const active = new Map<string, AbortController>();
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

export function enqueue(runId: string, task: Task): void {
  queue.push({ runId, task });
  emit(runId, 'status', 'Queued');
  pump();
}

function pump(): void {
  const limit = getSettings().maxConcurrentRuns;
  while (active.size < limit && queue.length > 0) {
    const next = queue.shift()!;
    void execute(next);
  }
}

async function execute({ runId, task }: Pending): Promise<void> {
  const controller = new AbortController();
  active.set(runId, controller);
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
    seqs.delete(runId);
    pump();
  }
}

export function cancelRun(id: string): Run {
  const row = getRunRow(id);
  const idx = queue.findIndex((q) => q.runId === id);
  if (idx >= 0) {
    queue.splice(idx, 1);
    emit(id, 'status', 'Cancelled before it started');
    return toRun(updateRun(id, { status: 'cancelled', finishedAt: now() }));
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
    .map(toRun);
}

export function getRun(id: string): Run & { prompt: string } {
  const row = getRunRow(id);
  return { ...toRun(row), prompt: row.prompt };
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

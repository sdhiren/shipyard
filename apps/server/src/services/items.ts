import {
  ACTIVE_RUN_STATUSES,
  createItemSchema,
  STATUS_LABELS,
  updateItemSchema,
  type BacklogItem,
  type CreateItemInput,
  type DecisionInput,
  type ItemStatus,
  type ItemType,
  type UpdateItemInput,
} from '@shipyard/shared';
import { and, asc, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { items, projects, runs, type ItemRow } from '../db/schema.js';
import { bus } from '../lib/events.js';
import { badRequest, conflict, newId, notFound, now } from '../lib/util.js';
import { logActivity } from './activity.js';
import { toItem } from './mappers.js';

function keyPrefix(projectId: string): string {
  const p = db.select({ keyPrefix: projects.keyPrefix }).from(projects).where(eq(projects.id, projectId)).get();
  if (!p) throw notFound('Project');
  return p.keyPrefix;
}

export function getItemRow(id: string): ItemRow {
  const row = db.select().from(items).where(eq(items.id, id)).get();
  if (!row) throw notFound('Item');
  return row;
}

export function getItem(id: string): BacklogItem {
  const row = getItemRow(id);
  return toItem(row, keyPrefix(row.projectId));
}

export function itemKey(row: ItemRow): string {
  return `${keyPrefix(row.projectId)}-${row.number}`;
}

export interface ItemFilters {
  status?: ItemStatus[];
  type?: ItemType[];
  q?: string;
  includeSnoozed?: boolean;
}

export function listItems(projectId: string, f: ItemFilters = {}): BacklogItem[] {
  const prefix = keyPrefix(projectId);
  const where = [eq(items.projectId, projectId)];
  if (f.status?.length) where.push(inArray(items.status, f.status));
  if (f.type?.length) where.push(inArray(items.type, f.type));
  if (f.q) {
    const q = `%${f.q}%`;
    const num = f.q.match(/(\d+)$/)?.[1];
    where.push(or(like(items.title, q), like(items.description, q), num ? eq(items.number, Number(num)) : undefined)!);
  }
  const rows = db
    .select()
    .from(items)
    .where(and(...where))
    .orderBy(asc(items.position), desc(items.createdAt))
    .all();
  const nowIso = now();
  return rows.filter((r) => f.includeSnoozed || !r.snoozedUntil || r.snoozedUntil <= nowIso).map((r) => toItem(r, prefix));
}

/** Allocate the next per-project item number atomically. */
function nextNumber(projectId: string): number {
  const row = db
    .update(projects)
    .set({ nextItemNumber: sql`${projects.nextItemNumber} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ n: projects.nextItemNumber })
    .get();
  if (!row) throw notFound('Project');
  return row.n - 1;
}

function bottomPosition(projectId: string, status: ItemStatus): number {
  const row = db
    .select({ max: sql<number | null>`max(${items.position})` })
    .from(items)
    .where(and(eq(items.projectId, projectId), eq(items.status, status)))
    .get();
  return (row?.max ?? 0) + 1000;
}

export function createItem(
  projectId: string,
  input: CreateItemInput,
  extra: {
    sourceRef?: string;
    rationale?: string;
    affectedFiles?: string[];
    analysisId?: string;
    silent?: boolean;
  } = {},
): BacklogItem {
  const data = createItemSchema.parse(input);
  const ts = now();
  const row: ItemRow = {
    id: newId('itm'),
    projectId,
    number: nextNumber(projectId),
    title: data.title.trim(),
    description: data.description,
    type: data.type,
    status: data.status,
    priority: data.priority,
    effort: data.effort,
    impact: data.impact,
    tags: data.tags,
    acceptanceCriteria: data.acceptanceCriteria,
    source: data.source,
    sourceRef: extra.sourceRef ?? null,
    rationale: extra.rationale ?? null,
    affectedFiles: extra.affectedFiles ?? [],
    analysisId: extra.analysisId ?? null,
    plan: null,
    position: bottomPosition(projectId, data.status),
    snoozedUntil: null,
    dueDate: data.dueDate ?? null,
    decisionReason: null,
    branch: null,
    worktreePath: null,
    lastRunId: null,
    sessionId: null,
    totalCostUsd: 0,
    prNumber: null,
    prUrl: null,
    prState: null,
    prIsDraft: null,
    prReviewDecision: null,
    prChecks: null,
    prAdditions: null,
    prDeletions: null,
    prChangedFiles: null,
    prMergedAt: null,
    prMergeable: null,
    prMergeState: null,
    prSyncedAt: null,
    createdAt: ts,
    updatedAt: ts,
    startedAt: null,
    completedAt: null,
  };
  db.insert(items).values(row).run();
  if (!extra.silent) {
    logActivity({ projectId, itemId: row.id, kind: 'created', message: `Created “${row.title}”`, meta: { source: row.source } });
    bus.publish({ type: 'items.changed', projectId });
  }
  return toItem(row, keyPrefix(projectId));
}

/** Low-level patch used by every service; records status transitions in the timeline. */
export function patchItem(id: string, patch: Partial<ItemRow>, reason?: string): BacklogItem {
  const before = getItemRow(id);
  const ts = now();
  const next: Partial<ItemRow> = { ...patch, updatedAt: ts };
  if (patch.status && patch.status !== before.status) {
    if (patch.status === 'in_progress' && !before.startedAt) next.startedAt = ts;
    if (patch.status === 'done') next.completedAt = ts;
    if (before.status === 'done' && patch.status !== 'done') next.completedAt = null;
    if (patch.position === undefined) next.position = bottomPosition(before.projectId, patch.status);
  }
  db.update(items).set(next).where(eq(items.id, id)).run();
  if (patch.status && patch.status !== before.status) {
    logActivity({
      projectId: before.projectId,
      itemId: id,
      kind: 'status_changed',
      message: `${STATUS_LABELS[before.status]} → ${STATUS_LABELS[patch.status]}${reason ? `: ${reason}` : ''}`,
      meta: { from: before.status, to: patch.status },
    });
  }
  bus.publish({ type: 'item.changed', projectId: before.projectId, itemId: id });
  return getItem(id);
}

export function updateItem(id: string, input: UpdateItemInput): BacklogItem {
  const data = updateItemSchema.parse(input);
  const before = getItemRow(id);
  const item = patchItem(id, data as Partial<ItemRow>);
  const changed = Object.keys(data).filter((k) => !['status', 'position'].includes(k));
  if (changed.length) {
    logActivity({ projectId: before.projectId, itemId: id, kind: 'updated', message: `Edited ${changed.join(', ')}` });
  }
  return item;
}

/** Drag-and-drop on the board: change column and/or order. */
export function moveItem(id: string, status: ItemStatus, position: number): BacklogItem {
  return patchItem(id, { status, position });
}

function hasActiveRun(itemId: string): boolean {
  return !!db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.itemId, itemId), inArray(runs.status, ACTIVE_RUN_STATUSES)))
    .get();
}

/**
 * Apply a pure state decision. `implement` and `plan` start Claude runs and are
 * handled by the agent service; they are rejected here.
 */
export function decide(id: string, input: DecisionInput): BacklogItem {
  const row = getItemRow(id);
  const reason = input.reason?.trim() || undefined;
  switch (input.decision) {
    case 'approve':
      return patchItem(id, { status: 'backlog', decisionReason: reason ?? null }, reason);
    case 'reject':
      return patchItem(id, { status: 'rejected', decisionReason: reason ?? null }, reason);
    case 'up_next':
      return patchItem(id, { status: 'planned' }, reason);
    case 'skip':
      if (hasActiveRun(id)) throw conflict('Cancel the active run first');
      return patchItem(id, { status: 'skipped', decisionReason: reason ?? null }, reason);
    case 'snooze': {
      if (!input.until) throw badRequest('`until` is required to snooze');
      const until = new Date(input.until).toISOString();
      logActivity({ projectId: row.projectId, itemId: id, kind: 'updated', message: `Snoozed until ${until.slice(0, 10)}` });
      return patchItem(id, { snoozedUntil: until, status: row.status === 'proposed' ? 'backlog' : row.status });
    }
    case 'archive':
      if (hasActiveRun(id)) throw conflict('Cancel the active run first');
      return patchItem(id, { status: 'archived', decisionReason: reason ?? null }, reason);
    case 'restore':
      return patchItem(id, { status: 'backlog', snoozedUntil: null }, reason);
    case 'done':
      return patchItem(id, { status: 'done' }, reason);
    default:
      throw badRequest(`Decision "${input.decision}" must go through the agent endpoints`);
  }
}

/** Permanently delete. Only allowed from archived / rejected / skipped to avoid accidents. */
export function hardDelete(id: string): void {
  const row = getItemRow(id);
  if (!['archived', 'rejected', 'skipped', 'proposed'].includes(row.status)) {
    throw conflict('Archive the item before deleting it permanently');
  }
  if (hasActiveRun(id)) throw conflict('Cancel the active run first');
  db.delete(items).where(eq(items.id, id)).run();
  bus.publish({ type: 'items.changed', projectId: row.projectId });
}

export function addNote(id: string, body: string): void {
  const row = getItemRow(id);
  logActivity({ projectId: row.projectId, itemId: id, kind: 'note', message: body });
}

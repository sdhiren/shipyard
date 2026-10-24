import type { Activity, ActivityKind } from '@shipyard/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activity, items, projects } from '../db/schema.js';
import { bus } from '../lib/events.js';
import { newId, now } from '../lib/util.js';
import { toActivity } from './mappers.js';

export function logActivity(input: {
  projectId: string;
  itemId?: string | null;
  kind: ActivityKind;
  message: string;
  meta?: Record<string, unknown>;
}): void {
  const row = {
    id: newId('act'),
    projectId: input.projectId,
    itemId: input.itemId ?? null,
    kind: input.kind,
    message: input.message,
    meta: input.meta ?? null,
    createdAt: now(),
  };
  db.insert(activity).values(row).run();
  bus.publish({ type: 'activity', activity: toActivity(row) });
}

/** Recent activity with item keys/titles and project names joined in. */
export function listActivity(opts: { projectId?: string; itemId?: string; limit?: number }): Activity[] {
  const where = [];
  if (opts.projectId) where.push(eq(activity.projectId, opts.projectId));
  if (opts.itemId) where.push(eq(activity.itemId, opts.itemId));
  const rows = db
    .select()
    .from(activity)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(activity.createdAt))
    .limit(opts.limit ?? 50)
    .all();

  const itemIds = [...new Set(rows.map((r) => r.itemId).filter((x): x is string => !!x))];
  const itemRows = itemIds.length
    ? db.select({ id: items.id, number: items.number, title: items.title, projectId: items.projectId }).from(items).where(inArray(items.id, itemIds)).all()
    : [];
  const projectRows = db.select({ id: projects.id, name: projects.name, keyPrefix: projects.keyPrefix }).from(projects).all();
  const pMap = new Map(projectRows.map((p) => [p.id, p]));
  const iMap = new Map(itemRows.map((i) => [i.id, i]));

  return rows.map((r) => {
    const it = r.itemId ? iMap.get(r.itemId) : undefined;
    const p = pMap.get(r.projectId);
    return toActivity(r, {
      itemKey: it && p ? `${p.keyPrefix}-${it.number}` : null,
      itemTitle: it?.title ?? null,
      projectName: p?.name ?? null,
    });
  });
}

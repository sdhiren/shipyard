import { ACTIVE_RUN_STATUSES, type DashboardSummary } from '@shipyard/shared';
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { items, projects, runs } from '../db/schema.js';
import { listActivity } from './activity.js';
import { toItem, toRun } from './mappers.js';

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Monday-based ISO week label, e.g. "2026-10-19". */
function weekStart(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export function getDashboard(): DashboardSummary {
  const projectRows = db.select().from(projects).where(eq(projects.archived, false)).all();
  const pMap = new Map(projectRows.map((p) => [p.id, p]));
  const projectIds = projectRows.map((p) => p.id);
  const inProjects = projectIds.length ? inArray(items.projectId, projectIds) : sql`0`;

  const statusCounts = db
    .select({ status: items.status, n: sql<number>`count(*)` })
    .from(items)
    .where(inProjects)
    .groupBy(items.status)
    .all();
  const c = (s: string) => statusCounts.find((x) => x.status === s)?.n ?? 0;

  const doneThisWeek =
    db
      .select({ n: sql<number>`count(*)` })
      .from(items)
      .where(and(inProjects, eq(items.status, 'done'), gte(items.completedAt, isoDaysAgo(7))))
      .get()?.n ?? 0;

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const spend =
    db
      .select({ s: sql<number>`coalesce(sum(${runs.costUsd}), 0)` })
      .from(runs)
      .where(gte(runs.createdAt, monthStart.toISOString()))
      .get()?.s ?? 0;

  const activeRunRows = db.select().from(runs).where(inArray(runs.status, ACTIVE_RUN_STATUSES)).orderBy(asc(runs.createdAt)).all();
  const runItemIds = activeRunRows.map((r) => r.itemId).filter((x): x is string => !!x);
  const runItems = runItemIds.length ? db.select().from(items).where(inArray(items.id, runItemIds)).all() : [];

  const withProject = <T extends { projectId: string }>(row: T) => pMap.get(row.projectId);

  const openPrRows = db
    .select()
    .from(items)
    .where(and(inProjects, isNotNull(items.prNumber), eq(items.prState, 'OPEN')))
    .orderBy(desc(items.updatedAt))
    .limit(20)
    .all();
  const upNextRows = db
    .select()
    .from(items)
    .where(and(inProjects, eq(items.status, 'planned')))
    .orderBy(asc(items.position))
    .limit(12)
    .all();

  // 8 weeks of created vs completed.
  const since = isoDaysAgo(56);
  const created = db.select({ at: items.createdAt }).from(items).where(and(inProjects, gte(items.createdAt, since))).all();
  const completed = db.select({ at: items.completedAt }).from(items).where(and(inProjects, gte(items.completedAt, since))).all();
  const weeks = new Map<string, { created: number; completed: number }>();
  for (let i = 7; i >= 0; i--) weeks.set(weekStart(isoDaysAgo(i * 7)), { created: 0, completed: 0 });
  for (const r of created) {
    const w = weeks.get(weekStart(r.at));
    if (w) w.created++;
  }
  for (const r of completed) {
    const w = r.at ? weeks.get(weekStart(r.at)) : undefined;
    if (w) w.completed++;
  }

  return {
    totals: {
      projects: projectRows.length,
      inbox: c('proposed'),
      open: c('backlog') + c('planned') + c('in_progress') + c('in_review'),
      inProgress: c('in_progress'),
      inReview: c('in_review'),
      doneThisWeek,
      activeRuns: activeRunRows.length,
      spendThisMonthUsd: Math.round(spend * 100) / 100,
    },
    activeRuns: activeRunRows.map((r) => {
      const it = runItems.find((i) => i.id === r.itemId);
      const p = pMap.get(r.projectId);
      return {
        ...toRun(r),
        itemKey: it && p ? `${p.keyPrefix}-${it.number}` : null,
        itemTitle: it?.title ?? null,
        projectName: p?.name ?? '',
      };
    }),
    openPrs: openPrRows.map((r) => ({ ...toItem(r, withProject(r)!.keyPrefix), projectName: withProject(r)!.name })),
    upNext: upNextRows.map((r) => ({ ...toItem(r, withProject(r)!.keyPrefix), projectName: withProject(r)!.name })),
    recentActivity: listActivity({ limit: 25 }),
    throughput: [...weeks.entries()].map(([week, v]) => ({ week, ...v })),
  };
}

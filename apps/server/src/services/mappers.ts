import { EFFORT_POINTS, type Activity, type Analysis, type BacklogItem, type Project, type Run } from '@shipyard/shared';
import type { ActivityRow, AnalysisRow, ItemRow, ProjectRow, RunRow } from '../db/schema.js';

/** Row → API DTO conversions. Keep DB-only columns out of the API surface. */

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    path: row.path,
    description: row.description,
    color: row.color,
    pinned: row.pinned,
    archived: row.archived,
    stack: row.stack,
    git: row.git,
    settings: row.settings,
    health: row.health ?? null,
    lastAnalyzedAt: row.lastAnalyzedAt,
    lastScannedAt: row.lastScannedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function itemScore(row: Pick<ItemRow, 'impact' | 'effort'>): number | null {
  if (!row.impact || !row.effort) return null;
  return Math.round((row.impact / EFFORT_POINTS[row.effort]) * 100) / 100;
}

export function toItem(row: ItemRow, keyPrefix: string): BacklogItem {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    key: `${keyPrefix}-${row.number}`,
    title: row.title,
    description: row.description,
    type: row.type,
    status: row.status,
    priority: row.priority,
    effort: row.effort,
    impact: row.impact,
    score: itemScore(row),
    tags: row.tags,
    acceptanceCriteria: row.acceptanceCriteria,
    source: row.source,
    sourceRef: row.sourceRef,
    rationale: row.rationale,
    affectedFiles: row.affectedFiles,
    analysisId: row.analysisId,
    plan: row.plan,
    position: row.position,
    snoozedUntil: row.snoozedUntil,
    dueDate: row.dueDate,
    branch: row.branch,
    worktreePath: row.worktreePath,
    pr:
      row.prNumber && row.prUrl
        ? {
            number: row.prNumber,
            url: row.prUrl,
            state: row.prState ?? 'OPEN',
            isDraft: row.prIsDraft ?? false,
            reviewDecision: row.prReviewDecision,
            checks: row.prChecks ?? 'none',
            additions: row.prAdditions,
            deletions: row.prDeletions,
            changedFiles: row.prChangedFiles,
            mergedAt: row.prMergedAt,
            lastSyncedAt: row.prSyncedAt,
            mergeable: row.prMergeable,
            mergeState: row.prMergeState,
            needsRebase: row.prState === 'OPEN' && (row.prMergeable === 'CONFLICTING' || row.prMergeState === 'DIRTY'),
            behindBase: row.prState === 'OPEN' && row.prMergeState === 'BEHIND',
          }
        : null,
    lastRunId: row.lastRunId,
    totalCostUsd: row.totalCostUsd,
    decisionReason: row.decisionReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

export function toRun(row: RunRow, waitingReason: string | null = null): Run {
  return {
    id: row.id,
    projectId: row.projectId,
    itemId: row.itemId,
    analysisId: row.analysisId,
    kind: row.kind,
    status: row.status,
    model: row.model,
    sessionId: row.sessionId,
    cwd: row.cwd,
    branch: row.branch,
    summary: row.summary,
    error: row.error,
    costUsd: row.costUsd,
    durationMs: row.durationMs,
    numTurns: row.numTurns,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    waitingReason: row.status === 'queued' ? waitingReason : null,
  };
}

export function toAnalysis(row: AnalysisRow): Analysis {
  return {
    id: row.id,
    projectId: row.projectId,
    runId: row.runId,
    focus: row.focus,
    guidance: row.guidance,
    status: row.status,
    summary: row.summary,
    strengths: row.strengths,
    risks: row.risks,
    health: row.health ?? null,
    suggestionCount: row.suggestionCount,
    costUsd: row.costUsd,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

export function toActivity(row: ActivityRow, extra?: Partial<Activity>): Activity {
  return {
    id: row.id,
    projectId: row.projectId,
    itemId: row.itemId,
    kind: row.kind,
    message: row.message,
    meta: row.meta ?? null,
    createdAt: row.createdAt,
    ...extra,
  };
}

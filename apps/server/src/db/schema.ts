import type {
  ActivityKind,
  AnalysisFocus,
  ChecksState,
  CommentAuthor,
  CommentKind,
  Effort,
  GitInfo,
  HealthScores,
  ItemSource,
  ItemStatus,
  ItemType,
  MergeableState,
  PrState,
  Priority,
  ProjectSettings,
  ProjectStack,
  RunEventType,
  RunKind,
  RunStatus,
} from '@shipyard/shared';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const timestamps = {
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
};

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  /** Short uppercase prefix for item keys, e.g. "URL" → URL-12. */
  keyPrefix: text('key_prefix').notNull(),
  path: text('path').notNull().unique(),
  description: text('description').notNull().default(''),
  color: text('color').notNull(),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  stack: text('stack', { mode: 'json' }).$type<ProjectStack>().notNull(),
  git: text('git', { mode: 'json' }).$type<GitInfo>().notNull(),
  settings: text('settings', { mode: 'json' }).$type<ProjectSettings>().notNull(),
  health: text('health', { mode: 'json' }).$type<HealthScores | null>(),
  nextItemNumber: integer('next_item_number').notNull().default(1),
  lastAnalyzedAt: text('last_analyzed_at'),
  lastScannedAt: text('last_scanned_at'),
  ...timestamps,
});

export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    type: text('type').$type<ItemType>().notNull(),
    status: text('status').$type<ItemStatus>().notNull(),
    priority: text('priority').$type<Priority>().notNull(),
    effort: text('effort').$type<Effort>(),
    impact: integer('impact'),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    acceptanceCriteria: text('acceptance_criteria', { mode: 'json' }).$type<string[]>().notNull().default([]),
    source: text('source').$type<ItemSource>().notNull(),
    /** Where an imported item came from, e.g. "BACKLOG.md:14" or "src/app.ts:88". */
    sourceRef: text('source_ref'),
    rationale: text('rationale'),
    affectedFiles: text('affected_files', { mode: 'json' }).$type<string[]>().notNull().default([]),
    analysisId: text('analysis_id'),
    plan: text('plan'),
    openQuestions: text('open_questions', { mode: 'json' }).$type<string[]>().notNull().default([]),
    position: real('position').notNull().default(0),
    snoozedUntil: text('snoozed_until'),
    dueDate: text('due_date'),
    decisionReason: text('decision_reason'),
    // Delivery
    branch: text('branch'),
    worktreePath: text('worktree_path'),
    lastRunId: text('last_run_id'),
    sessionId: text('session_id'),
    totalCostUsd: real('total_cost_usd').notNull().default(0),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    prState: text('pr_state').$type<PrState>(),
    prIsDraft: integer('pr_is_draft', { mode: 'boolean' }),
    prReviewDecision: text('pr_review_decision'),
    prChecks: text('pr_checks').$type<ChecksState>(),
    prAdditions: integer('pr_additions'),
    prDeletions: integer('pr_deletions'),
    prChangedFiles: integer('pr_changed_files'),
    prMergedAt: text('pr_merged_at'),
    prMergeable: text('pr_mergeable').$type<MergeableState>(),
    prMergeState: text('pr_merge_state'),
    prSyncedAt: text('pr_synced_at'),
    ...timestamps,
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
  },
  (t) => [
    index('items_project_status_idx').on(t.projectId, t.status),
    uniqueIndex('items_project_number_idx').on(t.projectId, t.number),
  ],
);

export const analyses = sqliteTable('analyses', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id'),
  focus: text('focus', { mode: 'json' }).$type<AnalysisFocus[]>().notNull(),
  guidance: text('guidance').notNull().default(''),
  count: integer('count').notNull(),
  status: text('status').$type<RunStatus>().notNull(),
  summary: text('summary'),
  strengths: text('strengths', { mode: 'json' }).$type<string[]>().notNull().default([]),
  risks: text('risks', { mode: 'json' }).$type<string[]>().notNull().default([]),
  health: text('health', { mode: 'json' }).$type<HealthScores | null>(),
  suggestionCount: integer('suggestion_count').notNull().default(0),
  costUsd: real('cost_usd'),
  createdAt: text('created_at').notNull(),
  finishedAt: text('finished_at'),
});

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    itemId: text('item_id'),
    analysisId: text('analysis_id'),
    kind: text('kind').$type<RunKind>().notNull(),
    status: text('status').$type<RunStatus>().notNull(),
    model: text('model').notNull(),
    prompt: text('prompt').notNull(),
    sessionId: text('session_id'),
    cwd: text('cwd').notNull(),
    branch: text('branch'),
    summary: text('summary'),
    error: text('error'),
    costUsd: real('cost_usd'),
    durationMs: integer('duration_ms'),
    numTurns: integer('num_turns'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [index('runs_item_idx').on(t.itemId), index('runs_status_idx').on(t.status)],
);

export const runEvents = sqliteTable(
  'run_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').$type<RunEventType>().notNull(),
    text: text('text').notNull(),
    data: text('data', { mode: 'json' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('run_events_run_idx').on(t.runId, t.seq)],
);

export const activity = sqliteTable(
  'activity',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    itemId: text('item_id'),
    kind: text('kind').$type<ActivityKind>().notNull(),
    message: text('message').notNull(),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('activity_project_idx').on(t.projectId, t.createdAt), index('activity_item_idx').on(t.itemId)],
);

/** The item's discussion thread: the owner's comments and Claude's replies. */
export const comments = sqliteTable(
  'comments',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    author: text('author').$type<CommentAuthor>().notNull(),
    kind: text('kind').$type<CommentKind>().notNull(),
    body: text('body').notNull(),
    planUpdated: integer('plan_updated', { mode: 'boolean' }).notNull().default(false),
    runId: text('run_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('comments_item_idx').on(t.itemId, t.createdAt)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
});

export type ProjectRow = typeof projects.$inferSelect;
export type ItemRow = typeof items.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type AnalysisRow = typeof analyses.$inferSelect;
export type ActivityRow = typeof activity.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;

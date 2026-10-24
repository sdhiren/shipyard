/**
 * Domain vocabulary shared by the server and the web app.
 * Keep these lists ordered: the UI renders them in this order.
 */

export const ITEM_STATUSES = [
  'proposed', // AI suggestion or import waiting in the Inbox for approval
  'backlog', // accepted, not yet scheduled
  'planned', // "up next" – chosen to implement
  'in_progress', // a Claude run is (or was last) working on it
  'in_review', // a branch / PR exists and awaits review
  'done', // PR merged or manually completed
  'skipped', // consciously decided not to do (kept for history)
  'rejected', // suggestion rejected from the Inbox
  'archived', // soft-deleted
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Columns shown on the Kanban board. */
export const BOARD_STATUSES: ItemStatus[] = ['backlog', 'planned', 'in_progress', 'in_review', 'done'];
/** Statuses that count as "open work". */
export const OPEN_STATUSES: ItemStatus[] = ['backlog', 'planned', 'in_progress', 'in_review'];

export const STATUS_LABELS: Record<ItemStatus, string> = {
  proposed: 'Inbox',
  backlog: 'Backlog',
  planned: 'Up next',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  skipped: 'Skipped',
  rejected: 'Rejected',
  archived: 'Archived',
};

export const ITEM_TYPES = ['feature', 'improvement', 'bug', 'tech_debt', 'performance', 'security', 'testing', 'docs', 'dx'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const TYPE_LABELS: Record<ItemType, string> = {
  feature: 'Feature',
  improvement: 'Improvement',
  bug: 'Bug',
  tech_debt: 'Tech debt',
  performance: 'Performance',
  security: 'Security',
  testing: 'Testing',
  docs: 'Docs',
  dx: 'Dev experience',
};

export const PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = { p0: 'Urgent', p1: 'High', p2: 'Medium', p3: 'Low' };

export const EFFORTS = ['xs', 's', 'm', 'l', 'xl'] as const;
export type Effort = (typeof EFFORTS)[number];
/** Rough story-point weight per effort size; used for impact/effort scoring. */
export const EFFORT_POINTS: Record<Effort, number> = { xs: 1, s: 2, m: 3, l: 5, xl: 8 };

export const ITEM_SOURCES = ['manual', 'ai', 'backlog_file', 'todo_comment', 'github_issue'] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];

export const RUN_KINDS = ['analyze', 'plan', 'implement', 'revise'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ACTIVE_RUN_STATUSES: RunStatus[] = ['queued', 'running'];

export const ANALYSIS_FOCUS = [
  'features',
  'ux',
  'performance',
  'security',
  'tech_debt',
  'testing',
  'dx',
  'observability',
] as const;
export type AnalysisFocus = (typeof ANALYSIS_FOCUS)[number];
export const FOCUS_LABELS: Record<AnalysisFocus, string> = {
  features: 'New features',
  ux: 'UX polish',
  performance: 'Performance',
  security: 'Security',
  tech_debt: 'Tech debt & refactors',
  testing: 'Test coverage',
  dx: 'Developer experience',
  observability: 'Logging & observability',
};

export const PR_STATES = ['OPEN', 'CLOSED', 'MERGED'] as const;
export type PrState = (typeof PR_STATES)[number];

export const CHECKS_STATES = ['pending', 'passing', 'failing', 'none'] as const;
export type ChecksState = (typeof CHECKS_STATES)[number];

/**
 * How much freedom Claude gets when implementing inside a worktree.
 *  - guarded: file edits + the project's allow-listed shell commands only
 *  - full:    bypass permission prompts (worktree is isolated, but commands are unrestricted)
 */
export const AUTONOMY_LEVELS = ['guarded', 'full'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const ACTIVITY_KINDS = [
  'created',
  'status_changed',
  'updated',
  'note',
  'run_started',
  'run_finished',
  'pr_opened',
  'pr_updated',
  'pr_merged',
  'plan_ready',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

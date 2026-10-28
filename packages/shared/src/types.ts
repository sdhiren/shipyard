import type {
  ActivityKind,
  AnalysisFocus,
  ChecksState,
  Effort,
  ItemSource,
  ItemStatus,
  ItemType,
  MergeableState,
  PrState,
  Priority,
  RunKind,
  RunStatus,
} from './constants.js';
import type { HealthScores, ProjectSettings } from './schemas.js';

/** Facts detected from the repository on disk. */
export interface ProjectStack {
  languages: string[];
  frameworks: string[];
  packageManagers: string[];
  hasTests: boolean;
  hasCi: boolean;
  hasDocker: boolean;
  /** Files Claude should read first (README, CLAUDE.md, BACKLOG.md…). */
  keyFiles: string[];
}

export interface GitInfo {
  isRepo: boolean;
  remoteUrl: string | null;
  /** "owner/name" when the remote is on GitHub. */
  githubRepo: string | null;
  defaultBranch: string | null;
  currentBranch: string | null;
  dirty: boolean;
  lastCommitAt: string | null;
  lastCommitMessage: string | null;
  commitCount: number;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  path: string;
  description: string;
  color: string;
  pinned: boolean;
  archived: boolean;
  stack: ProjectStack;
  git: GitInfo;
  settings: ProjectSettings;
  health: HealthScores | null;
  lastAnalyzedAt: string | null;
  lastScannedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWithStats extends Project {
  stats: {
    inbox: number;
    open: number;
    inProgress: number;
    inReview: number;
    done: number;
    activeRuns: number;
  };
}

export interface BacklogItem {
  id: string;
  projectId: string;
  /** Human-friendly per-project number, rendered as e.g. URL-12. */
  number: number;
  key: string;
  title: string;
  description: string;
  type: ItemType;
  status: ItemStatus;
  priority: Priority;
  effort: Effort | null;
  impact: number | null;
  /** impact / effort points – higher is a better bet. */
  score: number | null;
  tags: string[];
  acceptanceCriteria: string[];
  source: ItemSource;
  sourceRef: string | null;
  rationale: string | null;
  affectedFiles: string[];
  analysisId: string | null;
  plan: string | null;
  position: number;
  snoozedUntil: string | null;
  dueDate: string | null;
  branch: string | null;
  worktreePath: string | null;
  pr: PullRequestInfo | null;
  lastRunId: string | null;
  totalCostUsd: number;
  decisionReason: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  state: PrState;
  isDraft: boolean;
  reviewDecision: string | null;
  checks: ChecksState;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  mergedAt: string | null;
  lastSyncedAt: string | null;
  /** GitHub's view of whether the PR can merge; UNKNOWN while it recalculates. */
  mergeable: MergeableState | null;
  /** GitHub mergeStateStatus, e.g. CLEAN, DIRTY (conflicts), BEHIND, BLOCKED. */
  mergeState: string | null;
  /** The PR conflicts with its base branch and must be rebased. */
  needsRebase: boolean;
  /** Mergeable, but the base has moved on and branch protection wants it updated. */
  behindBase: boolean;
}

export interface Run {
  id: string;
  projectId: string;
  itemId: string | null;
  analysisId: string | null;
  kind: RunKind;
  status: RunStatus;
  model: string;
  sessionId: string | null;
  cwd: string;
  branch: string | null;
  summary: string | null;
  error: string | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Why a queued run hasn't started yet (e.g. waiting for another item in the same repo). */
  waitingReason: string | null;
}

export type RunEventType = 'system' | 'text' | 'tool_use' | 'tool_result' | 'status' | 'stderr' | 'result' | 'step';

export interface RunEvent {
  id: number;
  runId: string;
  seq: number;
  type: RunEventType;
  /** Short human-readable line for the log view. */
  text: string;
  data: unknown;
  createdAt: string;
}

export interface Analysis {
  id: string;
  projectId: string;
  runId: string | null;
  focus: AnalysisFocus[];
  guidance: string;
  status: RunStatus;
  summary: string | null;
  strengths: string[];
  risks: string[];
  health: HealthScores | null;
  suggestionCount: number;
  costUsd: number | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface Activity {
  id: string;
  projectId: string;
  itemId: string | null;
  kind: ActivityKind;
  message: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
  /** Joined for convenience in feeds. */
  itemKey?: string | null;
  itemTitle?: string | null;
  projectName?: string | null;
}

export interface DashboardSummary {
  totals: {
    projects: number;
    inbox: number;
    open: number;
    inProgress: number;
    inReview: number;
    doneThisWeek: number;
    activeRuns: number;
    spendThisMonthUsd: number;
  };
  activeRuns: (Run & { itemKey: string | null; itemTitle: string | null; projectName: string })[];
  openPrs: (BacklogItem & { projectName: string })[];
  upNext: (BacklogItem & { projectName: string })[];
  recentActivity: Activity[];
  throughput: { week: string; created: number; completed: number }[];
}

export interface ImportCandidate {
  title: string;
  description: string;
  source: ItemSource;
  sourceRef: string;
  type: ItemType;
  alreadyImported: boolean;
}

export interface DiscoveredRepo {
  path: string;
  name: string;
  remoteUrl: string | null;
  alreadyAdded: boolean;
}

/** Server-sent events pushed to every connected browser. */
export type LiveEvent =
  | { type: 'item.changed'; projectId: string; itemId: string }
  | { type: 'items.changed'; projectId: string }
  | { type: 'project.changed'; projectId: string }
  | { type: 'run.changed'; runId: string; projectId: string; itemId: string | null; status: RunStatus }
  | { type: 'run.event'; runId: string; event: RunEvent }
  | { type: 'analysis.changed'; analysisId: string; projectId: string }
  | { type: 'activity'; activity: Activity };

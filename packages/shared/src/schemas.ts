import { z } from 'zod';
import {
  ANALYSIS_FOCUS,
  AUTONOMY_LEVELS,
  EFFORTS,
  ITEM_SOURCES,
  ITEM_STATUSES,
  ITEM_TYPES,
  PRIORITIES,
} from './constants.js';

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/**
 * Field definitions without defaults. Zod 4's `.partial()` still applies
 * `.default()` values, so patch schemas are built from these bare shapes and
 * only the create/full schemas add defaults. Otherwise a PATCH of one field
 * would silently reset every other field.
 */
const settingsFields = {
  /** Claude model alias or id passed to `claude --model`. */
  model: z.string().min(1),
  /** Effort passed to `claude --effort`. */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  autonomy: z.enum(AUTONOMY_LEVELS),
  /** Extra tool rules for guarded mode, e.g. "Bash(npm test*)". */
  allowedTools: z.array(z.string()),
  /** Shell command Claude should run to verify its work, e.g. "npm test". */
  testCommand: z.string(),
  /** Push and open a PR automatically when an implementation run succeeds. */
  autoPr: z.boolean(),
  /** Open PRs as drafts. */
  draftPr: z.boolean(),
  branchPrefix: z.string(),
  /** Hard cap per Claude run (USD). 0 = no cap. */
  maxBudgetUsd: z.number().min(0),
  /** Extra guidance appended to every prompt for this project. */
  customInstructions: z.string(),
  /** Delete the worktree once the PR merges. */
  cleanupWorktreeOnMerge: z.boolean(),
};

export const projectSettingsSchema = z.object({
  model: settingsFields.model.default('opus'),
  effort: settingsFields.effort.default('high'),
  autonomy: settingsFields.autonomy.default('guarded'),
  allowedTools: settingsFields.allowedTools.default([]),
  testCommand: settingsFields.testCommand.default(''),
  autoPr: settingsFields.autoPr.default(true),
  draftPr: settingsFields.draftPr.default(false),
  branchPrefix: settingsFields.branchPrefix.default('shipyard/'),
  maxBudgetUsd: settingsFields.maxBudgetUsd.default(5),
  customInstructions: settingsFields.customInstructions.default(''),
  cleanupWorktreeOnMerge: settingsFields.cleanupWorktreeOnMerge.default(true),
});
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

/** A partial settings update: only the keys present are changed. */
export const projectSettingsPatchSchema = z.object(settingsFields).partial();
export type ProjectSettingsPatch = z.infer<typeof projectSettingsPatchSchema>;

export const createProjectSchema = z.object({
  path: z.string().min(1, 'Path is required'),
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(2000).optional(),
  color: z.string().optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(2000).optional(),
  color: z.string().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  settings: projectSettingsPatchSchema.optional(),
});
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

// ---------------------------------------------------------------------------
// Backlog items
// ---------------------------------------------------------------------------

const itemFields = {
  title: z.string().min(3).max(200),
  description: z.string().max(20_000),
  type: z.enum(ITEM_TYPES),
  priority: z.enum(PRIORITIES),
  effort: z.enum(EFFORTS).nullable(),
  impact: z.number().int().min(1).max(5).nullable(),
  tags: z.array(z.string().max(40)).max(20),
  acceptanceCriteria: z.array(z.string().max(500)).max(30),
  status: z.enum(ITEM_STATUSES),
  dueDate: z.string().nullable(),
};

export const createItemSchema = z.object({
  title: itemFields.title,
  description: itemFields.description.default(''),
  type: itemFields.type.default('feature'),
  priority: itemFields.priority.default('p2'),
  effort: itemFields.effort.default(null),
  impact: itemFields.impact.default(null),
  tags: itemFields.tags.default([]),
  acceptanceCriteria: itemFields.acceptanceCriteria.default([]),
  status: itemFields.status.default('backlog'),
  source: z.enum(ITEM_SOURCES).default('manual'),
  dueDate: itemFields.dueDate.optional(),
});
export type CreateItemInput = z.input<typeof createItemSchema>;

/** A partial item update: only the keys present are changed. */
export const updateItemSchema = z
  .object({
    ...itemFields,
    position: z.number(),
    snoozedUntil: z.string().nullable(),
    plan: z.string().nullable(),
  })
  .partial();
export type UpdateItemInput = z.infer<typeof updateItemSchema>;

/** The explicit decision a user makes about an item. */
export const DECISIONS = ['implement', 'plan', 'up_next', 'skip', 'snooze', 'archive', 'restore', 'approve', 'reject', 'done'] as const;
export type Decision = (typeof DECISIONS)[number];
export const decisionSchema = z.object({
  decision: z.enum(DECISIONS),
  reason: z.string().max(1000).optional(),
  /** ISO date for `snooze`. */
  until: z.string().optional(),
});
export type DecisionInput = z.infer<typeof decisionSchema>;

export const bulkDecisionSchema = decisionSchema.extend({
  itemIds: z.array(z.string()).min(1).max(200),
});

export const noteSchema = z.object({ body: z.string().min(1).max(5000) });

export const linkPrSchema = z.object({ prUrlOrNumber: z.string().min(1) });

export const reviseSchema = z.object({ feedback: z.string().min(3).max(10_000) });

// ---------------------------------------------------------------------------
// Analysis (AI ideation)
// ---------------------------------------------------------------------------

export const analyzeSchema = z.object({
  focus: z.array(z.enum(ANALYSIS_FOCUS)).min(1).default(['features']),
  count: z.number().int().min(1).max(25).default(8),
  /** Free-text steer: "I want this to be usable by recruiters", etc. */
  guidance: z.string().max(4000).default(''),
});
export type AnalyzeInput = z.input<typeof analyzeSchema>;

// Schemas below describe what Claude must return (passed as --json-schema).

export const aiSuggestionSchema = z.object({
  title: z.string().describe('Short imperative title, e.g. "Add rate limiting to the shorten endpoint"'),
  description: z.string().describe('Markdown: the problem, the proposed solution, and why it matters for this project'),
  type: z.enum(ITEM_TYPES),
  priority: z.enum(PRIORITIES),
  effort: z.enum(EFFORTS),
  impact: z.number().int().min(1).max(5).describe('1 = nice to have, 5 = transformative'),
  rationale: z.string().describe('One or two sentences on the evidence in the codebase that motivated this'),
  affectedFiles: z.array(z.string()).describe('Repo-relative paths most likely to change'),
  acceptanceCriteria: z.array(z.string()),
  tags: z.array(z.string()),
});
export type AiSuggestion = z.infer<typeof aiSuggestionSchema>;

export const healthScoresSchema = z.object({
  architecture: z.number().int().min(0).max(10),
  testing: z.number().int().min(0).max(10),
  security: z.number().int().min(0).max(10),
  performance: z.number().int().min(0).max(10),
  documentation: z.number().int().min(0).max(10),
  developerExperience: z.number().int().min(0).max(10),
});
export type HealthScores = z.infer<typeof healthScoresSchema>;

export const analysisResultSchema = z.object({
  summary: z.string().describe('Markdown overview of what the project is, its architecture, and its current state'),
  strengths: z.array(z.string()),
  risks: z.array(z.string()),
  health: healthScoresSchema,
  suggestions: z.array(aiSuggestionSchema),
});
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

export const planResultSchema = z.object({
  plan: z.string().describe('Markdown implementation plan: approach, ordered steps, files to touch, test strategy, risks'),
  acceptanceCriteria: z.array(z.string()),
  effort: z.enum(EFFORTS),
  openQuestions: z.array(z.string()),
});
export type PlanResult = z.infer<typeof planResultSchema>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const globalSettingsSchema = z.object({
  maxConcurrentRuns: z.number().int().min(1).max(8).default(2),
  prPollIntervalSec: z.number().int().min(30).max(3600).default(120),
  defaultProjectSettings: projectSettingsPatchSchema.default({}),
  /** Folders scanned by "Discover projects". */
  discoveryRoots: z.array(z.string()).default(['~/Developer', '~/Desktop', '~/code']),
});
export type GlobalSettings = z.infer<typeof globalSettingsSchema>;

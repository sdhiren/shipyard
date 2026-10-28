import path from 'node:path';
import {
  analysisResultSchema,
  analyzeSchema,
  discussResultSchema,
  planResultSchema,
  type PlanResult,
  type Analysis,
  type AnalyzeInput,
  type BacklogItem,
  type Run,
} from '@shipyard/shared';
import { and, desc, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { analyses, items, projects, type AnalysisRow, type ItemRow, type ProjectRow } from '../db/schema.js';
import { bus } from '../lib/events.js';
import { badRequest, conflict, newId, notFound, now, slugify } from '../lib/util.js';
import { logActivity } from './activity.js';
import { runClaude, type ClaudeRunOptions } from './claude/runner.js';
import { analysisPrompt, discussPrompt, implementPrompt, planPrompt, prBody, rebasePrompt, revisePrompt } from './claude/prompts.js';
import { addComment, threadForPrompt } from './comments.js';
import * as git from './git.js';
import * as gh from './github.js';
import { createItem, getItem, getItemRow, itemKey, patchItem } from './items.js';
import { toAnalysis, toRun } from './mappers.js';
import { getProjectRow } from './projects.js';
import { createRun, enqueue, getRunRow, isItemBusy, runToDto, type QueueGroup, type RunContext } from './runs.js';

/** JSON Schema for `claude --json-schema` (the CLI rejects the `$schema` meta key). */
function cliSchema(schema: z.ZodType): object {
  const { $schema: _meta, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/** Adapter: run Claude with the project's model settings and stream into the run log. */
async function claude(ctx: RunContext, project: ProjectRow, opts: Omit<ClaudeRunOptions, 'model' | 'effort' | 'onEvent' | 'signal'>) {
  const result = await runClaude({
    ...opts,
    model: project.settings.model,
    effort: project.settings.effort,
    maxBudgetUsd: opts.maxBudgetUsd ?? project.settings.maxBudgetUsd,
    signal: ctx.signal,
    onEvent: (e) => ctx.emit(e.type, e.text, e.data),
  });
  ctx.update({ sessionId: result.sessionId, costUsd: result.costUsd, durationMs: result.durationMs, numTurns: result.numTurns });
  if (result.permissionDenials.length) {
    ctx.emit('system', `${result.permissionDenials.length} tool call(s) were blocked by the permission policy`, result.permissionDenials);
  }
  return result;
}

function addItemCost(itemId: string, cost: number): void {
  const row = getItemRow(itemId);
  db.update(items)
    .set({ totalCostUsd: row.totalCostUsd + cost })
    .where(eq(items.id, itemId))
    .run();
}

// ---------------------------------------------------------------------------
// Analysis → suggestions in the Inbox
// ---------------------------------------------------------------------------

export function startAnalysis(projectId: string, rawInput: AnalyzeInput): Analysis {
  const project = getProjectRow(projectId);
  const input = analyzeSchema.parse(rawInput);
  const running = db
    .select({ id: analyses.id })
    .from(analyses)
    .where(and(eq(analyses.projectId, projectId), eq(analyses.status, 'running')))
    .get();
  if (running) throw conflict('An analysis is already running for this project');

  const existingTitles = db
    .select({ title: items.title })
    .from(items)
    .where(and(eq(items.projectId, projectId), notInArray(items.status, ['archived'])))
    .orderBy(desc(items.updatedAt))
    .limit(250)
    .all()
    .map((r) => r.title);

  const analysis: AnalysisRow = {
    id: newId('ana'),
    projectId,
    runId: null,
    focus: input.focus,
    guidance: input.guidance,
    count: input.count,
    status: 'queued',
    summary: null,
    strengths: [],
    risks: [],
    health: null,
    suggestionCount: 0,
    costUsd: null,
    createdAt: now(),
    finishedAt: null,
  };
  db.insert(analyses).values(analysis).run();

  const run = createRun({ projectId, analysisId: analysis.id, kind: 'analyze', model: project.settings.model, prompt: '(built when the run starts)', cwd: project.path });
  db.update(analyses).set({ runId: run.id }).where(eq(analyses.id, analysis.id)).run();
  const setAnalysis = (patch: Partial<AnalysisRow>) => {
    db.update(analyses).set(patch).where(eq(analyses.id, analysis.id)).run();
    bus.publish({ type: 'analysis.changed', analysisId: analysis.id, projectId });
  };

  const work = async (ctx: RunContext) => {
    setAnalysis({ status: 'running' });
    const prompt = analysisPrompt({
      project,
      focus: input.focus,
      count: input.count,
      guidance: input.guidance,
      existingTitles,
      recentCommits: await git.recentLog(project.path),
    });
    ctx.update({ prompt });
    const result = await claude(ctx, project, {
      prompt,
      cwd: project.path,
      mode: 'readonly',
      jsonSchema: cliSchema(analysisResultSchema),
      persistSession: false,
    });
    if (!result.ok) {
      setAnalysis({ status: ctx.signal.aborted ? 'cancelled' : 'failed', costUsd: result.costUsd, finishedAt: now() });
      return { status: 'failed' as const, error: result.error };
    }
    const parsed = analysisResultSchema.safeParse(result.structuredOutput);
    if (!parsed.success) {
      setAnalysis({ status: 'failed', costUsd: result.costUsd, finishedAt: now() });
      return { status: 'failed' as const, error: `Claude's answer did not match the expected shape: ${parsed.error.message.slice(0, 500)}` };
    }
    const out = parsed.data;
    for (const s of out.suggestions) {
      createItem(
        projectId,
        {
          title: s.title,
          description: s.description,
          type: s.type,
          priority: s.priority,
          effort: s.effort,
          impact: s.impact,
          tags: s.tags.slice(0, 20),
          acceptanceCriteria: s.acceptanceCriteria.slice(0, 30),
          status: 'proposed',
          source: 'ai',
        },
        { rationale: s.rationale, affectedFiles: s.affectedFiles, analysisId: analysis.id, silent: true },
      );
    }
    setAnalysis({
      status: 'succeeded',
      summary: out.summary,
      strengths: out.strengths,
      risks: out.risks,
      health: out.health,
      suggestionCount: out.suggestions.length,
      costUsd: result.costUsd,
      finishedAt: now(),
    });
    db.update(projects).set({ health: out.health, lastAnalyzedAt: now(), updatedAt: now() }).where(eq(projects.id, projectId)).run();
    bus.publish({ type: 'items.changed', projectId });
    bus.publish({ type: 'project.changed', projectId });
    logActivity({
      projectId,
      kind: 'run_finished',
      message: `Analysis finished with ${out.suggestions.length} suggestion(s) for the Inbox`,
      meta: { analysisId: analysis.id, costUsd: result.costUsd },
    });
    ctx.emit('result', `${out.suggestions.length} suggestions added to the Inbox`);
    return { status: 'succeeded' as const, summary: `${out.suggestions.length} suggestions` };
  };
  enqueue(run.id, async (ctx) => {
    try {
      return await work(ctx);
    } catch (err) {
      setAnalysis({ status: 'failed', finishedAt: now() });
      throw err;
    }
  });

  return toAnalysis(db.select().from(analyses).where(eq(analyses.id, analysis.id)).get()!);
}

export function listAnalyses(projectId: string): Analysis[] {
  return db.select().from(analyses).where(eq(analyses.projectId, projectId)).orderBy(desc(analyses.createdAt)).limit(30).all().map(toAnalysis);
}

export function getAnalysis(id: string): Analysis {
  const row = db.select().from(analyses).where(eq(analyses.id, id)).get();
  if (!row) throw notFound('Analysis');
  return toAnalysis(row);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function assertIdle(itemId: string): void {
  if (isItemBusy(itemId)) throw conflict('Claude is already working on this item');
}

/** Runs that change a project's code share its "parallel implementations" limit. */
function writeGroup(project: ProjectRow): QueueGroup {
  return {
    key: `write:${project.id}`,
    label: project.name,
    limit: () => {
      try {
        return getProjectRow(project.id).settings.maxParallelImplementations;
      } catch {
        return 1;
      }
    },
  };
}

/** Save a plan result to the item, keeping open questions as their own field. */
function applyPlan(itemId: string, p: PlanResult): void {
  patchItem(itemId, { plan: p.plan.trim(), openQuestions: p.openQuestions, acceptanceCriteria: p.acceptanceCriteria, effort: p.effort });
}

function planSummaryComment(p: PlanResult, replanned: boolean): string {
  const head = `${replanned ? 'Revised' : 'Drafted'} the implementation plan · effort **${p.effort.toUpperCase()}** · ${p.acceptanceCriteria.length} acceptance criteria.`;
  if (!p.openQuestions.length) return `${head}\n\nNo open questions. Reply here if you'd like anything changed.`;
  return `${head}\n\n**Open questions**\n${p.openQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\nAnswer them here and I'll update the plan.`;
}

export function startPlan(itemId: string): Run {
  const item = getItemRow(itemId);
  assertIdle(itemId);
  const project = getProjectRow(item.projectId);
  const cwd = item.worktreePath ?? project.path;
  const prompt = planPrompt(project, item, threadForPrompt(itemId));
  const run = createRun({ projectId: project.id, itemId, kind: 'plan', model: project.settings.model, prompt, cwd });
  patchItem(itemId, { lastRunId: run.id });
  logActivity({ projectId: project.id, itemId, kind: 'run_started', message: 'Planning started', meta: { runId: run.id } });

  enqueue(run.id, async (ctx) => {
    const result = await claude(ctx, project, { prompt, cwd, mode: 'readonly', jsonSchema: cliSchema(planResultSchema), persistSession: false });
    addItemCost(itemId, result.costUsd);
    if (!result.ok) return { status: 'failed', error: result.error };
    const parsed = planResultSchema.safeParse(result.structuredOutput);
    if (!parsed.success) return { status: 'failed', error: 'Plan did not match the expected shape' };
    applyPlan(itemId, parsed.data);
    addComment({ itemId, author: 'claude', kind: 'plan', body: planSummaryComment(parsed.data, !!item.plan), planUpdated: true, runId: run.id });
    logActivity({ projectId: project.id, itemId, kind: 'plan_ready', message: 'Implementation plan ready for review', meta: { runId: run.id } });
    ctx.emit('result', parsed.data.openQuestions.length ? `Plan saved with ${parsed.data.openQuestions.length} open question(s)` : 'Plan saved to the item');
    return { status: 'succeeded', summary: 'Plan ready' };
  });
  return runToDto(getRunRow(run.id));
}

// ---------------------------------------------------------------------------
// Discussion: Claude replies in the item's thread and may revise the plan
// ---------------------------------------------------------------------------

export function startDiscussion(itemId: string): Run {
  const item = getItemRow(itemId);
  assertIdle(itemId);
  const project = getProjectRow(item.projectId);
  const key = itemKey(item);
  const cwd = item.worktreePath ?? project.path;
  const prompt = discussPrompt(project, item, key, threadForPrompt(itemId));
  const run = createRun({ projectId: project.id, itemId, kind: 'discuss', model: project.settings.model, prompt, cwd });
  patchItem(itemId, { lastRunId: run.id });

  enqueue(run.id, async (ctx) => {
    const result = await claude(ctx, project, { prompt, cwd, mode: 'readonly', jsonSchema: cliSchema(discussResultSchema), persistSession: false });
    addItemCost(itemId, result.costUsd);
    if (!result.ok) return { status: 'failed', error: result.error };
    const parsed = discussResultSchema.safeParse(result.structuredOutput);
    if (!parsed.success) return { status: 'failed', error: "Claude's reply did not match the expected shape" };
    const { reply, updatedPlan } = parsed.data;
    if (updatedPlan) {
      applyPlan(itemId, updatedPlan);
      logActivity({ projectId: project.id, itemId, kind: 'plan_ready', message: 'Plan updated from the discussion', meta: { runId: run.id } });
    }
    addComment({ itemId, author: 'claude', kind: 'comment', body: reply, planUpdated: !!updatedPlan, runId: run.id });
    ctx.emit('result', updatedPlan ? 'Replied and updated the plan' : 'Replied in the discussion');
    return { status: 'succeeded', summary: updatedPlan ? 'Replied and updated the plan' : 'Replied' };
  });
  return runToDto(getRunRow(run.id));
}

// ---------------------------------------------------------------------------
// Implementation in an isolated worktree → commit → push → PR
// ---------------------------------------------------------------------------

function branchFor(project: ProjectRow, item: ItemRow): string {
  return `${project.settings.branchPrefix}${itemKey(item).toLowerCase()}-${slugify(item.title, 40)}`;
}

export function startImplementation(itemId: string): Run {
  const item = getItemRow(itemId);
  assertIdle(itemId);
  const project = getProjectRow(item.projectId);
  if (!project.git.isRepo) throw badRequest('This project is not a git repository, so Shipyard cannot create a branch for the work');
  if (['done', 'archived'].includes(item.status)) throw conflict(`Item is ${item.status}`);

  const key = itemKey(item);
  const branch = item.branch ?? branchFor(project, item);
  const worktreePath = item.worktreePath ?? path.join(config.worktreesDir, project.slug, key.toLowerCase());
  const baseBranch = project.git.defaultBranch ?? 'main';

  const run = createRun({ projectId: project.id, itemId, kind: 'implement', model: project.settings.model, prompt: '(built when the run starts)', cwd: worktreePath, branch });
  patchItem(itemId, { status: 'in_progress', branch, worktreePath, lastRunId: run.id, snoozedUntil: null });
  logActivity({ projectId: project.id, itemId, kind: 'run_started', message: `Implementation started on \`${branch}\``, meta: { runId: run.id } });

  enqueue(run.id, async (ctx) => {
    ctx.emit('step', `Fetching the latest ${baseBranch} and preparing the worktree`);
    let wt: git.WorktreeResult;
    try {
      // Always start from the freshest base to keep parallel PRs from drifting apart.
      wt = await git.ensureWorktree({ repoPath: project.path, worktreePath, branch, baseBranch, published: !!item.prNumber });
    } catch (err) {
      patchItem(itemId, { status: 'planned' }, 'could not prepare the branch');
      throw err;
    }
    ctx.emit('step', git.describeWorktree(wt, branch));

    const fresh = getItemRow(itemId);
    const prompt = implementPrompt(project, fresh, key, threadForPrompt(itemId));
    ctx.update({ prompt });
    const result = await claude(ctx, project, {
      prompt,
      cwd: worktreePath,
      mode: project.settings.autonomy === 'full' ? 'full' : 'guarded',
      allowedTools: project.settings.allowedTools,
      persistSession: true,
    });
    addItemCost(itemId, result.costUsd);
    if (result.sessionId) db.update(items).set({ sessionId: result.sessionId }).where(eq(items.id, itemId)).run();

    if (!result.ok) {
      patchItem(itemId, { status: 'planned' }, ctx.signal.aborted ? 'run cancelled' : 'run failed');
      return { status: 'failed', error: result.error };
    }
    return finishDelivery(ctx, project, itemId, key, baseBranch, result.resultText, 'implement');
  }, writeGroup(project));
  return runToDto(getRunRow(run.id));
}

/** Shared tail of implement/revise: commit leftovers, push, open or update the PR. */
async function finishDelivery(
  ctx: RunContext,
  project: ProjectRow,
  itemId: string,
  key: string,
  baseBranch: string,
  summary: string,
  kind: 'implement' | 'revise',
): Promise<{ status: 'succeeded' | 'failed'; summary?: string; error?: string }> {
  const item = getItemRow(itemId);
  const cwd = item.worktreePath!;
  const branch = item.branch!;
  if (await git.commitAll(cwd, `${kind === 'implement' ? 'feat' : 'chore'}: ${item.title} (${key})`)) {
    ctx.emit('step', 'Committed remaining uncommitted changes');
  }
  const ahead = await git.commitsAhead(cwd, baseBranch);
  if (ahead === 0) {
    patchItem(itemId, { status: 'planned' }, 'Claude finished without changes');
    return { status: 'failed', error: 'Claude finished but made no commits. Check the log for questions or blockers.' };
  }
  ctx.emit('step', `${ahead} commit(s) on ${branch}`);

  const repo = project.git.githubRepo;
  if (repo && (item.prNumber || project.settings.autoPr)) {
    try {
      ctx.emit('step', `Pushing ${branch} to origin`);
      await git.push(cwd, branch);
      if (item.prNumber) {
        await gh.commentOnPr(repo, item.prNumber, `Shipyard pushed a revision:\n\n${summary.slice(0, 5000)}`);
        await syncPr(itemId);
        ctx.emit('result', `Updated PR #${item.prNumber}`);
      } else {
        const existing = await gh.findPrForBranch(repo, branch);
        const pr =
          existing ??
          (await gh.createPr({
            repo,
            cwd,
            head: branch,
            base: baseBranch,
            title: `${item.title} (${key})`,
            body: prBody(item, key, summary, await git.diffStat(cwd, baseBranch), { branch: baseBranch, sha: await git.mergeBaseShort(cwd, baseBranch) }),
            draft: project.settings.draftPr,
          }));
        applyPrSnapshot(itemId, pr);
        logActivity({ projectId: project.id, itemId, kind: 'pr_opened', message: `Opened PR #${pr.number}`, meta: { url: pr.url } });
        ctx.emit('result', `Opened PR #${pr.number}: ${pr.url}`, { url: pr.url });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.emit('stderr', message);
      patchItem(itemId, { status: 'in_review' }, 'branch ready; pushing or opening the PR failed');
      return { status: 'succeeded', summary: `Branch ready, but the PR step failed: ${message.slice(0, 300)}` };
    }
  } else {
    ctx.emit('result', `Branch ${branch} is ready for review locally`);
  }
  patchItem(itemId, { status: 'in_review' });
  logActivity({ projectId: project.id, itemId, kind: 'run_finished', message: kind === 'implement' ? 'Implementation finished' : 'Revision finished', meta: { runId: ctx.runId } });
  return { status: 'succeeded', summary: summary.slice(0, 2000) };
}

export function startRevision(itemId: string, feedback: string): Run {
  const item = getItemRow(itemId);
  assertIdle(itemId);
  if (!item.worktreePath || !item.branch) throw conflict('This item has no workspace yet; implement it first');
  const project = getProjectRow(item.projectId);
  const key = itemKey(item);
  const baseBranch = project.git.defaultBranch ?? 'main';
  const prompt = revisePrompt(project, item, key, feedback);
  const run = createRun({ projectId: project.id, itemId, kind: 'revise', model: project.settings.model, prompt, cwd: item.worktreePath, branch: item.branch });
  patchItem(itemId, { status: 'in_progress', lastRunId: run.id }, 'changes requested');

  enqueue(run.id, async (ctx) => {
    try {
      // Revisions continue the same branch (often already on GitHub), so it isn't rebased here.
      await git.ensureWorktree({ repoPath: project.path, worktreePath: item.worktreePath!, branch: item.branch!, baseBranch, sync: false });
    } catch (err) {
      patchItem(itemId, { status: 'in_review' }, 'could not prepare the branch');
      throw err;
    }
    const result = await claude(ctx, project, {
      // Resuming keeps Claude's memory of the first implementation; fall back to the full brief.
      prompt: item.sessionId ? prompt : `${implementPrompt(project, item, key)}\n\n---\n\n${prompt}`,
      cwd: item.worktreePath!,
      mode: project.settings.autonomy === 'full' ? 'full' : 'guarded',
      allowedTools: project.settings.allowedTools,
      resumeSessionId: item.sessionId,
      persistSession: true,
    });
    addItemCost(itemId, result.costUsd);
    if (result.sessionId) db.update(items).set({ sessionId: result.sessionId }).where(eq(items.id, itemId)).run();
    if (!result.ok) {
      patchItem(itemId, { status: 'in_review' }, 'revision failed');
      return { status: 'failed', error: result.error };
    }
    return finishDelivery(ctx, project, itemId, key, baseBranch, result.resultText, 'revise');
  }, writeGroup(project));
  return runToDto(getRunRow(run.id));
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

function applyPrSnapshot(itemId: string, pr: gh.PrSnapshot): void {
  db.update(items)
    .set({
      prNumber: pr.number,
      prUrl: pr.url,
      prState: pr.state,
      prIsDraft: pr.isDraft,
      prReviewDecision: pr.reviewDecision,
      prChecks: pr.checks,
      prAdditions: pr.additions,
      prDeletions: pr.deletions,
      prChangedFiles: pr.changedFiles,
      prMergedAt: pr.mergedAt,
      prMergeable: pr.mergeable,
      prMergeState: pr.mergeState,
      prSyncedAt: now(),
      branch: pr.headRefName,
    })
    .where(eq(items.id, itemId))
    .run();
}

const conflicted = (p: { mergeable: string | null; mergeState: string | null }) => p.mergeable === 'CONFLICTING' || p.mergeState === 'DIRTY';

/** Refresh PR state from GitHub and advance the item when it merges. */
export async function syncPr(itemId: string, opts: { after?: string } = {}): Promise<BacklogItem> {
  const item = getItemRow(itemId);
  const project = getProjectRow(item.projectId);
  if (!item.prNumber || !project.git.githubRepo) return getItem(itemId);
  const before = { state: item.prState, checks: item.prChecks, review: item.prReviewDecision, mergeable: item.prMergeable, mergeState: item.prMergeState };
  const pr = await gh.viewPr(project.git.githubRepo, item.prNumber);
  applyPrSnapshot(itemId, pr);
  const base = project.git.defaultBranch ?? 'main';

  if (pr.state === 'MERGED' && item.status !== 'done') {
    patchItem(itemId, { status: 'done' }, `PR #${pr.number} merged`);
    logActivity({ projectId: project.id, itemId, kind: 'pr_merged', message: `PR #${pr.number} merged`, meta: { url: pr.url } });
    if (project.settings.cleanupWorktreeOnMerge && item.worktreePath) {
      await git.removeWorktree(project.path, item.worktreePath).catch(() => undefined);
      db.update(items).set({ worktreePath: null }).where(eq(items.id, itemId)).run();
    }
    resyncSiblingPrs(project.id, itemId, pr.number);
  } else {
    const parts = [
      before.state !== pr.state ? `state ${pr.state.toLowerCase()}` : '',
      before.checks !== pr.checks ? `checks ${pr.checks}` : '',
      before.review !== pr.reviewDecision && pr.reviewDecision ? `review ${pr.reviewDecision.toLowerCase().replace('_', ' ')}` : '',
    ].filter(Boolean);
    if (parts.length) logActivity({ projectId: project.id, itemId, kind: 'pr_updated', message: `PR #${pr.number}: ${parts.join(', ')}`, meta: { url: pr.url } });

    if (pr.state === 'OPEN' && conflicted(pr) && !conflicted(before)) {
      logActivity({
        projectId: project.id,
        itemId,
        kind: 'pr_updated',
        message: `PR #${pr.number} now has merge conflicts with ${base}${opts.after ? ` (after ${opts.after} merged)` : ''}. Rebase it onto the latest ${base}.`,
        meta: { url: pr.url, needsRebase: true },
      });
    } else if (pr.state === 'OPEN' && conflicted(before) && !conflicted(pr) && pr.mergeable === 'MERGEABLE') {
      logActivity({ projectId: project.id, itemId, kind: 'pr_updated', message: `PR #${pr.number} no longer has merge conflicts`, meta: { url: pr.url } });
    }
  }
  bus.publish({ type: 'item.changed', projectId: project.id, itemId });
  return getItem(itemId);
}

/** Sync an item's PR again after a delay (GitHub recomputes mergeability asynchronously). */
function syncLater(itemId: string, delaysMs: number[], opts: { after?: string } = {}): void {
  for (const ms of delaysMs) setTimeout(() => void syncPr(itemId, opts).catch(() => undefined), ms).unref();
}

/** When a PR merges, the project's other open PRs may now conflict: check them promptly. */
function resyncSiblingPrs(projectId: string, mergedItemId: string, prNumber: number): void {
  const siblings = db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.projectId, projectId), eq(items.prState, 'OPEN'), isNotNull(items.prNumber)))
    .all()
    .filter((r) => r.id !== mergedItemId);
  for (const s of siblings) syncLater(s.id, [10_000, 45_000], { after: `#${prNumber}` });
}

// ---------------------------------------------------------------------------
// Rebasing a PR onto the latest base
// ---------------------------------------------------------------------------

/** Extra commands Claude may run while resolving a rebase (on top of the project's allow-list). */
const REBASE_TOOLS = [
  'Bash(git rebase --continue*)',
  'Bash(git rebase --skip*)',
  'Bash(git checkout --ours*)',
  'Bash(git checkout --theirs*)',
  'Bash(git restore*)',
  'Bash(git rm*)',
];

/**
 * Bring an item's branch up to date with the latest base. A clean rebase is
 * done directly (no Claude cost). If it conflicts, Claude resolves the
 * conflicts in the worktree. The result is verified before anything is pushed,
 * and the push uses --force-with-lease so commits added on GitHub are never
 * overwritten. On any failure the branch is restored to how it was.
 */
export function startRebase(itemId: string): Run {
  const item = getItemRow(itemId);
  assertIdle(itemId);
  if (!item.branch) throw conflict('This item has no branch to rebase yet');
  const project = getProjectRow(item.projectId);
  const key = itemKey(item);
  const branch = item.branch;
  const baseBranch = project.git.defaultBranch ?? 'main';
  const cwd = item.worktreePath ?? path.join(config.worktreesDir, project.slug, key.toLowerCase());

  const run = createRun({ projectId: project.id, itemId, kind: 'rebase', model: project.settings.model, prompt: '(only used if the rebase has conflicts)', cwd, branch });
  patchItem(itemId, { lastRunId: run.id, worktreePath: cwd });
  logActivity({ projectId: project.id, itemId, kind: 'run_started', message: `Rebasing \`${branch}\` onto the latest ${baseBranch}`, meta: { runId: run.id } });

  enqueue(
    run.id,
    async (ctx) => {
      await git.ensureWorktree({ repoPath: project.path, worktreePath: cwd, branch, baseBranch, sync: false });
      await git.abortRebase(cwd); // leftover from an interrupted run
      if (await git.hasUncommittedChanges(cwd)) {
        return { status: 'failed', error: 'The worktree has uncommitted changes. Commit or discard them, then retry the rebase.' };
      }

      ctx.emit('step', `Fetching the latest ${baseBranch} and ${branch}`);
      const { base, remoteSha } = await git.withRepoLock(project.path, async () => ({
        base: await git.fetchLatestBase(project.path, baseBranch),
        remoteSha: project.git.remoteUrl ? await git.fetchRemoteBranch(project.path, branch) : null,
      }));

      // Pick up commits added to the PR branch elsewhere (e.g. on GitHub) before rewriting it.
      if (remoteSha && !(await git.isAncestor(cwd, remoteSha))) {
        if (!(await git.isAncestor(cwd, 'HEAD', remoteSha))) {
          return { status: 'failed', error: `${branch} on GitHub and the local branch have diverged. Reconcile them first, then retry.` };
        }
        await git.fastForwardTo(cwd, remoteSha);
        ctx.emit('step', `Pulled newer commits for ${branch} from GitHub`);
      }

      if (await git.isAncestor(cwd, base.ref)) {
        ctx.emit('result', `${branch} already includes the latest ${base.ref} @ ${base.sha}`);
        if (item.prNumber) await syncPr(itemId).catch(() => undefined);
        return { status: 'succeeded', summary: 'Already up to date' };
      }

      ctx.emit('step', `Rebasing ${branch} onto ${base.ref} @ ${base.sha} “${base.subject}”`);
      const original = await git.headSha(cwd);
      const attempt = await git.beginRebase(cwd, base.ref);
      let conflicts: string[] = [];
      let claudeSummary = '';

      if (attempt.ok) {
        ctx.emit('step', 'Rebased cleanly, with no conflicts');
      } else {
        conflicts = attempt.conflicts;
        ctx.emit('step', `Conflicts in ${conflicts.join(', ') || 'some files'}; asking Claude to resolve them`);
        const prompt = rebasePrompt(project, getItemRow(itemId), key, { onto: base.ref, ontoSubject: base.subject, conflicts });
        ctx.update({ prompt });
        const result = await claude(ctx, project, {
          prompt,
          cwd,
          mode: project.settings.autonomy === 'full' ? 'full' : 'guarded',
          allowedTools: [...project.settings.allowedTools, ...REBASE_TOOLS],
          resumeSessionId: item.sessionId,
          persistSession: true,
        });
        addItemCost(itemId, result.costUsd);
        if (result.sessionId) db.update(items).set({ sessionId: result.sessionId }).where(eq(items.id, itemId)).run();

        const problems: string[] = [];
        if (!result.ok) problems.push(result.error ?? 'Claude did not finish');
        if (await git.isRebaseInProgress(cwd)) problems.push('the rebase was left unfinished');
        else if (!(await git.isAncestor(cwd, base.ref))) problems.push(`the branch doesn't include ${base.ref}`);
        const markers = await git.filesWithConflictMarkers(cwd);
        if (markers.length) problems.push(`conflict markers remain in ${markers.join(', ')}`);

        if (problems.length) {
          await git.abortRebase(cwd);
          await git.resetHard(cwd, original);
          ctx.emit('step', `Restored ${branch} to how it was before the rebase`);
          return { status: 'failed', error: `Couldn't finish the rebase: ${problems.join('; ')}. ${branch} was restored, so you can retry or rebase it by hand.` };
        }
        if (await git.commitAll(cwd, `fix: follow-ups after rebasing ${key} onto ${baseBranch}`)) ctx.emit('step', 'Committed follow-up fixes');
        claudeSummary = result.resultText;
      }

      if (remoteSha) {
        ctx.emit('step', `Pushing the rebased ${branch} (force-with-lease)`);
        try {
          await git.pushForceWithLease(cwd, branch, remoteSha);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { status: 'failed', error: `Rebased locally, but the push was refused (the branch may have changed on GitHub meanwhile): ${message}` };
        }
      }

      const fresh = getItemRow(itemId);
      if (fresh.prNumber && project.git.githubRepo) {
        const note = conflicts.length
          ? `Claude resolved conflicts in: ${conflicts.map((f) => `\`${f}\``).join(', ')}\n\n${claudeSummary.slice(0, 4000)}`
          : 'There were no conflicts.';
        await gh.commentOnPr(project.git.githubRepo, fresh.prNumber, `Shipyard rebased this branch onto \`${baseBranch}\` @ \`${base.sha}\`. ${note}`).catch(() => undefined);
        await syncPr(itemId).catch(() => undefined);
        syncLater(itemId, [10_000]);
      }
      const message = conflicts.length
        ? `Rebased onto ${baseBranch} @ ${base.sha}; Claude resolved conflicts in ${conflicts.length} file(s)`
        : `Rebased onto ${baseBranch} @ ${base.sha} with no conflicts`;
      logActivity({ projectId: project.id, itemId, kind: 'run_finished', message, meta: { runId: ctx.runId } });
      ctx.emit('result', message);
      return { status: 'succeeded', summary: message };
    },
    writeGroup(project),
  );
  return runToDto(getRunRow(run.id));
}

/** Attach a PR the owner opened by hand (URL or number). */
export async function linkPr(itemId: string, ref: string): Promise<BacklogItem> {
  const item = getItemRow(itemId);
  const project = getProjectRow(item.projectId);
  if (!project.git.githubRepo) throw badRequest('Project has no GitHub remote');
  const pr = await gh.viewPr(project.git.githubRepo, ref.trim());
  applyPrSnapshot(itemId, pr);
  logActivity({ projectId: project.id, itemId, kind: 'pr_opened', message: `Linked PR #${pr.number}`, meta: { url: pr.url } });
  if (pr.state === 'MERGED') patchItem(itemId, { status: 'done' }, `PR #${pr.number} already merged`);
  else if (item.status !== 'in_review') patchItem(itemId, { status: 'in_review' });
  return getItem(itemId);
}

/** Push the branch and open a PR for an item whose work is ready locally. */
export async function openPr(itemId: string): Promise<BacklogItem> {
  const item = getItemRow(itemId);
  const project = getProjectRow(item.projectId);
  const repo = project.git.githubRepo;
  if (!repo) throw badRequest('Project has no GitHub remote');
  if (!item.branch || !item.worktreePath) throw conflict('No branch to open a PR from');
  if (item.prNumber) return syncPr(itemId);
  const key = itemKey(item);
  const base = project.git.defaultBranch ?? 'main';
  await git.push(item.worktreePath, item.branch);
  const lastSummary = item.lastRunId ? getRunRow(item.lastRunId).summary ?? '' : '';
  const pr =
    (await gh.findPrForBranch(repo, item.branch)) ??
    (await gh.createPr({
      repo,
      cwd: item.worktreePath,
      head: item.branch,
      base,
      title: `${item.title} (${key})`,
      body: prBody(item, key, lastSummary, await git.diffStat(item.worktreePath, base), { branch: base, sha: await git.mergeBaseShort(item.worktreePath, base) }),
      draft: project.settings.draftPr,
    }));
  applyPrSnapshot(itemId, pr);
  logActivity({ projectId: project.id, itemId, kind: 'pr_opened', message: `Opened PR #${pr.number}`, meta: { url: pr.url } });
  return patchItem(itemId, { status: 'in_review' });
}

export async function mergePr(itemId: string, method: 'squash' | 'merge' | 'rebase'): Promise<BacklogItem> {
  const item = getItemRow(itemId);
  const project = getProjectRow(item.projectId);
  if (!item.prNumber || !project.git.githubRepo) throw conflict('No PR to merge');
  await gh.mergePr(project.git.githubRepo, item.prNumber, method);
  return syncPr(itemId);
}

export async function getItemDiff(itemId: string): Promise<{ stat: string; diff: string }> {
  const item = getItemRow(itemId);
  const project = getProjectRow(item.projectId);
  if (!item.worktreePath) return { stat: '', diff: '' };
  const base = project.git.defaultBranch ?? 'main';
  const [stat, diff] = await Promise.all([git.diffStat(item.worktreePath, base), git.diff(item.worktreePath, base)]);
  return { stat, diff };
}

/** Remove the worktree (the branch is kept, so work is never lost). */
export async function discardWorkspace(itemId: string): Promise<BacklogItem> {
  const item = getItemRow(itemId);
  assertIdle(itemId);
  const project = getProjectRow(item.projectId);
  if (item.worktreePath) await git.removeWorktree(project.path, item.worktreePath);
  return patchItem(itemId, { worktreePath: null });
}

/** Boot-time cleanup for analyses whose run died with the previous process. */
export function recoverInterruptedAnalyses(): void {
  db.update(analyses)
    .set({ status: 'failed', finishedAt: now() })
    .where(inArray(analyses.status, ['queued', 'running']))
    .run();
}

import path from 'node:path';
import {
  analysisResultSchema,
  analyzeSchema,
  planResultSchema,
  type Analysis,
  type AnalyzeInput,
  type BacklogItem,
  type Run,
} from '@shipyard/shared';
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { analyses, items, projects, type AnalysisRow, type ItemRow, type ProjectRow } from '../db/schema.js';
import { bus } from '../lib/events.js';
import { badRequest, conflict, newId, notFound, now, slugify } from '../lib/util.js';
import { logActivity } from './activity.js';
import { runClaude, type ClaudeRunOptions } from './claude/runner.js';
import { analysisPrompt, implementPrompt, planPrompt, prBody, revisePrompt } from './claude/prompts.js';
import * as git from './git.js';
import * as gh from './github.js';
import { createItem, getItem, getItemRow, itemKey, patchItem } from './items.js';
import { toAnalysis, toRun } from './mappers.js';
import { getProjectRow } from './projects.js';
import { createRun, enqueue, getRunRow, isItemBusy, type RunContext } from './runs.js';

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

export function startPlan(itemId: string): Run {
  const item = getItemRow(itemId);
  assertIdle(itemId);
  const project = getProjectRow(item.projectId);
  const cwd = item.worktreePath ?? project.path;
  const prompt = planPrompt(project, item);
  const run = createRun({ projectId: project.id, itemId, kind: 'plan', model: project.settings.model, prompt, cwd });
  patchItem(itemId, { lastRunId: run.id });
  logActivity({ projectId: project.id, itemId, kind: 'run_started', message: 'Planning started', meta: { runId: run.id } });

  enqueue(run.id, async (ctx) => {
    const result = await claude(ctx, project, { prompt, cwd, mode: 'readonly', jsonSchema: cliSchema(planResultSchema), persistSession: false });
    addItemCost(itemId, result.costUsd);
    if (!result.ok) return { status: 'failed', error: result.error };
    const parsed = planResultSchema.safeParse(result.structuredOutput);
    if (!parsed.success) return { status: 'failed', error: 'Plan did not match the expected shape' };
    const p = parsed.data;
    const plan = p.openQuestions.length ? `${p.plan}\n\n### Open questions\n${p.openQuestions.map((q) => `- ${q}`).join('\n')}` : p.plan;
    patchItem(itemId, { plan, acceptanceCriteria: p.acceptanceCriteria, effort: p.effort });
    logActivity({ projectId: project.id, itemId, kind: 'plan_ready', message: 'Implementation plan ready for review', meta: { runId: run.id } });
    ctx.emit('result', 'Plan saved to the item');
    return { status: 'succeeded', summary: 'Plan ready' };
  });
  return toRun(getRunRow(run.id));
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
    ctx.emit('step', `Preparing worktree ${worktreePath}`);
    const wt = await git.ensureWorktree({ repoPath: project.path, worktreePath, branch, baseBranch });
    ctx.emit('step', wt.created ? `Created branch ${branch} from ${wt.base}` : `Reusing existing worktree on ${branch}`);

    const fresh = getItemRow(itemId);
    const prompt = implementPrompt(project, fresh, key);
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
  });
  return toRun(getRunRow(run.id));
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
            body: prBody(item, key, summary, await git.diffStat(cwd, baseBranch)),
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
  logActivity({ projectId: project.id, itemId, kind: 'note', message: `Requested changes:\n\n${feedback}` });

  enqueue(run.id, async (ctx) => {
    await git.ensureWorktree({ repoPath: project.path, worktreePath: item.worktreePath!, branch: item.branch!, baseBranch });
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
  });
  return toRun(getRunRow(run.id));
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
      prSyncedAt: now(),
      branch: pr.headRefName,
    })
    .where(eq(items.id, itemId))
    .run();
}

/** Refresh PR state from GitHub and advance the item when it merges. */
export async function syncPr(itemId: string): Promise<BacklogItem> {
  const item = getItemRow(itemId);
  const project = getProjectRow(item.projectId);
  if (!item.prNumber || !project.git.githubRepo) return getItem(itemId);
  const before = { state: item.prState, checks: item.prChecks, review: item.prReviewDecision };
  const pr = await gh.viewPr(project.git.githubRepo, item.prNumber);
  applyPrSnapshot(itemId, pr);

  if (pr.state === 'MERGED' && item.status !== 'done') {
    patchItem(itemId, { status: 'done' }, `PR #${pr.number} merged`);
    logActivity({ projectId: project.id, itemId, kind: 'pr_merged', message: `PR #${pr.number} merged`, meta: { url: pr.url } });
    if (project.settings.cleanupWorktreeOnMerge && item.worktreePath) {
      await git.removeWorktree(project.path, item.worktreePath).catch(() => undefined);
      db.update(items).set({ worktreePath: null }).where(eq(items.id, itemId)).run();
    }
  } else if (before.state !== pr.state || before.checks !== pr.checks || before.review !== pr.reviewDecision) {
    const parts = [
      before.state !== pr.state ? `state ${pr.state.toLowerCase()}` : '',
      before.checks !== pr.checks ? `checks ${pr.checks}` : '',
      before.review !== pr.reviewDecision && pr.reviewDecision ? `review ${pr.reviewDecision.toLowerCase().replace('_', ' ')}` : '',
    ].filter(Boolean);
    logActivity({ projectId: project.id, itemId, kind: 'pr_updated', message: `PR #${pr.number}: ${parts.join(', ')}`, meta: { url: pr.url } });
  }
  bus.publish({ type: 'item.changed', projectId: project.id, itemId });
  return getItem(itemId);
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
      body: prBody(item, key, lastSummary, await git.diffStat(item.worktreePath, base)),
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

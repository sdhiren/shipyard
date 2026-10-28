import type { ChecksState, MergeableState, PrState } from '@shipyard/shared';
import { config } from '../config.js';
import { exec, execOrThrow } from '../lib/exec.js';

/** Thin wrapper over the `gh` CLI, so we reuse the user's existing GitHub auth. */

export interface PrSnapshot {
  number: number;
  url: string;
  state: PrState;
  isDraft: boolean;
  reviewDecision: string | null;
  checks: ChecksState;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergedAt: string | null;
  headRefName: string;
  mergeable: MergeableState | null;
  mergeState: string | null;
}

interface GhCheck {
  status?: string;
  conclusion?: string;
  state?: string;
}

export function summarizeChecks(rollup: GhCheck[] | null | undefined): ChecksState {
  if (!rollup || rollup.length === 0) return 'none';
  let pending = false;
  for (const c of rollup) {
    const conclusion = (c.conclusion ?? c.state ?? '').toUpperCase();
    const status = (c.status ?? '').toUpperCase();
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion)) return 'failing';
    if ((status && status !== 'COMPLETED') || conclusion === 'PENDING' || conclusion === 'EXPECTED' || conclusion === '') pending = true;
  }
  return pending ? 'pending' : 'passing';
}

const PR_FIELDS = 'number,url,state,isDraft,reviewDecision,statusCheckRollup,additions,deletions,changedFiles,mergedAt,headRefName,mergeable,mergeStateStatus';

function toSnapshot(raw: Record<string, unknown>): PrSnapshot {
  return {
    number: raw.number as number,
    url: raw.url as string,
    state: raw.state as PrState,
    isDraft: Boolean(raw.isDraft),
    reviewDecision: (raw.reviewDecision as string) || null,
    checks: summarizeChecks(raw.statusCheckRollup as GhCheck[]),
    additions: (raw.additions as number) ?? 0,
    deletions: (raw.deletions as number) ?? 0,
    changedFiles: (raw.changedFiles as number) ?? 0,
    mergedAt: (raw.mergedAt as string) || null,
    headRefName: raw.headRefName as string,
    mergeable: (raw.mergeable as MergeableState) || null,
    mergeState: (raw.mergeStateStatus as string) || null,
  };
}

export async function ghAvailable(): Promise<{ installed: boolean; authenticated: boolean }> {
  try {
    const v = await exec(config.ghBin, ['auth', 'status'], { timeoutMs: 15_000 });
    return { installed: true, authenticated: v.code === 0 };
  } catch {
    return { installed: false, authenticated: false };
  }
}

export async function viewPr(repo: string, ref: string | number): Promise<PrSnapshot> {
  const out = await execOrThrow(config.ghBin, ['pr', 'view', String(ref), '--repo', repo, '--json', PR_FIELDS], { timeoutMs: 30_000 });
  return toSnapshot(JSON.parse(out) as Record<string, unknown>);
}

/** Find an existing PR for a branch (open or otherwise). */
export async function findPrForBranch(repo: string, branch: string): Promise<PrSnapshot | null> {
  const r = await exec(config.ghBin, ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', PR_FIELDS, '--limit', '1'], {
    timeoutMs: 30_000,
  });
  if (r.code !== 0) return null;
  const arr = JSON.parse(r.stdout || '[]') as Record<string, unknown>[];
  return arr[0] ? toSnapshot(arr[0]) : null;
}

export async function createPr(opts: {
  repo: string;
  cwd: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}): Promise<PrSnapshot> {
  const args = ['pr', 'create', '--repo', opts.repo, '--head', opts.head, '--base', opts.base, '--title', opts.title, '--body-file', '-'];
  if (opts.draft) args.push('--draft');
  const out = await execOrThrow(config.ghBin, args, { cwd: opts.cwd, input: opts.body, timeoutMs: 60_000 });
  const url = out.trim().split('\n').pop()!.trim();
  return viewPr(opts.repo, url);
}

export async function commentOnPr(repo: string, number: number, body: string): Promise<void> {
  await execOrThrow(config.ghBin, ['pr', 'comment', String(number), '--repo', repo, '--body-file', '-'], { input: body, timeoutMs: 30_000 });
}

export async function mergePr(repo: string, number: number, method: 'squash' | 'merge' | 'rebase' = 'squash'): Promise<void> {
  await execOrThrow(config.ghBin, ['pr', 'merge', String(number), '--repo', repo, `--${method}`, '--delete-branch'], { timeoutMs: 60_000 });
}

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}

export async function listOpenIssues(repo: string, limit = 50): Promise<GhIssue[]> {
  const r = await exec(config.ghBin, ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(limit), '--json', 'number,title,body,url,labels'], {
    timeoutMs: 30_000,
  });
  if (r.code !== 0) return [];
  const raw = JSON.parse(r.stdout || '[]') as { number: number; title: string; body: string; url: string; labels: { name: string }[] }[];
  return raw.map((i) => ({ ...i, labels: i.labels.map((l) => l.name) }));
}

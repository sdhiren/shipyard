import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitInfo } from '@shipyard/shared';
import { exec, execOrThrow } from '../lib/exec.js';

const git = (cwd: string, args: string[]) => exec('git', args, { cwd, timeoutMs: 60_000 });
const gitOk = (cwd: string, args: string[]) => execOrThrow('git', args, { cwd, timeoutMs: 120_000 });

/** Parse "owner/name" out of the usual GitHub remote URL shapes. */
export function parseGithubRepo(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const m = remoteUrl.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function getGitInfo(repoPath: string): Promise<GitInfo> {
  const empty: GitInfo = {
    isRepo: false,
    remoteUrl: null,
    githubRepo: null,
    defaultBranch: null,
    currentBranch: null,
    dirty: false,
    lastCommitAt: null,
    lastCommitMessage: null,
    commitCount: 0,
  };
  const inside = await git(repoPath, ['rev-parse', '--is-inside-work-tree']).catch(() => null);
  if (!inside || inside.code !== 0) return empty;

  const [remote, current, status, last, count] = await Promise.all([
    git(repoPath, ['remote', 'get-url', 'origin']),
    git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(repoPath, ['status', '--porcelain']),
    git(repoPath, ['log', '-1', '--format=%cI%x00%s']),
    git(repoPath, ['rev-list', '--count', 'HEAD']),
  ]);
  const remoteUrl = remote.code === 0 ? remote.stdout.trim() || null : null;
  const [lastAt, lastMsg] = last.code === 0 ? last.stdout.trim().split('\0') : [];

  return {
    isRepo: true,
    remoteUrl,
    githubRepo: parseGithubRepo(remoteUrl),
    defaultBranch: await getDefaultBranch(repoPath),
    currentBranch: current.code === 0 ? current.stdout.trim() : null,
    dirty: status.code === 0 && status.stdout.trim().length > 0,
    lastCommitAt: lastAt || null,
    lastCommitMessage: lastMsg || null,
    commitCount: count.code === 0 ? Number(count.stdout.trim()) || 0 : 0,
  };
}

export async function getDefaultBranch(repoPath: string): Promise<string | null> {
  const head = await git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, '');
  for (const candidate of ['main', 'master', 'develop']) {
    const r = await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
    if (r.code === 0) return candidate;
  }
  const cur = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return cur.code === 0 ? cur.stdout.trim() : null;
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const r = await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return r.code === 0;
}

// ---------------------------------------------------------------------------
// Fresh bases for implementation branches
// ---------------------------------------------------------------------------

const repoLocks = new Map<string, Promise<unknown>>();

/**
 * Run git setup for one repository at a time. Parallel runs in the same repo
 * would otherwise race on fetch and worktree lock files.
 */
export function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repoPath) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  repoLocks.set(repoPath, tail);
  void tail.then(() => {
    if (repoLocks.get(repoPath) === tail) repoLocks.delete(repoPath);
  });
  return next;
}

export interface BaseRef {
  /** The ref new work starts from, e.g. "origin/main". */
  ref: string;
  sha: string;
  subject: string;
  /** False when the repo has no `origin` remote and the local branch is used. */
  fromRemote: boolean;
}

async function describeRef(repoPath: string, ref: string): Promise<{ sha: string; subject: string }> {
  const out = await gitOk(repoPath, ['log', '-1', '--format=%h%x00%s', ref]);
  const [sha = '', subject = ''] = out.trim().split('\0');
  return { sha, subject };
}

/**
 * Fetch the latest base branch from origin. Throws when origin exists but
 * can't be reached, so work never silently starts from a stale base. The
 * owner's own checkout and local branches are not touched.
 */
export async function fetchLatestBase(repoPath: string, baseBranch: string): Promise<BaseRef> {
  const remote = await git(repoPath, ['remote', 'get-url', 'origin']);
  if (remote.code !== 0) {
    return { ref: baseBranch, ...(await describeRef(repoPath, baseBranch)), fromRemote: false };
  }
  const ref = `origin/${baseBranch}`;
  const fetched = await exec('git', ['fetch', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/${ref}`], {
    cwd: repoPath,
    timeoutMs: 120_000,
    env: { GIT_TERMINAL_PROMPT: '0' },
  });
  if (fetched.code !== 0) {
    const reason = (fetched.stderr || fetched.stdout).trim().split('\n').slice(-3).join(' ');
    throw new Error(`Couldn't fetch the latest ${baseBranch} from origin, so the run was stopped rather than starting from an old base. ${reason}`);
  }
  return { ref, ...(await describeRef(repoPath, ref)), fromRemote: true };
}

export type BranchSync =
  | 'created' // new branch cut from the latest base
  | 'up-to-date' // existing branch already contains the latest base
  | 'fast-forwarded' // existing branch had no commits of its own; moved to the latest base
  | 'rebased' // existing branch's commits replayed on the latest base
  | 'rebase-conflict' // rebase would conflict; branch left on its old base
  | 'kept-dirty' // uncommitted work from an earlier run; left untouched
  | 'kept-published' // branch is already on GitHub; not rewritten
  | 'not-synced'; // caller asked not to sync (e.g. revisions)

export interface WorktreeResult {
  created: boolean;
  base: BaseRef | null;
  sync: BranchSync;
  /** Commits on the latest base that the branch doesn't have, after syncing. */
  behind: number;
}

async function countBetween(cwd: string, range: string): Promise<number> {
  const r = await git(cwd, ['rev-list', '--count', range]);
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

/**
 * Create (or reuse) an isolated worktree so Claude never touches the owner's
 * checkout. Implementation runs always start from the latest base: a new
 * branch is cut from freshly fetched origin/<base>, and an existing branch is
 * brought up to date when that's safe (fast-forward or a clean rebase). A
 * branch that's already on GitHub, or holds uncommitted work, is never
 * rewritten.
 */
export function ensureWorktree(opts: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  /** Bring an existing branch up to date with the latest base (default true). */
  sync?: boolean;
  /** The branch has been pushed / has a PR, so its history must not change. */
  published?: boolean;
}): Promise<WorktreeResult> {
  const { repoPath, worktreePath, branch, baseBranch } = opts;
  const sync = opts.sync ?? true;

  return withRepoLock(repoPath, async () => {
    const base = sync ? await fetchLatestBase(repoPath, baseBranch) : null;

    let exists = true;
    try {
      await fs.access(path.join(worktreePath, '.git'));
    } catch {
      exists = false;
    }

    if (!exists) {
      await git(repoPath, ['worktree', 'prune']);
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      if (!(await branchExists(repoPath, branch))) {
        const from = base?.ref ?? (await fetchLatestBase(repoPath, baseBranch)).ref;
        await gitOk(repoPath, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, from]);
        return { created: true, base, sync: 'created', behind: 0 };
      }
      await gitOk(repoPath, ['worktree', 'add', worktreePath, branch]);
    }

    if (!base) return { created: !exists, base, sync: 'not-synced', behind: 0 };

    const behind = await countBetween(worktreePath, `HEAD..${base.ref}`);
    const result = (s: BranchSync, b = behind): WorktreeResult => ({ created: !exists, base, sync: s, behind: b });
    if (behind === 0) return result('up-to-date', 0);

    const pushed = (await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).code === 0;
    if (opts.published || pushed) return result('kept-published');
    if (await hasUncommittedChanges(worktreePath)) return result('kept-dirty');

    const ahead = await countBetween(worktreePath, `${base.ref}..HEAD`);
    if (ahead === 0) {
      await gitOk(worktreePath, ['merge', '--ff-only', base.ref]);
      return result('fast-forwarded', 0);
    }
    const rebased = await git(worktreePath, ['rebase', base.ref]);
    if (rebased.code !== 0) {
      await git(worktreePath, ['rebase', '--abort']);
      return result('rebase-conflict');
    }
    return result('rebased', 0);
  });
}

/** Human-readable line for the run log. */
export function describeWorktree(r: WorktreeResult, branch: string): string {
  const at = r.base ? `${r.base.ref} @ ${r.base.sha} “${r.base.subject}”` : '';
  const source = r.base && !r.base.fromRemote ? ' (no origin remote, so the local branch is the latest)' : r.base ? ' (fetched just now)' : '';
  switch (r.sync) {
    case 'created':
      return `Created ${branch} from ${at}${source}`;
    case 'up-to-date':
      return `${branch} already includes the latest ${at}`;
    case 'fast-forwarded':
      return `Moved ${branch} up to the latest ${at}`;
    case 'rebased':
      return `Rebased ${branch} onto the latest ${at}`;
    case 'rebase-conflict':
      return `${branch} is ${r.behind} commit(s) behind ${r.base?.ref}, and rebasing would conflict, so it was left on its old base`;
    case 'kept-dirty':
      return `${branch} has uncommitted work from an earlier run, so it wasn't rebased (${r.behind} commit(s) behind ${r.base?.ref})`;
    case 'kept-published':
      return `${branch} is already on GitHub, so its history wasn't rewritten (${r.behind} commit(s) behind ${r.base?.ref})`;
    default:
      return `Reusing worktree on ${branch}`;
  }
}

/** Short SHA of the commit this branch forked from, for PR descriptions. */
export async function mergeBaseShort(cwd: string, baseBranch: string): Promise<string | null> {
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    const r = await git(cwd, ['merge-base', 'HEAD', ref]);
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim().slice(0, 7);
  }
  return null;
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
  await git(repoPath, ['worktree', 'prune']);
}

export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['status', '--porcelain']);
  return r.code === 0 && r.stdout.trim().length > 0;
}

export async function commitAll(cwd: string, message: string): Promise<boolean> {
  if (!(await hasUncommittedChanges(cwd))) return false;
  await gitOk(cwd, ['add', '-A']);
  await gitOk(cwd, ['commit', '-m', message]);
  return true;
}

/** Number of commits on HEAD that are not on base. */
export async function commitsAhead(cwd: string, base: string): Promise<number> {
  for (const ref of [`origin/${base}`, base]) {
    const r = await git(cwd, ['rev-list', '--count', `${ref}..HEAD`]);
    if (r.code === 0) return Number(r.stdout.trim()) || 0;
  }
  return 0;
}

export async function diffStat(cwd: string, base: string): Promise<string> {
  for (const ref of [`origin/${base}`, base]) {
    const r = await git(cwd, ['diff', '--stat', `${ref}...HEAD`]);
    if (r.code === 0) return r.stdout.trim();
  }
  return '';
}

export async function diff(cwd: string, base: string, maxBytes = 400_000): Promise<string> {
  for (const ref of [`origin/${base}`, base]) {
    const r = await git(cwd, ['diff', `${ref}...HEAD`]);
    if (r.code === 0) return r.stdout.length > maxBytes ? `${r.stdout.slice(0, maxBytes)}\n… diff truncated …` : r.stdout;
  }
  return '';
}

export async function push(cwd: string, branch: string): Promise<void> {
  await gitOk(cwd, ['push', '-u', 'origin', branch]);
}

export async function recentLog(repoPath: string, n = 15): Promise<string> {
  const r = await git(repoPath, ['log', `-${n}`, '--format=%h %cs %s']);
  return r.code === 0 ? r.stdout.trim() : '';
}

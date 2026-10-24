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

/**
 * Create (or reuse) an isolated worktree for a branch so Claude never touches
 * the user's own checkout. New branches start from the freshest base available.
 */
export async function ensureWorktree(opts: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}): Promise<{ created: boolean; base: string }> {
  const { repoPath, worktreePath, branch, baseBranch } = opts;
  try {
    await fs.access(path.join(worktreePath, '.git'));
    return { created: false, base: baseBranch };
  } catch {
    // fall through and create it
  }
  await git(repoPath, ['worktree', 'prune']);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  if (await branchExists(repoPath, branch)) {
    await gitOk(repoPath, ['worktree', 'add', worktreePath, branch]);
    return { created: true, base: branch };
  }

  // Prefer origin/<base> so work starts from what is actually merged upstream.
  let base = baseBranch;
  const fetched = await git(repoPath, ['fetch', 'origin', baseBranch]);
  if (fetched.code === 0) {
    const remoteRef = await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${baseBranch}`]);
    if (remoteRef.code === 0) base = `origin/${baseBranch}`;
  }
  await gitOk(repoPath, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, base]);
  return { created: true, base };
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

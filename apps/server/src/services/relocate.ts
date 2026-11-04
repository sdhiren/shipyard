import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Project, RelocateProjectInput, RelocationCandidate } from '@shipyard/shared';
import { relocateProjectSchema } from '@shipyard/shared';
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { expandHome } from '../config.js';
import { db } from '../db/client.js';
import { items, projects } from '../db/schema.js';
import { bus } from '../lib/events.js';
import { exec } from '../lib/exec.js';
import { badRequest, conflict, HttpError, now } from '../lib/util.js';
import { logActivity } from './activity.js';
import { getGitInfo, repairWorktrees, sameRemote } from './git.js';
import { getProject, getProjectRow } from './projects.js';
import { detectStack } from './scanner.js';

/**
 * Projects are registered by folder path, so moving a repo (or reorganising
 * the Desktop) strands them. This finds where a project went, by its git
 * remote, and points the project at the new folder.
 */

/** Folders never worth searching, by name. */
const SKIP = new Set(['node_modules', 'Library', 'Applications', 'Pictures', 'Movies', 'Music', 'vendor', 'dist', 'build', 'venv', '.venv', 'target']);

interface FoundRepo {
  path: string;
  remoteUrl: string | null;
}

/** Read origin's URL straight from .git/config: no process per folder. */
async function originUrl(repo: string): Promise<string | null> {
  const config = await fs.readFile(path.join(repo, '.git', 'config'), 'utf8').catch(() => '');
  const section = config.split(/^\[/m).find((s) => /^remote\s+"origin"\]/.test(s));
  return section?.match(/^\s*url\s*=\s*(.+)$/m)?.[1]?.trim() ?? null;
}

/**
 * Breadth-first search for git repositories under `roots`, bounded by depth,
 * folder count and time so it stays fast on a big home folder.
 */
export async function findRepos(roots: string[], limits = { maxDepth: 5, maxDirs: 30_000, maxMs: 5_000 }): Promise<FoundRepo[]> {
  const started = Date.now();
  const found: FoundRepo[] = [];
  let queue = roots.map((r) => ({ dir: path.resolve(expandHome(r)), depth: 0 }));
  let visited = 0;
  while (queue.length && visited < limits.maxDirs && Date.now() - started < limits.maxMs) {
    const next: typeof queue = [];
    for (const { dir, depth } of queue) {
      if (++visited > limits.maxDirs) break;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const gitEntry = entries.find((e) => e.name === '.git');
      if (gitEntry?.isDirectory()) {
        found.push({ path: dir, remoteUrl: await originUrl(dir) });
        continue; // don't look inside repositories
      }
      if (depth >= limits.maxDepth) continue;
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) next.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }
    queue = next;
  }
  return found;
}

async function describe(repo: FoundRepo, oldName: string): Promise<RelocationCandidate> {
  const git = (args: string[]) => exec('git', args, { cwd: repo.path, timeoutMs: 10_000 }).then((r) => (r.code === 0 ? r.stdout.trim() : ''));
  const [branch, last, count, status] = await Promise.all([
    git(['branch', '--show-current']),
    git(['log', '-1', '--format=%cI%x00%s']),
    git(['rev-list', '--count', 'HEAD']),
    git(['status', '--porcelain']),
  ]);
  const [lastCommitAt = null, lastCommitMessage = null] = last ? last.split('\0') : [];
  return {
    path: repo.path,
    remoteUrl: repo.remoteUrl,
    branch: branch || null,
    lastCommitAt,
    lastCommitMessage,
    commitCount: Number(count) || 0,
    uncommittedFiles: status ? status.split('\n').length : 0,
    sameName: path.basename(repo.path) === oldName,
  };
}

/**
 * Where might this project have gone? Repos with the same git remote (or, for
 * projects without one, the same folder name), most recently active first.
 */
export async function findRelocationCandidates(projectId: string, roots: string[] = [os.homedir()]): Promise<RelocationCandidate[]> {
  const project = getProjectRow(projectId);
  const oldName = path.basename(project.path);
  const remote = project.git.remoteUrl;
  const taken = new Set(
    db
      .select({ path: projects.path })
      .from(projects)
      .where(ne(projects.id, projectId))
      .all()
      .map((p) => p.path),
  );
  const repos = (await findRepos(roots)).filter(
    (r) => r.path !== project.path && !taken.has(r.path) && (remote ? sameRemote(r.remoteUrl, remote) : path.basename(r.path) === oldName),
  );
  const described = await Promise.all(repos.slice(0, 10).map((r) => describe(r, oldName)));
  // Most recently active first; then the fuller history; then a matching folder name.
  return described.sort(
    (a, b) =>
      (b.lastCommitAt ?? '').localeCompare(a.lastCommitAt ?? '') || b.commitCount - a.commitCount || Number(b.sameName) - Number(a.sameName),
  );
}

/**
 * Point a project at a new folder. The folder must exist and must not belong
 * to another project; a different git remote needs `force`. Worktrees that
 * Shipyard created from the old location are repaired.
 */
export async function relocateProject(projectId: string, input: RelocateProjectInput): Promise<Project> {
  const project = getProjectRow(projectId);
  const { path: rawPath, force } = relocateProjectSchema.parse(input);
  const target = path.resolve(expandHome(rawPath.trim()));

  const stat = await fs.stat(target).catch(() => null);
  if (!stat?.isDirectory()) throw badRequest(`No folder at ${target}`);
  if (target === project.path) return getProject(projectId);
  const owner = db.select({ name: projects.name }).from(projects).where(eq(projects.path, target)).get();
  if (owner) throw conflict(`That folder is already the project "${owner.name}"`);

  const git = await getGitInfo(target);
  if (project.git.isRepo && !git.isRepo) throw badRequest(`${target} is not a git repository`);
  if (!force && project.git.remoteUrl && git.remoteUrl && !sameRemote(project.git.remoteUrl, git.remoteUrl)) {
    throw new HttpError(409, `That folder's git remote (${git.remoteUrl}) is not this project's (${project.git.remoteUrl}). Choose another folder, or confirm to use it anyway.`);
  }

  const stack = await detectStack(target);
  const worktrees = db
    .select({ path: items.worktreePath })
    .from(items)
    .where(and(eq(items.projectId, projectId), isNotNull(items.worktreePath)))
    .all()
    .map((r) => r.path!)
    .filter((p) => !!p);
  const existing = (await Promise.all(worktrees.map(async (p) => ((await fs.stat(p).catch(() => null)) ? p : null)))).filter((p): p is string => !!p);
  const repaired = git.isRepo ? await repairWorktrees(target, existing) : true;

  db.update(projects).set({ path: target, git, stack, lastScannedAt: now(), updatedAt: now() }).where(eq(projects.id, projectId)).run();
  logActivity({
    projectId,
    kind: 'updated',
    message: `Project folder moved: ${project.path} → ${target}${existing.length ? (repaired ? ` (repaired ${existing.length} worktree(s))` : ' (some worktrees could not be repaired)') : ''}`,
    meta: { from: project.path, to: target },
  });
  bus.publish({ type: 'project.changed', projectId });
  return getProject(projectId);
}

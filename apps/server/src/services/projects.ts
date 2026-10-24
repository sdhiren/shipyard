import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ACTIVE_RUN_STATUSES,
  projectSettingsSchema,
  type CreateProjectInput,
  type DiscoveredRepo,
  type ImportCandidate,
  type Project,
  type ProjectWithStats,
  type UpdateProjectInput,
} from '@shipyard/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { expandHome } from '../config.js';
import { db } from '../db/client.js';
import { items, projects, runs, type ProjectRow } from '../db/schema.js';
import { bus } from '../lib/events.js';
import { badRequest, conflict, keyPrefixFor, newId, notFound, now, pickColor, slugify } from '../lib/util.js';
import { createItem } from './items.js';
import { getGitInfo } from './git.js';
import { listOpenIssues } from './github.js';
import { toProject } from './mappers.js';
import { discoverRepos, detectStack, scanBacklogFiles, scanTodoComments, suggestAllowedTools, suggestTestCommand, type RawImport } from './scanner.js';
import { getSettings } from './settings.js';

export function getProjectRow(id: string): ProjectRow {
  const row = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!row) throw notFound('Project');
  return row;
}

export function getProject(id: string): Project {
  return toProject(getProjectRow(id));
}

export function listProjects(opts: { includeArchived?: boolean } = {}): ProjectWithStats[] {
  const rows = db
    .select()
    .from(projects)
    .where(opts.includeArchived ? undefined : eq(projects.archived, false))
    .all();

  const counts = db
    .select({ projectId: items.projectId, status: items.status, n: sql<number>`count(*)` })
    .from(items)
    .groupBy(items.projectId, items.status)
    .all();
  const active = db
    .select({ projectId: runs.projectId, n: sql<number>`count(*)` })
    .from(runs)
    .where(inArray(runs.status, ACTIVE_RUN_STATUSES))
    .groupBy(runs.projectId)
    .all();

  return rows
    .map((row) => {
      const c = (s: string) => counts.find((x) => x.projectId === row.id && x.status === s)?.n ?? 0;
      return {
        ...toProject(row),
        stats: {
          inbox: c('proposed'),
          open: c('backlog') + c('planned') + c('in_progress') + c('in_review'),
          inProgress: c('in_progress'),
          inReview: c('in_review'),
          done: c('done'),
          activeRuns: active.find((a) => a.projectId === row.id)?.n ?? 0,
        },
      };
    })
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const repoPath = path.resolve(expandHome(input.path.trim()));
  const stat = await fs.stat(repoPath).catch(() => null);
  if (!stat?.isDirectory()) throw badRequest(`Not a directory: ${repoPath}`);
  if (db.select().from(projects).where(eq(projects.path, repoPath)).get()) throw conflict('That folder is already a project');

  const [stack, git] = await Promise.all([detectStack(repoPath), getGitInfo(repoPath)]);
  const name = input.name?.trim() || path.basename(repoPath);
  const defaults = getSettings().defaultProjectSettings;
  const settings = projectSettingsSchema.parse({
    ...defaults,
    testCommand: await suggestTestCommand(repoPath, stack),
    allowedTools: suggestAllowedTools(stack),
    autoPr: Boolean(git.githubRepo),
  });

  const ts = now();
  const row: ProjectRow = {
    id: newId('prj'),
    name,
    slug: slugify(name),
    keyPrefix: keyPrefixFor(name),
    path: repoPath,
    description: input.description ?? (await readmeTagline(repoPath)),
    color: input.color ?? pickColor(name),
    pinned: false,
    archived: false,
    stack,
    git,
    settings,
    health: null,
    nextItemNumber: 1,
    lastAnalyzedAt: null,
    lastScannedAt: ts,
    createdAt: ts,
    updatedAt: ts,
  };
  db.insert(projects).values(row).run();
  bus.publish({ type: 'project.changed', projectId: row.id });
  return toProject(row);
}

/** First prose paragraph of the README, as a default description. */
async function readmeTagline(repoPath: string): Promise<string> {
  const md = await fs.readFile(path.join(repoPath, 'README.md'), 'utf8').catch(() => '');
  for (const block of md.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t || /^(#|!\[|\[!\[|<|```|\||-{3,})/.test(t)) continue;
    return t
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) → text
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .slice(0, 280);
  }
  return '';
}

export function updateProject(id: string, input: UpdateProjectInput): Project {
  const row = getProjectRow(id);
  const settings = input.settings ? projectSettingsSchema.parse({ ...row.settings, ...input.settings }) : row.settings;
  db.update(projects)
    .set({
      name: input.name ?? row.name,
      description: input.description ?? row.description,
      color: input.color ?? row.color,
      pinned: input.pinned ?? row.pinned,
      archived: input.archived ?? row.archived,
      settings,
      updatedAt: now(),
    })
    .where(eq(projects.id, id))
    .run();
  bus.publish({ type: 'project.changed', projectId: id });
  return getProject(id);
}

/** Re-detect stack and git state (cheap; no AI). */
export async function rescanProject(id: string): Promise<Project> {
  const row = getProjectRow(id);
  const [stack, git] = await Promise.all([detectStack(row.path), getGitInfo(row.path)]);
  db.update(projects).set({ stack, git, lastScannedAt: now(), updatedAt: now() }).where(eq(projects.id, id)).run();
  bus.publish({ type: 'project.changed', projectId: id });
  return getProject(id);
}

export function deleteProject(id: string): void {
  getProjectRow(id);
  const busy = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.projectId, id), inArray(runs.status, ACTIVE_RUN_STATUSES)))
    .get();
  if (busy) throw conflict('Cancel the active runs for this project first');
  db.delete(projects).where(eq(projects.id, id)).run();
  bus.publish({ type: 'project.changed', projectId: id });
}

export async function discover(): Promise<DiscoveredRepo[]> {
  const known = new Set(db.select({ path: projects.path }).from(projects).all().map((p) => p.path));
  return discoverRepos(getSettings().discoveryRoots, known);
}

// ---------------------------------------------------------------------------
// Importing existing backlog sources
// ---------------------------------------------------------------------------

async function gatherImports(row: ProjectRow): Promise<RawImport[]> {
  const out: RawImport[] = [...(await scanBacklogFiles(row.path)), ...(await scanTodoComments(row.path))];
  if (row.git.githubRepo) {
    for (const issue of await listOpenIssues(row.git.githubRepo)) {
      out.push({
        title: issue.title,
        description: `${issue.body || ''}\n\nGitHub issue: ${issue.url}`.trim(),
        sourceRef: `#${issue.number}`,
        source: 'github_issue',
        type: issue.labels.some((l) => /bug/i.test(l)) ? 'bug' : 'feature',
      });
    }
  }
  return out;
}

export async function previewImports(id: string): Promise<ImportCandidate[]> {
  const row = getProjectRow(id);
  const existing = new Set(
    db
      .select({ ref: items.sourceRef })
      .from(items)
      .where(eq(items.projectId, id))
      .all()
      .map((r) => r.ref)
      .filter(Boolean),
  );
  return (await gatherImports(row)).map((r) => ({
    title: r.title,
    description: r.description,
    source: r.source,
    sourceRef: r.sourceRef,
    type: r.type,
    alreadyImported: existing.has(r.sourceRef),
  }));
}

/** Import the selected candidates into the Inbox (status "proposed"). */
export async function applyImports(id: string, sourceRefs: string[]): Promise<number> {
  const row = getProjectRow(id);
  const wanted = new Set(sourceRefs);
  const candidates = (await gatherImports(row)).filter((r) => wanted.has(r.sourceRef));
  for (const c of candidates) {
    createItem(
      id,
      {
        title: c.title,
        description: c.description,
        type: c.type,
        priority: c.priority ?? 'p2',
        effort: c.effort ?? null,
        status: 'proposed',
        source: c.source,
      },
      { sourceRef: c.sourceRef, silent: true },
    );
  }
  bus.publish({ type: 'items.changed', projectId: id });
  return candidates.length;
}

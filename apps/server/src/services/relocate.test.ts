import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A project whose folder was moved: detection, a clear error instead of
 * "spawn claude ENOENT", finding the new folder by git remote, relocating,
 * and repairing a worktree created from the old location.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-relocate-')));
process.env.SHIPYARD_DATA_DIR = path.join(tmp, 'data');
// No real claude: sign-in status reads as unknown, so it never blocks these tests.
process.env.SHIPYARD_CLAUDE_BIN = path.join(tmp, 'no-such-claude');
Object.assign(process.env, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' });

const home = path.join(tmp, 'home');
const oldPath = path.join(home, 'Desktop', 'url-shortener');
const newPath = path.join(home, 'Documents', 'Desktop Items', 'Go', 'url-shortener');
const staleCopy = path.join(home, 'Documents', 'Desktop Items', 'Old Mac', 'url-shortener');
const unrelated = path.join(home, 'code', 'other-repo');
const worktree = path.join(tmp, 'worktrees', 'us-1');

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
function makeRepo(dir: string, remote: string, commits: number, date?: string) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', remote);
  for (let i = 0; i < commits; i++) {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), `${i}\n`);
    git(dir, 'add', '-A');
    execFileSync('git', ['commit', '-qm', `commit ${i}`], { cwd: dir, stdio: 'pipe', env: { ...process.env, ...(date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {}) } });
  }
}

let app: FastifyInstance;
let relocate: typeof import('./relocate.js');
const H = { 'x-shipyard': '1' };
let projectId = '';
let itemId = '';

beforeAll(async () => {
  makeRepo(oldPath, 'git@github.com:me/url-shortener.git', 3);
  git(oldPath, 'worktree', 'add', '-q', '-b', 'shipyard/us-1', worktree);
  makeRepo(staleCopy, 'https://github.com/me/url-shortener', 1, '2024-03-01T12:00:00Z'); // an old copy
  makeRepo(unrelated, 'git@github.com:me/other-repo.git', 1);

  const { runMigrations } = await import('../db/client.js');
  runMigrations();
  app = await (await import('../app.js')).buildApp({ logger: false });
  relocate = await import('./relocate.js');

  const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { path: oldPath } })).json();
  projectId = p.id;
  itemId = (await app.inject({ method: 'POST', url: `/api/projects/${projectId}/items`, headers: H, payload: { title: 'Rate limiting' } })).json().id;
  const { patchItem } = await import('./items.js');
  patchItem(itemId, { branch: 'shipyard/us-1', worktreePath: worktree });

  // Reorganising the Desktop moves the repo; the worktree's links now dangle.
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.renameSync(oldPath, newPath);
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a moved project folder', () => {
  it('is flagged as missing', async () => {
    const p = (await app.inject({ url: `/api/projects/${projectId}` })).json();
    expect(p).toMatchObject({ folderMissing: true, path: oldPath });
  });

  it('refuses to start Claude with a clear message instead of "spawn claude ENOENT"', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/items/${itemId}/decision`, headers: H, payload: { decision: 'plan' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain(`was not found at ${oldPath}`);
  });

  it("won't rescan a missing folder (that would erase the remote used to find it)", async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/rescan`, headers: H, payload: {} });
    expect(res.statusCode).toBe(409);
    expect((await app.inject({ url: `/api/projects/${projectId}` })).json().git.remoteUrl).toBe('git@github.com:me/url-shortener.git');
  });

  it('finds candidate folders by git remote, most recently active first', async () => {
    const found = await relocate.findRelocationCandidates(projectId, [home]);
    expect(found.map((c) => c.path)).toEqual([newPath, staleCopy]);
    expect(found.find((c) => c.path === newPath)).toMatchObject({ commitCount: 3, branch: 'main', sameName: true });
    expect(found.some((c) => c.path === unrelated)).toBe(false);
  });

  it('asks for confirmation before using a folder with a different remote', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/relocate`, headers: H, payload: { path: unrelated } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('is not this project');
  });

  it('rejects a folder that does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/relocate`, headers: H, payload: { path: path.join(home, 'nope') } });
    expect(res.statusCode).toBe(400);
  });

  it('relocates, rescans and repairs worktrees made from the old location', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/relocate`, headers: H, payload: { path: newPath } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ path: newPath, folderMissing: false, git: { isRepo: true, remoteUrl: 'git@github.com:me/url-shortener.git' } });

    // The worktree works again: git inside it resolves to the moved repository.
    expect(fs.readFileSync(path.join(worktree, '.git'), 'utf8')).toContain(newPath);
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('shipyard/us-1');
    expect(git(newPath, 'worktree', 'list')).toContain(worktree);

    const activity = (await app.inject({ url: `/api/projects/${projectId}/activity` })).json() as { message: string }[];
    expect(activity[0]!.message).toContain(`Project folder moved: ${oldPath} → ${newPath} (repaired 1 worktree(s))`);
  });

  it('refuses a folder that already belongs to another project', async () => {
    const other = (await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { path: unrelated } })).json();
    const res = await app.inject({ method: 'POST', url: `/api/projects/${other.id}/relocate`, headers: H, payload: { path: newPath, force: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('already the project');
  });
});

describe('runner', () => {
  it('names a missing working folder instead of blaming the claude binary', async () => {
    const { runClaude } = await import('./claude/runner.js');
    const r = await runClaude({ prompt: 'x', cwd: path.join(tmp, 'gone'), model: 'm', mode: 'readonly', onEvent: () => {} });
    expect(r.error).toBe(`The folder Claude should work in no longer exists: ${path.join(tmp, 'gone')}. If the project was moved, update its location in Shipyard.`);
  });
});

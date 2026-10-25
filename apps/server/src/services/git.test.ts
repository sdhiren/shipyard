import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureWorktree, fetchLatestBase } from './git.js';

/**
 * Real git, no mocks: a bare "GitHub" remote, the owner's checkout, and a
 * second clone standing in for other work that lands on main meanwhile.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-git-'));
const remote = path.join(tmp, 'remote.git');
const checkout = path.join(tmp, 'checkout'); // the owner's repo that Shipyard manages
const other = path.join(tmp, 'other'); // someone else merging PRs into main
const wt = (name: string) => path.join(tmp, 'worktrees', name);

Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
const head = (cwd: string, ref = 'HEAD') => git(cwd, 'rev-parse', ref);
const commitFile = (cwd: string, file: string, content: string, msg: string) => {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-qm', msg);
};
/** Land a commit on the remote's main, as if another PR merged. */
const landOnMain = (file: string, content: string, msg: string) => {
  git(other, 'pull', '-q', '--rebase', 'origin', 'main');
  commitFile(other, file, content, msg);
  git(other, 'push', '-q', 'origin', 'main');
  return head(other);
};

beforeAll(() => {
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  git(tmp, 'clone', '-q', remote, checkout);
  git(checkout, 'checkout', '-q', '-b', 'main');
  commitFile(checkout, 'README.md', 'v1\n', 'init');
  git(checkout, 'push', '-q', '-u', 'origin', 'main');
  git(tmp, 'clone', '-q', remote, other);
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('ensureWorktree always starts from the latest main', () => {
  it('cuts a new branch from freshly fetched origin/main, even when the local main is stale', async () => {
    const latest = landOnMain('a.txt', 'a\n', 'feat: a');
    const localMainBefore = head(checkout, 'main');

    const r = await ensureWorktree({ repoPath: checkout, worktreePath: wt('us-1'), branch: 'shipyard/us-1', baseBranch: 'main' });

    expect(r).toMatchObject({ created: true, sync: 'created', base: { ref: 'origin/main', fromRemote: true } });
    expect(head(wt('us-1'))).toBe(latest);
    // The owner's checkout and local main are left alone.
    expect(head(checkout, 'main')).toBe(localMainBefore);
    expect(git(checkout, 'status', '--porcelain')).toBe('');
  });

  it('fast-forwards an existing branch that has no commits of its own', async () => {
    const latest = landOnMain('b.txt', 'b\n', 'feat: b');
    const r = await ensureWorktree({ repoPath: checkout, worktreePath: wt('us-1'), branch: 'shipyard/us-1', baseBranch: 'main' });
    expect(r).toMatchObject({ created: false, sync: 'fast-forwarded', behind: 0 });
    expect(head(wt('us-1'))).toBe(latest);
  });

  it('reports up-to-date when nothing new landed', async () => {
    const r = await ensureWorktree({ repoPath: checkout, worktreePath: wt('us-1'), branch: 'shipyard/us-1', baseBranch: 'main' });
    expect(r.sync).toBe('up-to-date');
  });

  it("rebases an existing branch's own commits onto the latest main", async () => {
    commitFile(wt('us-1'), 'work.txt', 'mine\n', 'wip: my change');
    const latest = landOnMain('c.txt', 'c\n', 'feat: c');

    const r = await ensureWorktree({ repoPath: checkout, worktreePath: wt('us-1'), branch: 'shipyard/us-1', baseBranch: 'main' });

    expect(r).toMatchObject({ sync: 'rebased', behind: 0 });
    expect(head(wt('us-1'), 'HEAD~1')).toBe(latest);
    expect(fs.readFileSync(path.join(wt('us-1'), 'work.txt'), 'utf8')).toBe('mine\n');
  });

  it('leaves the branch on its old base when a rebase would conflict', async () => {
    commitFile(wt('us-1'), 'README.md', 'my version\n', 'docs: mine');
    const before = head(wt('us-1'));
    landOnMain('README.md', 'their version\n', 'docs: theirs');

    const r = await ensureWorktree({ repoPath: checkout, worktreePath: wt('us-1'), branch: 'shipyard/us-1', baseBranch: 'main' });

    expect(r).toMatchObject({ sync: 'rebase-conflict', behind: 1 });
    expect(head(wt('us-1'))).toBe(before);
    expect(git(wt('us-1'), 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(checkout, '.git', 'worktrees', 'us-1', 'rebase-merge'))).toBe(false);
  });

  it('never rewrites a branch that is already on GitHub', async () => {
    git(wt('us-1'), 'push', '-q', '-u', 'origin', 'shipyard/us-1');
    const before = head(wt('us-1'));
    landOnMain('d.txt', 'd\n', 'feat: d');

    const r = await ensureWorktree({ repoPath: checkout, worktreePath: wt('us-1'), branch: 'shipyard/us-1', baseBranch: 'main' });

    expect(r.sync).toBe('kept-published');
    expect(r.behind).toBeGreaterThan(0);
    expect(head(wt('us-1'))).toBe(before);
  });

  it('keeps uncommitted work from an earlier run untouched', async () => {
    await ensureWorktree({ repoPath: checkout, worktreePath: wt('us-2'), branch: 'shipyard/us-2', baseBranch: 'main' });
    fs.writeFileSync(path.join(wt('us-2'), 'draft.txt'), 'half done\n');
    landOnMain('e.txt', 'e\n', 'feat: e');

    const r = await ensureWorktree({ repoPath: checkout, worktreePath: wt('us-2'), branch: 'shipyard/us-2', baseBranch: 'main' });

    expect(r.sync).toBe('kept-dirty');
    expect(fs.readFileSync(path.join(wt('us-2'), 'draft.txt'), 'utf8')).toBe('half done\n');
  });

  it('re-creates a cleaned-up worktree for an existing branch and syncs it', async () => {
    git(checkout, 'worktree', 'add', '-q', wt('us-3'), '-b', 'shipyard/us-3', 'origin/main');
    git(checkout, 'worktree', 'remove', '--force', wt('us-3'));
    const latest = landOnMain('f.txt', 'f\n', 'feat: f');

    const r = await ensureWorktree({ repoPath: checkout, worktreePath: wt('us-3'), branch: 'shipyard/us-3', baseBranch: 'main' });

    expect(r).toMatchObject({ created: true, sync: 'fast-forwarded' });
    expect(head(wt('us-3'))).toBe(latest);
  });

  it('serialises parallel setups in the same repo', async () => {
    const latest = landOnMain('g.txt', 'g\n', 'feat: g');
    const results = await Promise.all(
      ['p1', 'p2', 'p3', 'p4'].map((n) => ensureWorktree({ repoPath: checkout, worktreePath: wt(n), branch: `shipyard/${n}`, baseBranch: 'main' })),
    );
    expect(results.every((r) => r.sync === 'created')).toBe(true);
    for (const n of ['p1', 'p2', 'p3', 'p4']) expect(head(wt(n))).toBe(latest);
  });

  it('skips syncing for revisions', async () => {
    landOnMain('h.txt', 'h\n', 'feat: h');
    const before = head(wt('p1'));
    const r = await ensureWorktree({ repoPath: checkout, worktreePath: wt('p1'), branch: 'shipyard/p1', baseBranch: 'main', sync: false });
    expect(r.sync).toBe('not-synced');
    expect(head(wt('p1'))).toBe(before);
  });
});

describe('fetchLatestBase', () => {
  it('stops with a clear error instead of using a stale base when origin is unreachable', async () => {
    const broken = path.join(tmp, 'broken');
    git(tmp, 'clone', '-q', remote, broken);
    git(broken, 'remote', 'set-url', 'origin', path.join(tmp, 'does-not-exist.git'));
    await expect(fetchLatestBase(broken, 'main')).rejects.toThrow(/Couldn't fetch the latest main from origin/);
    await expect(
      ensureWorktree({ repoPath: broken, worktreePath: wt('broken'), branch: 'shipyard/x', baseBranch: 'main' }),
    ).rejects.toThrow(/stopped rather than starting from an old base/);
    expect(fs.existsSync(wt('broken'))).toBe(false);
  });

  it('uses the local branch when the repo has no remote', async () => {
    const local = path.join(tmp, 'local-only');
    fs.mkdirSync(local);
    git(local, 'init', '-q', '-b', 'main');
    commitFile(local, 'x.txt', 'x\n', 'init');
    const base = await fetchLatestBase(local, 'main');
    expect(base).toMatchObject({ ref: 'main', fromRemote: false, subject: 'init' });
  });
});

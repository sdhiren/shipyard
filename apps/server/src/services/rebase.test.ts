import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * "Rebase onto main" end to end against real git. Claude is replaced by a
 * small script that resolves conflicts, gives up, or leaves markers behind,
 * depending on FAKE_CLAUDE_MODE.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-rebase-'));
const remote = path.join(tmp, 'remote.git');
const checkout = path.join(tmp, 'checkout');
const other = path.join(tmp, 'other');
const fakeClaude = path.join(tmp, 'fake-claude.sh');

fs.writeFileSync(
  fakeClaude,
  `#!/bin/sh
cat > /dev/null
ok='{"type":"result","subtype":"success","is_error":false,"result":"Kept both changes.","session_id":"fake","total_cost_usd":0,"num_turns":1,"duration_ms":1}'
case "$FAKE_CLAUDE_MODE" in
  resolve)
    for f in $(git diff --name-only --diff-filter=U); do printf 'theirs\\nmine\\n' > "$f"; git add "$f"; done
    git rebase --continue > /dev/null 2>&1
    echo "$ok" ;;
  markers)
    for f in $(git diff --name-only --diff-filter=U); do git add "$f"; done
    git rebase --continue > /dev/null 2>&1
    echo "$ok" ;;
  *)
    echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Gave up.","session_id":"fake","total_cost_usd":0,"num_turns":1}' ;;
esac
`,
  { mode: 0o755 },
);

process.env.SHIPYARD_DATA_DIR = path.join(tmp, 'data');
process.env.SHIPYARD_CLAUDE_BIN = fakeClaude;
Object.assign(process.env, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
const sha = (cwd: string, ref = 'HEAD') => git(cwd, 'rev-parse', ref);
const commit = (cwd: string, file: string, content: string, msg: string) => {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-qm', msg);
};
const landOnMain = (file: string, content: string) => {
  git(other, 'checkout', '-q', 'main');
  git(other, 'pull', '-q', '--rebase', 'origin', 'main');
  commit(other, file, content, `main: ${file}`);
  git(other, 'push', '-q', 'origin', 'main');
};

type S = {
  agent: typeof import('./agent.js');
  items: typeof import('./items.js');
  runs: typeof import('./runs.js');
  gitSvc: typeof import('./git.js');
  activity: typeof import('./activity.js');
};
let s: S;
let projectId = '';

beforeAll(async () => {
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  git(tmp, 'clone', '-q', remote, checkout);
  git(checkout, 'checkout', '-q', '-b', 'main');
  commit(checkout, 'shared.txt', 'original\n', 'init');
  git(checkout, 'push', '-q', '-u', 'origin', 'main');
  git(tmp, 'clone', '-q', remote, other);

  const { runMigrations } = await import('../db/client.js');
  runMigrations();
  s = {
    agent: await import('./agent.js'),
    items: await import('./items.js'),
    runs: await import('./runs.js'),
    gitSvc: await import('./git.js'),
    activity: await import('./activity.js'),
  };
  const projects = await import('./projects.js');
  projectId = (await projects.createProject({ path: checkout, name: 'demo' })).id;
});

/** An in-review item whose branch is on origin with one commit of its own. */
async function itemWithPushedBranch(name: string, file: string, content: string) {
  const item = s.items.createItem(projectId, { title: `Work ${name}`, status: 'in_review' });
  const branch = `shipyard/${name}`;
  const worktreePath = path.join(tmp, 'worktrees', name);
  await s.gitSvc.ensureWorktree({ repoPath: checkout, worktreePath, branch, baseBranch: 'main' });
  commit(worktreePath, file, content, `feat: ${name}`);
  git(worktreePath, 'push', '-q', '-u', 'origin', branch);
  s.items.patchItem(item.id, { branch, worktreePath });
  return { id: item.id, branch, worktreePath };
}

async function rebaseAndWait(itemId: string) {
  const run = s.agent.startRebase(itemId);
  for (let i = 0; i < 200; i++) {
    const r = s.runs.getRun(run.id);
    if (r.status !== 'queued' && r.status !== 'running') return r;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('rebase run did not finish');
}

const remoteSha = (branch: string) => git(remote, 'rev-parse', `refs/heads/${branch}`);

describe('rebase onto the latest main', () => {
  it('rebases cleanly without Claude and force-pushes with lease', async () => {
    const it1 = await itemWithPushedBranch('clean', 'clean.txt', 'mine\n');
    landOnMain('a.txt', 'a\n');

    const run = await rebaseAndWait(it1.id);

    expect(run).toMatchObject({ status: 'succeeded', summary: expect.stringContaining('with no conflicts') });
    expect(sha(it1.worktreePath, 'HEAD~1')).toBe(sha(checkout, 'origin/main'));
    expect(remoteSha(it1.branch)).toBe(sha(it1.worktreePath));
    expect(fs.readFileSync(path.join(it1.worktreePath, 'clean.txt'), 'utf8')).toBe('mine\n');
  });

  it('reports already up to date when there is nothing to do', async () => {
    const it1 = s.items.listItems(projectId, { q: 'Work clean' })[0]!;
    const run = await rebaseAndWait(it1.id);
    expect(run).toMatchObject({ status: 'succeeded', summary: 'Already up to date' });
  });

  it('keeps commits that were pushed to the PR branch from elsewhere', async () => {
    const it2 = await itemWithPushedBranch('pulled', 'pulled.txt', 'one\n');
    git(other, 'fetch', '-q', 'origin');
    git(other, 'checkout', '-q', '-b', 'pulled-copy', `origin/${it2.branch}`);
    commit(other, 'from-github.txt', 'added on GitHub\n', 'fix: suggestion applied on GitHub');
    git(other, 'push', '-q', 'origin', `HEAD:${it2.branch}`);
    landOnMain('b.txt', 'b\n');

    const run = await rebaseAndWait(it2.id);

    expect(run.status).toBe('succeeded');
    expect(fs.existsSync(path.join(it2.worktreePath, 'from-github.txt'))).toBe(true);
    expect(git(it2.worktreePath, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD')).toBe('');
  });

  it('hands conflicts to Claude, verifies the result and pushes it', async () => {
    process.env.FAKE_CLAUDE_MODE = 'resolve';
    const it3 = await itemWithPushedBranch('conflict-ok', 'shared.txt', 'mine\n');
    landOnMain('shared.txt', 'theirs\n');

    const run = await rebaseAndWait(it3.id);

    expect(run).toMatchObject({ status: 'succeeded', summary: expect.stringContaining('Claude resolved conflicts in 1 file') });
    expect(fs.readFileSync(path.join(it3.worktreePath, 'shared.txt'), 'utf8')).toBe('theirs\nmine\n');
    expect(remoteSha(it3.branch)).toBe(sha(it3.worktreePath));
    const log = s.activity.listActivity({ itemId: it3.id }).map((a) => a.message);
    expect(log.some((m) => m.includes('Claude resolved conflicts'))).toBe(true);
  });

  it('restores the branch when Claude cannot resolve the conflict', async () => {
    process.env.FAKE_CLAUDE_MODE = 'fail';
    const it4 = await itemWithPushedBranch('conflict-fail', 'shared.txt', 'mine again\n');
    const before = sha(it4.worktreePath);
    const remoteBefore = remoteSha(it4.branch);
    landOnMain('shared.txt', 'theirs again\n');

    const run = await rebaseAndWait(it4.id);

    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/Couldn't finish the rebase.*was restored/);
    expect(sha(it4.worktreePath)).toBe(before);
    expect(await s.gitSvc.isRebaseInProgress(it4.worktreePath)).toBe(false);
    expect(git(it4.worktreePath, 'status', '--porcelain')).toBe('');
    expect(remoteSha(it4.branch)).toBe(remoteBefore);
  });

  it('refuses to push when conflict markers are left behind', async () => {
    process.env.FAKE_CLAUDE_MODE = 'markers';
    const it5 = await itemWithPushedBranch('conflict-markers', 'shared.txt', 'mine thrice\n');
    const before = sha(it5.worktreePath);
    landOnMain('shared.txt', 'theirs thrice\n');

    const run = await rebaseAndWait(it5.id);

    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/conflict markers remain in shared\.txt/);
    expect(sha(it5.worktreePath)).toBe(before);
  });
});

describe('needs-rebase flags', () => {
  it('derives needsRebase / behindBase from GitHub mergeability', async () => {
    const item = s.items.createItem(projectId, { title: 'Flag check' });
    const set = (prMergeable: 'CONFLICTING' | 'MERGEABLE' | null, prMergeState: string | null, prState: 'OPEN' | 'MERGED' = 'OPEN') =>
      s.items.patchItem(item.id, { prNumber: 7, prUrl: 'https://example.com/pr/7', prState, prMergeable, prMergeState }).pr!;

    expect(set('CONFLICTING', 'DIRTY')).toMatchObject({ needsRebase: true, behindBase: false });
    expect(set('MERGEABLE', 'BEHIND')).toMatchObject({ needsRebase: false, behindBase: true });
    expect(set('MERGEABLE', 'CLEAN')).toMatchObject({ needsRebase: false, behindBase: false });
    expect(set('CONFLICTING', 'DIRTY', 'MERGED')).toMatchObject({ needsRebase: false });
  });
});

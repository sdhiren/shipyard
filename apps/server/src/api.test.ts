import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * End-to-end API tests against a real SQLite database and a throwaway git repo.
 * No Claude or GitHub calls are made.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-test-'));
process.env.SHIPYARD_DATA_DIR = path.join(tmp, 'data');

const repo = path.join(tmp, 'demo-repo');
fs.mkdirSync(repo);
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }));
fs.writeFileSync(path.join(repo, 'README.md'), '# Demo\n\nA [demo](https://example.com) **repo** for tests.\n');
fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '## P1 — Features\n\n- [ ] **F-01 · Export to CSV (S)**: download notes.\n- [x] Done thing\n');
fs.writeFileSync(path.join(repo, 'app.js'), '// TODO: handle empty input gracefully\nexport const x = 1;\n');
git('add', '-A');
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');

let app: FastifyInstance;
const H = { 'x-shipyard': '1' };

beforeAll(async () => {
  const { runMigrations } = await import('./db/client.js');
  runMigrations();
  const { buildApp } = await import('./app.js');
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Shipyard API', () => {
  let projectId = '';
  let itemId = '';

  it('rejects state-changing requests without the X-Shipyard header', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: repo } });
    expect(res.statusCode).toBe(403);
  });

  it('registers a project and detects its stack', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { path: repo } });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    projectId = p.id;
    expect(p.stack.languages).toContain('JavaScript');
    expect(p.settings.testCommand).toBe('npm test');
    expect(p.description).toBe('A demo repo for tests.');
    expect(p.git).toMatchObject({ isRepo: true, defaultBranch: 'main' });
  });

  it('refuses to register the same folder twice', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { path: repo } });
    expect(res.statusCode).toBe(409);
  });

  it('previews and applies imports into the Inbox', async () => {
    const preview = (await app.inject({ url: `/api/projects/${projectId}/imports` })).json() as { sourceRef: string; source: string }[];
    expect(preview.map((c) => c.sourceRef)).toEqual(expect.arrayContaining(['BACKLOG.md:F-01', 'app.js:1']));
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/imports`, headers: H, payload: { sourceRefs: ['BACKLOG.md:F-01'] } });
    expect(res.json()).toEqual({ imported: 1 });
    const inbox = (await app.inject({ url: `/api/projects/${projectId}/items?status=proposed` })).json();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ key: 'DR-1', title: 'Export to CSV', effort: 's', priority: 'p1', status: 'proposed' });
  });

  it('creates an item manually', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/items`,
      headers: H,
      payload: { title: 'Add search', priority: 'p1', effort: 's', impact: 4, status: 'planned' },
    });
    expect(res.statusCode).toBe(201);
    const item = res.json();
    itemId = item.id;
    expect(item).toMatchObject({ key: 'DR-2', status: 'planned', score: 2 });
  });

  it('PATCH changes only the fields sent (regression: zod partial defaults)', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/items/${itemId}`, headers: H, payload: { title: 'Add full-text search' } });
    expect(res.json()).toMatchObject({ title: 'Add full-text search', status: 'planned', priority: 'p1', effort: 's', impact: 4 });

    const p = await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}`, headers: H, payload: { settings: { model: 'haiku' } } });
    expect(p.json().settings).toMatchObject({ model: 'haiku', testCommand: 'npm test' });
    expect(p.json().settings.allowedTools.length).toBeGreaterThan(0);
  });

  it('applies decisions and records them in the timeline', async () => {
    const skip = await app.inject({ method: 'POST', url: `/api/items/${itemId}/decision`, headers: H, payload: { decision: 'skip', reason: 'not now' } });
    expect(skip.json().item).toMatchObject({ status: 'skipped', decisionReason: 'not now' });
    const restore = await app.inject({ method: 'POST', url: `/api/items/${itemId}/decision`, headers: H, payload: { decision: 'restore' } });
    expect(restore.json().item.status).toBe('backlog');

    const until = new Date(Date.now() + 86_400_000).toISOString();
    await app.inject({ method: 'POST', url: `/api/items/${itemId}/decision`, headers: H, payload: { decision: 'snooze', until } });
    const visible = (await app.inject({ url: `/api/projects/${projectId}/items?status=backlog` })).json();
    expect(visible.find((i: { id: string }) => i.id === itemId)).toBeUndefined();
    const all = (await app.inject({ url: `/api/projects/${projectId}/items?status=backlog&includeSnoozed=true` })).json();
    expect(all.find((i: { id: string }) => i.id === itemId)).toBeDefined();

    const timeline = (await app.inject({ url: `/api/items/${itemId}/activity` })).json() as { message: string }[];
    expect(timeline.map((a) => a.message)).toEqual(expect.arrayContaining(['Up next → Skipped: not now', 'Skipped → Backlog']));
  });

  it('only hard-deletes archived items', async () => {
    const early = await app.inject({ method: 'DELETE', url: `/api/items/${itemId}`, headers: H });
    expect(early.statusCode).toBe(409);
    await app.inject({ method: 'POST', url: `/api/items/${itemId}/decision`, headers: H, payload: { decision: 'archive' } });
    const res = await app.inject({ method: 'DELETE', url: `/api/items/${itemId}`, headers: H });
    expect(res.statusCode).toBe(204);
  });

  it('bulk-approves Inbox items', async () => {
    const inbox = (await app.inject({ url: `/api/projects/${projectId}/items?status=proposed` })).json() as { id: string }[];
    const res = await app.inject({ method: 'POST', url: '/api/items/bulk-decision', headers: H, payload: { itemIds: inbox.map((i) => i.id), decision: 'approve' } });
    expect(res.json().results.every((r: { ok: boolean }) => r.ok)).toBe(true);
  });

  it('summarises everything on the dashboard', async () => {
    const d = (await app.inject({ url: '/api/dashboard' })).json();
    expect(d.totals).toMatchObject({ projects: 1, inbox: 0, open: 1 });
    expect(d.throughput).toHaveLength(8);
  });

  it('returns 400 with details for invalid input', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/items`, headers: H, payload: { title: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toEqual(['title']);
  });
});

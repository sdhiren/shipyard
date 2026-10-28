import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/** The run queue: global concurrency, per-project parallel limits and waiting reasons. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-queue-'));
process.env.SHIPYARD_DATA_DIR = path.join(tmp, 'data');

type Services = {
  runs: typeof import('./runs.js');
  projects: typeof import('./projects.js');
  items: typeof import('./items.js');
};
let s: Services;

beforeAll(async () => {
  const { runMigrations } = await import('../db/client.js');
  runMigrations();
  s = { runs: await import('./runs.js'), projects: await import('./projects.js'), items: await import('./items.js') };
});

const tick = () => new Promise((r) => setTimeout(r, 25));

/** A run whose work finishes only when we say so. */
function deferredTask() {
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  return { finish, task: async () => (await done, { status: 'succeeded' as const }) };
}

async function makeProject(name: string) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  return s.projects.createProject({ path: dir, name });
}

function groupFor(projectId: string, label: string) {
  return { key: `write:${projectId}`, label, limit: () => s.projects.getProject(projectId).settings.maxParallelImplementations };
}

function startImplementationRun(projectId: string, label: string) {
  const item = s.items.createItem(projectId, { title: `Item for ${label}` });
  const run = s.runs.createRun({ projectId, itemId: item.id, kind: 'implement', model: 'm', prompt: 'p', cwd: tmp });
  const d = deferredTask();
  s.runs.enqueue(run.id, d.task, groupFor(projectId, label));
  return { runId: run.id, key: item.key, ...d };
}

const status = (runId: string) => s.runs.getRun(runId);

describe('run queue limits', () => {
  it('runs one implementation per project at a time by default, and says what a queued run waits for', async () => {
    const p = await makeProject('alpha');
    expect(p.settings.maxParallelImplementations).toBe(1);

    const a = startImplementationRun(p.id, 'alpha');
    const b = startImplementationRun(p.id, 'alpha');

    expect(status(a.runId).status).toBe('running');
    expect(status(b.runId)).toMatchObject({ status: 'queued', waitingReason: `Waiting for ${a.key} to finish: alpha allows 1 implementation at a time` });

    a.finish();
    await tick();
    expect(status(a.runId).status).toBe('succeeded');
    expect(status(b.runId)).toMatchObject({ status: 'running', waitingReason: null });
    b.finish();
    await tick();
  });

  it('lets different projects run at the same time, up to the global limit', async () => {
    const p1 = await makeProject('beta');
    const p2 = await makeProject('gamma');
    const p3 = await makeProject('delta');

    const r1 = startImplementationRun(p1.id, 'beta');
    const r2 = startImplementationRun(p2.id, 'gamma');
    const r3 = startImplementationRun(p3.id, 'delta'); // global default is 2

    expect(status(r1.runId).status).toBe('running');
    expect(status(r2.runId).status).toBe('running');
    expect(status(r3.runId)).toMatchObject({ status: 'queued', waitingReason: 'Waiting for a free run slot (2 of 2 in use)' });

    r1.finish();
    await tick();
    expect(status(r3.runId).status).toBe('running');
    r2.finish();
    r3.finish();
    await tick();
  });

  it('starts queued runs as soon as the project limit is raised', async () => {
    const p = await makeProject('epsilon');
    const a = startImplementationRun(p.id, 'epsilon');
    const b = startImplementationRun(p.id, 'epsilon');
    expect(status(b.runId).status).toBe('queued');

    s.projects.updateProject(p.id, { settings: { maxParallelImplementations: 2 } });
    expect(status(b.runId).status).toBe('running');

    a.finish();
    b.finish();
    await tick();
  });

  it('does not hold back runs from other projects behind a blocked one', async () => {
    const p = await makeProject('zeta');
    const other = await makeProject('eta');
    const a = startImplementationRun(p.id, 'zeta');
    const blocked = startImplementationRun(p.id, 'zeta');
    const free = startImplementationRun(other.id, 'eta');

    expect(status(blocked.runId).status).toBe('queued');
    expect(status(free.runId).status).toBe('running');

    a.finish();
    free.finish();
    await tick();
    blocked.finish();
    await tick();
  });

  it('cancels a queued run and clears its waiting reason', async () => {
    const p = await makeProject('theta');
    const a = startImplementationRun(p.id, 'theta');
    const b = startImplementationRun(p.id, 'theta');
    s.runs.cancelRun(b.runId);
    expect(status(b.runId)).toMatchObject({ status: 'cancelled', waitingReason: null });
    a.finish();
    await tick();
  });
});

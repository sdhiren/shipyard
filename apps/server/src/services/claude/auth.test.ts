import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_SIGNIN_ERROR } from '@shipyard/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Claude Code sign-in from the UI, against a fake `claude` that implements
 * `auth status`, the `auth login` code exchange, and a failing run.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-auth-'));
const state = path.join(tmp, 'logged-in');
const fakeClaude = path.join(tmp, 'fake-claude.sh');

fs.writeFileSync(
  fakeClaude,
  `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ "$FAKE_STATUS" = "garbage" ]; then echo "not json"; exit 0; fi
  if [ -f "${state}" ]; then printf '%s\\n' '{"loggedIn":true,"authMethod":"claude.ai","email":"me@example.com"}';
  else printf '%s\\n' '{"loggedIn":false,"authMethod":"none"}'; fi
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  echo "Opening browser to sign in…"
  echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc"
  printf "Paste code here if prompted > "
  read code
  if [ "$code" = "good-code" ]; then touch "${state}"; echo "Login successful."; exit 0; fi
  echo "OAuth error: Invalid code" >&2; exit 1
fi
cat > /dev/null
printf '%s\\n' '{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate: OAuth session expired and could not be refreshed","session_id":"s","total_cost_usd":0,"num_turns":0}'
`,
  { mode: 0o755 },
);

process.env.SHIPYARD_DATA_DIR = path.join(tmp, 'data');
process.env.SHIPYARD_CLAUDE_BIN = fakeClaude;

let app: FastifyInstance;
let auth: typeof import('./auth.js');
const H = { 'x-shipyard': '1' };

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
}

beforeAll(async () => {
  const { runMigrations } = await import('../../db/client.js');
  runMigrations();
  app = await (await import('../../app.js')).buildApp({ logger: false });
  auth = await import('./auth.js');
});

afterAll(async () => {
  auth.cancelLogin();
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Claude sign-in status', () => {
  it('reports signed out and refuses to start Claude work', async () => {
    const status = await auth.getAuthStatus({ force: true });
    expect(status).toMatchObject({ loggedIn: false, authMethod: 'none' });

    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { path: repo } })).json();
    const item = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/items`, headers: H, payload: { title: 'Profiles' } })).json();

    const plan = await app.inject({ method: 'POST', url: `/api/items/${item.id}/plan`, headers: H, payload: {} });
    expect(plan.statusCode).toBe(401);
    expect(plan.json().error).toContain(CLAUDE_SIGNIN_ERROR);

    // The comment isn't saved, so the owner can sign in and send it again.
    const ask = await app.inject({ method: 'POST', url: `/api/items/${item.id}/comments`, headers: H, payload: { body: 'Question?' } });
    expect(ask.statusCode).toBe(401);
    expect((await app.inject({ url: `/api/items/${item.id}/comments` })).json()).toHaveLength(0);

    // Plain comments and non-Claude actions still work.
    const note = await app.inject({ method: 'POST', url: `/api/items/${item.id}/comments`, headers: H, payload: { body: 'note', intent: 'comment' } });
    expect(note.statusCode).toBe(201);
  });

  it('shows the status in the health check', async () => {
    const health = (await app.inject({ url: '/api/health' })).json();
    expect(health.claudeAuth).toMatchObject({ loggedIn: false });
  });

  it("doesn't block runs when the status can't be read", async () => {
    process.env.FAKE_STATUS = 'garbage';
    expect((await auth.getAuthStatus({ force: true })).loggedIn).toBeNull();
    await expect(auth.assertSignedIn()).resolves.toBeUndefined();
    delete process.env.FAKE_STATUS;
    await auth.getAuthStatus({ force: true });
  });
});

describe('signing in from the UI', () => {
  it('refuses a code when no sign-in is waiting', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/claude/login/code', headers: H, payload: { code: 'x' } });
    expect(res.statusCode).toBe(409);
  });

  it('reports a wrong code without signing in', async () => {
    await app.inject({ method: 'POST', url: '/api/claude/login', headers: H, payload: {} });
    const waiting = await waitFor(() => auth.getLoginSession()!, (s) => s.state === 'waiting_for_code');
    expect(waiting.url).toBe('https://claude.com/cai/oauth/authorize?code=true&state=abc');

    await app.inject({ method: 'POST', url: '/api/claude/login/code', headers: H, payload: { code: 'wrong' } });
    const failed = await waitFor(() => auth.getLoginSession()!, (s) => s.state === 'failed');
    expect(failed.error).toContain('Invalid code');
    expect((await auth.getAuthStatus()).loggedIn).toBe(false);
  });

  it('signs in with the code from claude.com, after which runs are allowed', async () => {
    await app.inject({ method: 'POST', url: '/api/claude/login', headers: H, payload: { method: 'claudeai' } });
    await waitFor(() => auth.getLoginSession()!, (s) => s.state === 'waiting_for_code');
    const sent = await app.inject({ method: 'POST', url: '/api/claude/login/code', headers: H, payload: { code: '  good-code \n' } });
    expect(sent.json().state).toBe('verifying');

    const done = await waitFor(() => auth.getLoginSession()!, (s) => s.state === 'succeeded');
    expect(done.error).toBeNull();
    const res = (await app.inject({ url: '/api/claude/auth' })).json();
    expect(res.status).toMatchObject({ loggedIn: true, email: 'me@example.com' });
    await expect(auth.assertSignedIn()).resolves.toBeUndefined();
  });

  it('can cancel a sign-in in progress', async () => {
    await app.inject({ method: 'POST', url: '/api/claude/login', headers: H, payload: {} });
    await waitFor(() => auth.getLoginSession()!, (s) => s.state === 'waiting_for_code');
    expect((await app.inject({ method: 'DELETE', url: '/api/claude/login', headers: H })).statusCode).toBe(204);
    expect(auth.getLoginSession()!.state).toBe('cancelled');
  });
});

describe('runs that fail because the login lapsed', () => {
  it('get a clear, actionable error and flip the status to signed out', async () => {
    const { runClaude } = await import('./runner.js');
    const r = await runClaude({ prompt: 'x', cwd: tmp, model: 'm', mode: 'readonly', onEvent: () => {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(new RegExp(`^${CLAUDE_SIGNIN_ERROR}: Failed to authenticate: OAuth session expired`));
    expect(r.error).toContain('Sign in to Claude, then retry.');
    expect((await auth.getAuthStatus()).loggedIn).toBe(false);
  });

  it('only flags real auth failures', () => {
    expect(auth.isAuthFailure('Failed to authenticate: OAuth session expired and could not be refreshed')).toBe(true);
    expect(auth.isAuthFailure('Invalid API key · Please run /login')).toBe(true);
    expect(auth.isAuthFailure('Added OAuth login to the profile page and tests pass')).toBe(false);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The discussion thread end to end through the API. Claude is a script that
 * returns a canned plan or discussion reply (with or without a revised plan).
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-discuss-'));
const fakeClaude = path.join(tmp, 'fake-claude.sh');
const lastPrompt = path.join(tmp, 'last-prompt.txt');

const plan = {
  plan: '## Approach\nAdd OpenAI and Gemini clients behind the LlmClient interface.',
  acceptanceCriteria: ['Both clients pass the shared contract test'],
  effort: 'l',
  openQuestions: ['Which default models should openai and gemini ship with?', 'One PR or two?'],
};
const revised = { ...plan, plan: '## Approach\nDefaults: gpt-5 and gemini-2.5-pro. Ship as two PRs.', openQuestions: [] };
const result = (structured: unknown) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', total_cost_usd: 0.01, num_turns: 1, structured_output: structured });

fs.writeFileSync(
  fakeClaude,
  `#!/bin/sh
if [ "$1" = "--version" ]; then echo fake; exit 0; fi
cat > "${lastPrompt}"
if grep -q "replied in the item's discussion thread" "${lastPrompt}"; then
  if [ "$FAKE_DISCUSS" = "update" ]; then
    printf '%s\\n' '${result({ reply: 'Thanks! Using gpt-5 and gemini-2.5-pro, split into two PRs. I updated the plan.', updatedPlan: revised })}'
  else
    printf '%s\\n' '${result({ reply: 'Good question: the contract test covers streaming too.', updatedPlan: null })}'
  fi
else
  printf '%s\\n' '${result(plan)}'
fi
`,
  { mode: 0o755 },
);

process.env.SHIPYARD_DATA_DIR = path.join(tmp, 'data');
process.env.SHIPYARD_CLAUDE_BIN = fakeClaude;

let app: FastifyInstance;
const H = { 'x-shipyard': '1' };
let itemId = '';

async function waitForIdle(id: string) {
  for (let i = 0; i < 200; i++) {
    const runs = (await app.inject({ url: `/api/items/${id}/runs` })).json() as { status: string }[];
    if (runs.every((r) => r.status !== 'queued' && r.status !== 'running')) return runs;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('runs did not finish');
}
const comments = async () => (await app.inject({ url: `/api/items/${itemId}/comments` })).json() as { author: string; kind: string; body: string; planUpdated: boolean; id: string }[];
const item = async () => (await app.inject({ url: `/api/items/${itemId}` })).json();

beforeAll(async () => {
  const { runMigrations } = await import('../db/client.js');
  runMigrations();
  app = await (await import('../app.js')).buildApp({ logger: false });
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { path: repo, name: 'learning-assistant' } })).json();
  itemId = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/items`, headers: H, payload: { title: 'Add OpenAI and Gemini clients' } })).json().id;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('item discussion', () => {
  it('posts the plan to the thread, with open questions kept separate from the plan text', async () => {
    await app.inject({ method: 'POST', url: `/api/items/${itemId}/plan`, headers: H });
    await waitForIdle(itemId);

    const it = await item();
    expect(it.plan).not.toContain('Open questions');
    expect(it.openQuestions).toEqual(plan.openQuestions);
    expect(it.commentCount).toBe(1);

    const [first] = await comments();
    expect(first).toMatchObject({ author: 'claude', kind: 'plan', planUpdated: true });
    expect(first!.body).toContain('1. Which default models');
    expect(first!.body).toContain("Answer them here and I'll update the plan.");
  });

  it('lets the owner answer, and Claude replies and revises the plan', async () => {
    process.env.FAKE_DISCUSS = 'update';
    const res = await app.inject({
      method: 'POST',
      url: `/api/items/${itemId}/comments`,
      headers: H,
      payload: { body: '1. gpt-5 and gemini-2.5-pro\n2. Two PRs', kind: 'answers', intent: 'ask' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().run).toMatchObject({ kind: 'discuss' });
    await waitForIdle(itemId);

    // Claude saw the plan, the questions and the owner's answers.
    const prompt = fs.readFileSync(lastPrompt, 'utf8');
    expect(prompt).toContain('Which default models should openai and gemini ship with?');
    expect(prompt).toContain('2. Two PRs');

    const thread = await comments();
    expect(thread.map((c) => [c.author, c.kind])).toEqual([
      ['claude', 'plan'],
      ['user', 'answers'],
      ['claude', 'comment'],
    ]);
    expect(thread[2]).toMatchObject({ planUpdated: true });
    const it = await item();
    expect(it.plan).toContain('Ship as two PRs');
    expect(it.openQuestions).toEqual([]);
  });

  it('keeps the plan when Claude only answers a question', async () => {
    process.env.FAKE_DISCUSS = 'reply';
    const before = (await item()).plan;
    await app.inject({ method: 'POST', url: `/api/items/${itemId}/comments`, headers: H, payload: { body: 'Does the contract test cover streaming?' } });
    await waitForIdle(itemId);
    const thread = await comments();
    expect(thread.at(-1)).toMatchObject({ author: 'claude', planUpdated: false, body: expect.stringContaining('covers streaming') });
    expect((await item()).plan).toBe(before);
  });

  it('posts a plain comment without starting Claude', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/items/${itemId}/comments`, headers: H, payload: { body: 'Note to self: check pricing.', intent: 'comment' } });
    expect(res.json().run).toBeNull();
    expect((await comments()).at(-1)).toMatchObject({ author: 'user', body: 'Note to self: check pricing.' });
  });

  it('feeds the discussion into re-planning', async () => {
    await app.inject({ method: 'POST', url: `/api/items/${itemId}/plan`, headers: H });
    await waitForIdle(itemId);
    const prompt = fs.readFileSync(lastPrompt, 'utf8');
    expect(prompt).toContain('Discussion with the owner');
    expect(prompt).toContain('Note to self: check pricing.');
    expect((await comments()).at(-1)!.body).toContain('Revised the implementation plan');
  });

  it("refuses to ask Claude while it's busy, but still accepts plain comments", async () => {
    const plan = await app.inject({ method: 'POST', url: `/api/items/${itemId}/plan`, headers: H });
    expect(plan.statusCode).toBe(202);
    const busy = await app.inject({ method: 'POST', url: `/api/items/${itemId}/comments`, headers: H, payload: { body: 'Another question?' } });
    expect(busy.statusCode).toBe(409);
    const plain = await app.inject({ method: 'POST', url: `/api/items/${itemId}/comments`, headers: H, payload: { body: 'fine', intent: 'comment' } });
    expect(plain.statusCode).toBe(201);
    await waitForIdle(itemId);
  });

  it("deletes the owner's comments but not Claude's", async () => {
    const thread = await comments();
    const mine = thread.find((c) => c.author === 'user')!;
    const claudes = thread.find((c) => c.author === 'claude')!;
    expect((await app.inject({ method: 'DELETE', url: `/api/comments/${mine.id}`, headers: H })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/comments/${claudes.id}`, headers: H })).statusCode).toBe(409);
  });
});

describe('legacy plans', () => {
  it('moves an embedded "### Open questions" section into its own field', async () => {
    const { patchItem } = await import('./items.js');
    const { backfillOpenQuestions } = await import('./items.js');
    patchItem(itemId, { plan: 'Do the thing.\n\n### Open questions\n- First?\n- Second?', openQuestions: [] });
    expect(backfillOpenQuestions()).toBe(1);
    const it = await item();
    expect(it).toMatchObject({ plan: 'Do the thing.', openQuestions: ['First?', 'Second?'] });
    expect(backfillOpenQuestions()).toBe(0);
  });
});

describe('threadForPrompt', () => {
  it('drops the oldest messages first when the thread is long', async () => {
    const { threadForPrompt, addComment } = await import('./comments.js');
    for (let i = 0; i < 5; i++) addComment({ itemId, author: 'user', kind: 'comment', body: `long message ${i} ${'x'.repeat(400)}` });
    const text = threadForPrompt(itemId, 1500);
    expect(text).toMatch(/^\(\d+ earlier messages omitted\)/);
    expect(text).toContain('long message 4');
    expect(text).not.toContain('long message 0');
  });
});

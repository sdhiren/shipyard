import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Attachment, Comment } from '@shipyard/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Attachments end to end through the API: upload, serving headers, linking to
 * comments, cleanup, and what Claude is told. Claude is a script that records
 * its arguments and prompt, then returns a canned plan or reply.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-attach-'));
const fakeClaude = path.join(tmp, 'fake-claude.sh');
const lastPrompt = path.join(tmp, 'last-prompt.txt');
const lastArgs = path.join(tmp, 'last-args.txt');
const plan = { plan: '## Approach\nMatch the mockup.', acceptanceCriteria: ['Looks like the screenshot'], effort: 's', openQuestions: [] };
const result = (structured: unknown) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', total_cost_usd: 0.01, num_turns: 1, structured_output: structured });

fs.writeFileSync(
  fakeClaude,
  `#!/bin/sh
if [ "$1" = "--version" ]; then echo fake; exit 0; fi
printf '%s\\n' "$@" > "${lastArgs}"
cat > "${lastPrompt}"
if grep -q "replied in the item's discussion thread" "${lastPrompt}"; then
  printf '%s\\n' '${result({ reply: 'I looked at the screenshot.', updatedPlan: null })}'
else
  printf '%s\\n' '${result(plan)}'
fi
`,
  { mode: 0o755 },
);

const dataDir = path.join(tmp, 'data');
const attachmentsDir = path.join(dataDir, 'attachments');
process.env.SHIPYARD_DATA_DIR = dataDir;
process.env.SHIPYARD_CLAUDE_BIN = fakeClaude;

let app: FastifyInstance;
const H = { 'x-shipyard': '1' };
let projectId = '';
let itemId = '';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function newItem(title: string): Promise<string> {
  return (await app.inject({ method: 'POST', url: `/api/projects/${projectId}/items`, headers: H, payload: { title } })).json().id;
}

async function upload(id: string, filename: string, body: Buffer | string, type = 'application/octet-stream', draft = false) {
  return app.inject({
    method: 'POST',
    url: `/api/items/${id}/attachments${draft ? '?draft=1' : ''}`,
    headers: { ...H, 'content-type': type, 'x-filename': encodeURIComponent(filename) },
    payload: body,
  });
}

async function waitForIdle(id: string) {
  for (let i = 0; i < 200; i++) {
    const runs = (await app.inject({ url: `/api/items/${id}/runs` })).json() as { status: string }[];
    if (runs.every((r) => r.status !== 'queued' && r.status !== 'running')) return runs;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('runs did not finish');
}

const comments = async (id: string) => (await app.inject({ url: `/api/items/${id}/comments` })).json() as Comment[];

beforeAll(async () => {
  const { runMigrations } = await import('../db/client.js');
  runMigrations();
  app = await (await import('../app.js')).buildApp({ logger: false });
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  projectId = (await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { path: repo, name: 'design-site' } })).json().id;
  itemId = await newItem('Match the new landing page mockup');
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('isClaudeReadable', () => {
  it.each([
    ['image/png', 'shot.png', true],
    ['application/pdf', 'spec.pdf', true],
    ['text/markdown', 'notes.md', true],
    ['application/octet-stream', 'notes.md', true],
    ['', 'README.markdown', true],
    ['application/octet-stream', 'scan.PDF', true],
    ['text/plain', 'log', true],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'brief.docx', false],
    ['application/zip', 'assets.zip', false],
  ])('%s %s → %s', async (type, name, readable) => {
    const { isClaudeReadable } = await import('./attachments.js');
    expect(isClaudeReadable(type, name)).toBe(readable);
  });

  it('sanitises filenames to a single safe segment', async () => {
    const { sanitizeFilename } = await import('./attachments.js');
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..')).toBe('file');
    expect(sanitizeFilename('a\u0000b<c>.png')).toBe('ab_c_.png');
    expect(sanitizeFilename('x'.repeat(300)).length).toBe(120);
  });
});

describe('uploading and serving', () => {
  it('stores an upload under the attachments folder and lists it', async () => {
    const res = await upload(itemId, 'mockup.png', PNG, 'image/png');
    expect(res.statusCode).toBe(201);
    const a = res.json() as Attachment;
    expect(a).toMatchObject({ filename: 'mockup.png', mimeType: 'image/png', size: PNG.length, isImage: true, commentId: null });
    expect(fs.readFileSync(path.join(attachmentsDir, projectId, itemId, a.id, 'mockup.png'))).toEqual(PNG);

    const list = (await app.inject({ url: `/api/items/${itemId}/attachments` })).json() as Attachment[];
    expect(list.map((x) => x.id)).toEqual([a.id]);
    expect((await app.inject({ url: `/api/items/${itemId}` })).json().attachmentCount).toBe(1);
  });

  it('serves raster images inline with nosniff and a sandbox CSP', async () => {
    const [a] = (await app.inject({ url: `/api/items/${itemId}/attachments` })).json() as Attachment[];
    const res = await app.inject({ url: a!.url });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(PNG);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toMatch(/^inline;/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toMatch(/^sandbox/);
  });

  it('sends HTML and SVG as downloads, never inline', async () => {
    for (const [name, type] of [['page.html', 'text/html'], ['logo.svg', 'image/svg+xml']] as const) {
      const a = (await upload(itemId, name, '<script>alert(1)</script>', type)).json() as Attachment;
      const res = await app.inject({ url: a.url });
      expect(res.headers['content-disposition']).toMatch(/^attachment;/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain('sandbox');
      expect(a.isImage).toBe(false);
    }
  });

  it('accepts JSON files as raw bytes instead of parsing them', async () => {
    const res = await upload(itemId, 'data.json', '{"a":1}', 'application/json');
    expect(res.statusCode).toBe(201);
    expect((await app.inject({ url: (res.json() as Attachment).url })).body).toBe('{"a":1}');
  });

  it('keeps path traversal inside the item folder', async () => {
    const a = (await upload(itemId, '../../etc/passwd', 'root:x:0:0')).json() as Attachment;
    expect(a.filename).toBe('passwd');
    expect(fs.existsSync(path.join(attachmentsDir, projectId, itemId, a.id, 'passwd'))).toBe(true);
    const hidden = (await upload(itemId, '..\\..\\.env', 'SECRET=1')).json() as Attachment;
    expect(hidden.filename).toBe('env');
  });

  it('rejects files over 20 MB with 413', async () => {
    const res = await upload(itemId, 'huge.bin', Buffer.alloc(20 * 1024 * 1024 + 1));
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/larger than 20/);
  });

  it('requires the X-Shipyard header', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/items/${itemId}/attachments`, headers: { 'content-type': 'image/png', 'x-filename': 'a.png' }, payload: PNG });
    expect(res.statusCode).toBe(403);
  });

  it('removes an attachment and its file', async () => {
    const a = (await upload(itemId, 'temp.txt', 'x', 'text/plain')).json() as Attachment;
    expect((await app.inject({ method: 'DELETE', url: a.url, headers: H })).statusCode).toBe(204);
    expect(fs.existsSync(path.join(attachmentsDir, projectId, itemId, a.id))).toBe(false);
    expect((await app.inject({ url: a.url })).statusCode).toBe(404);
  });
});

describe('attachments on comments', () => {
  it('links draft uploads to a new comment and allows attachment-only comments', async () => {
    const draft = (await upload(itemId, 'error.png', PNG, 'image/png', true)).json() as Attachment;
    // Drafts aren't listed or counted until they're posted.
    expect(((await app.inject({ url: `/api/items/${itemId}/attachments` })).json() as Attachment[]).some((a) => a.id === draft.id)).toBe(false);

    const res = await app.inject({ method: 'POST', url: `/api/items/${itemId}/comments`, headers: H, payload: { intent: 'comment', attachmentIds: [draft.id] } });
    expect(res.statusCode).toBe(201);
    const thread = await comments(itemId);
    expect(thread.at(-1)!.body).toBe('');
    expect(thread.at(-1)!.attachments.map((a) => a.id)).toEqual([draft.id]);
  });

  it('rejects a message with neither text nor attachments', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/items/${itemId}/comments`, headers: H, payload: { intent: 'comment', body: '  ' } });
    expect(res.statusCode).toBe(400);
  });

  it('refuses attachments that are already linked or belong to another item', async () => {
    const posted = (await comments(itemId)).at(-1)!.attachments[0]!;
    const again = await app.inject({ method: 'POST', url: `/api/items/${itemId}/comments`, headers: H, payload: { intent: 'comment', body: 'again', attachmentIds: [posted.id] } });
    expect(again.statusCode).toBe(409);

    const other = await newItem('Another item');
    const foreign = (await upload(other, 'x.png', PNG, 'image/png', true)).json() as Attachment;
    const res = await app.inject({ method: 'POST', url: `/api/items/${itemId}/comments`, headers: H, payload: { intent: 'comment', body: 'hi', attachmentIds: [foreign.id] } });
    expect(res.statusCode).toBe(409);
    // The failed post left nothing behind.
    expect((await comments(itemId)).some((c) => c.body === 'hi')).toBe(false);
  });

  it('deletes a comment together with its files', async () => {
    const draft = (await upload(itemId, 'notes.md', '# Notes', 'text/markdown', true)).json() as Attachment;
    const { comment } = (await app.inject({ method: 'POST', url: `/api/items/${itemId}/comments`, headers: H, payload: { intent: 'comment', body: 'see notes', attachmentIds: [draft.id] } })).json();
    const dir = path.join(attachmentsDir, projectId, itemId, draft.id);
    expect(fs.existsSync(dir)).toBe(true);
    expect((await app.inject({ method: 'DELETE', url: `/api/comments/${comment.id}`, headers: H })).statusCode).toBe(204);
    expect(fs.existsSync(dir)).toBe(false);
    expect((await app.inject({ url: draft.url })).statusCode).toBe(404);
  });
});

describe('what Claude sees', () => {
  it('passes the attachment folder with --add-dir and lists every file in the plan prompt', async () => {
    const id = await newItem('Redesign the header');
    await upload(id, 'screenshot.png', PNG, 'image/png');
    await upload(id, 'spec.pdf', '%PDF-1.4', 'application/pdf');
    await upload(id, 'notes.md', '# Notes', 'application/octet-stream');
    await upload(id, 'brief.docx', 'PK', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    await app.inject({ method: 'POST', url: `/api/items/${id}/plan`, headers: H });
    const [run] = await waitForIdle(id);
    expect(run!.status).toBe('succeeded');

    const args = fs.readFileSync(lastArgs, 'utf8').split('\n');
    const dir = path.join(attachmentsDir, projectId, id);
    expect(args[args.indexOf('--add-dir') + 1]).toBe(dir);

    const prompt = fs.readFileSync(lastPrompt, 'utf8');
    for (const name of ['screenshot.png', 'spec.pdf', 'notes.md', 'brief.docx']) expect(prompt).toContain(name);
    expect(prompt).toContain(`${dir}${path.sep}`);
    expect(prompt).toMatch(/notes\.md \(application\/octet-stream, [^)]+, added with the item\) —/);
    expect(prompt).toMatch(/brief\.docx \([^)]+\) \(format not readable by you\)/);
    expect(prompt).toContain('never copy, move or commit them');
  });

  it('lists files per message in the discussion prompt', async () => {
    const id = await newItem('Fix the broken button');
    const draft = (await upload(id, 'bug.png', PNG, 'image/png', true)).json() as Attachment;
    await app.inject({ method: 'POST', url: `/api/items/${id}/comments`, headers: H, payload: { intent: 'ask', body: 'What do you see?', attachmentIds: [draft.id] } });
    await waitForIdle(id);
    const prompt = fs.readFileSync(lastPrompt, 'utf8');
    expect(prompt).toContain(`Attachments: bug.png (${path.join(attachmentsDir, projectId, id, draft.id, 'bug.png')})`);
    expect(prompt).toContain("with the owner's comment of");
    expect(fs.readFileSync(lastArgs, 'utf8')).toContain('--add-dir');
  });

  it('runs without --add-dir when an item has no attachments', async () => {
    const id = await newItem('No files here');
    await app.inject({ method: 'POST', url: `/api/items/${id}/plan`, headers: H });
    await waitForIdle(id);
    expect(fs.readFileSync(lastArgs, 'utf8')).not.toContain('--add-dir');
    expect(fs.readFileSync(lastPrompt, 'utf8')).not.toContain('Attachments from the owner');
  });
});

describe('cleanup', () => {
  it('prunes unposted drafts after 24 hours and keeps posted files', async () => {
    const { pruneDrafts } = await import('./attachments.js');
    const { db } = await import('../db/client.js');
    const { attachments } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    const id = await newItem('Drafts');
    const stale = (await upload(id, 'stale.png', PNG, 'image/png', true)).json() as Attachment;
    const fresh = (await upload(id, 'fresh.png', PNG, 'image/png', true)).json() as Attachment;
    const kept = (await upload(id, 'kept.png', PNG, 'image/png')).json() as Attachment;
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.update(attachments).set({ createdAt: old }).where(eq(attachments.id, stale.id)).run();
    db.update(attachments).set({ createdAt: old }).where(eq(attachments.id, kept.id)).run();

    expect(pruneDrafts()).toBe(1);
    expect((await app.inject({ url: stale.url })).statusCode).toBe(404);
    expect(fs.existsSync(path.join(attachmentsDir, projectId, id, stale.id))).toBe(false);
    expect((await app.inject({ url: fresh.url })).statusCode).toBe(200);
    expect((await app.inject({ url: kept.url })).statusCode).toBe(200);
  });

  it('removes the item folder when an archived item is deleted permanently', async () => {
    const id = await newItem('Doomed');
    await upload(id, 'a.png', PNG, 'image/png');
    await app.inject({ method: 'POST', url: `/api/items/${id}/decision`, headers: H, payload: { decision: 'archive' } });
    expect((await app.inject({ method: 'DELETE', url: `/api/items/${id}`, headers: H })).statusCode).toBe(204);
    expect(fs.existsSync(path.join(attachmentsDir, projectId, id))).toBe(false);
  });

  it("removes the project's attachments when the project is removed", async () => {
    expect(fs.existsSync(path.join(attachmentsDir, projectId))).toBe(true);
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: H });
    expect(res.statusCode).toBeLessThan(300);
    expect(fs.existsSync(path.join(attachmentsDir, projectId))).toBe(false);
  });
});

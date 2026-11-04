import fs from 'node:fs';
import path from 'node:path';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_PER_ITEM, INLINE_IMAGE_TYPES, type Attachment } from '@shipyard/shared';
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { attachments, comments, type AttachmentRow } from '../db/schema.js';
import { bus } from '../lib/events.js';
import { conflict, HttpError, newId, notFound, now } from '../lib/util.js';
import { logActivity } from './activity.js';
import { getItemRow } from './items.js';

/**
 * Files the owner attaches to an item or a comment. They live under
 * `~/.shipyard/attachments/<projectId>/<itemId>/<attachmentId>/<name>`, never in
 * the repo or a worktree; Claude reads them there via `--add-dir`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    itemId: row.itemId,
    commentId: row.commentId,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    isImage: INLINE_IMAGE_TYPES.includes(row.mimeType),
    url: `/api/attachments/${row.id}`,
    createdAt: row.createdAt,
  };
}

/** A safe single path segment: no directories, control characters or leading dots. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 120)
    .trim();
  return clean || 'file';
}

/** "text/html; charset=utf-8" → "text/html"; anything malformed → octet-stream. */
export function normalizeMimeType(type: string | undefined): string {
  const t = (type ?? '').split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(t) ? t : 'application/octet-stream';
}

const READABLE_TYPES = ['application/pdf', 'application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/javascript', 'application/typescript', 'application/sql', 'application/x-sh'];
const READABLE_EXTENSIONS = new Set([
  // Images and PDFs
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf',
  // Text and data
  'md', 'markdown', 'mdx', 'txt', 'text', 'csv', 'tsv', 'log', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env', 'html', 'htm', 'css', 'scss', 'svg', 'sql', 'diff', 'patch',
  // Code
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'lua', 'dart', 'scala', 'vue', 'svelte', 'graphql', 'proto',
]);

/**
 * Whether Claude's Read tool can interpret the file: raster images, PDFs and
 * text. The extension wins over the MIME type because browsers often send no
 * type (→ octet-stream) for files like `.md`.
 */
export function isClaudeReadable(mimeType: string, filename: string): boolean {
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (READABLE_EXTENSIONS.has(ext)) return true;
  const t = normalizeMimeType(mimeType);
  return INLINE_IMAGE_TYPES.includes(t) || t.startsWith('text/') || READABLE_TYPES.includes(t) || t.endsWith('+json') || t.endsWith('+xml');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Absolute path of an attachment's file, asserted to stay inside the attachments folder. */
export function absPath(row: Pick<AttachmentRow, 'relPath'>): string {
  const root = path.resolve(config.attachmentsDir);
  const abs = path.resolve(root, row.relPath);
  if (!abs.startsWith(root + path.sep)) throw new HttpError(400, 'Invalid attachment path');
  return abs;
}

function itemDir(projectId: string, itemId: string): string {
  return path.join(config.attachmentsDir, projectId, itemId);
}

/** `rm -rf` limited to Shipyard's own attachments folder. */
function removeDir(dir: string): void {
  const root = path.resolve(config.attachmentsDir);
  const abs = path.resolve(dir);
  if (abs === root || !abs.startsWith(root + path.sep)) return;
  fs.rmSync(abs, { recursive: true, force: true });
}

export async function saveAttachment(input: { itemId: string; filename: string; mimeType?: string; data: Buffer; draft?: boolean }): Promise<Attachment> {
  const item = getItemRow(input.itemId);
  if (input.data.length > ATTACHMENT_MAX_BYTES) throw new HttpError(413, `File is larger than ${formatBytes(ATTACHMENT_MAX_BYTES)}`);
  const count = db.select({ n: sql<number>`count(*)` }).from(attachments).where(eq(attachments.itemId, item.id)).get()?.n ?? 0;
  if (count >= ATTACHMENT_MAX_PER_ITEM) throw conflict(`An item can have at most ${ATTACHMENT_MAX_PER_ITEM} attachments`);

  const id = newId('att');
  const filename = sanitizeFilename(input.filename);
  const relPath = path.join(item.projectId, item.id, id, filename);
  const row: AttachmentRow = {
    id,
    projectId: item.projectId,
    itemId: item.id,
    commentId: null,
    draft: input.draft ?? false,
    filename,
    mimeType: normalizeMimeType(input.mimeType),
    size: input.data.length,
    relPath,
    createdAt: now(),
  };
  const abs = absPath(row);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, input.data, { flag: 'wx' });
  db.insert(attachments).values(row).run();
  if (!row.draft) {
    logActivity({ projectId: item.projectId, itemId: item.id, kind: 'updated', message: `Attached ${filename}`, meta: { attachmentId: id } });
    bus.publish({ type: 'item.changed', projectId: item.projectId, itemId: item.id });
  }
  return toAttachment(row);
}

export function getAttachmentRow(id: string): AttachmentRow {
  const row = db.select().from(attachments).where(eq(attachments.id, id)).get();
  if (!row) throw notFound('Attachment');
  return row;
}

/** Everything posted on the item (drafts excluded), oldest first. */
export function listAttachments(itemId: string): Attachment[] {
  return db
    .select()
    .from(attachments)
    .where(and(eq(attachments.itemId, itemId), eq(attachments.draft, false)))
    .orderBy(asc(attachments.createdAt))
    .all()
    .map(toAttachment);
}

export function attachmentsFor(commentIds: string[]): Map<string, Attachment[]> {
  const map = new Map<string, Attachment[]>();
  if (!commentIds.length) return map;
  const rows = db.select().from(attachments).where(inArray(attachments.commentId, commentIds)).orderBy(asc(attachments.createdAt)).all();
  for (const r of rows) {
    const list = map.get(r.commentId!) ?? [];
    list.push(toAttachment(r));
    map.set(r.commentId!, list);
  }
  return map;
}

/** "name (abs path)" for each posted comment attachment on the item, keyed by comment, for prompts. */
export function commentFilesForPrompt(itemId: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const rows = db.select().from(attachments).where(eq(attachments.itemId, itemId)).orderBy(asc(attachments.createdAt)).all();
  for (const r of rows) {
    if (!r.commentId) continue;
    map.set(r.commentId, [...(map.get(r.commentId) ?? []), `${r.filename} (${absPath(r)})`]);
  }
  return map;
}

export function attachmentCounts(itemIds: string[]): Map<string, number> {
  if (!itemIds.length) return new Map();
  const rows = db
    .select({ itemId: attachments.itemId, n: sql<number>`count(*)` })
    .from(attachments)
    .where(and(inArray(attachments.itemId, itemIds), eq(attachments.draft, false)))
    .groupBy(attachments.itemId)
    .all();
  return new Map(rows.map((r) => [r.itemId, r.n]));
}

/** Attach uploaded drafts to a new comment. Call inside the comment's transaction. */
export function linkToComment(ids: string[], itemId: string, commentId: string): void {
  if (!ids.length) return;
  const unique = [...new Set(ids)];
  const rows = db.select().from(attachments).where(inArray(attachments.id, unique)).all();
  if (rows.length !== unique.length) throw notFound('Attachment');
  for (const r of rows) {
    if (r.itemId !== itemId || !r.draft || r.commentId) throw conflict(`${r.filename} can't be attached to this message`);
  }
  db.update(attachments).set({ commentId, draft: false }).where(inArray(attachments.id, unique)).run();
}

export function deleteAttachment(id: string): void {
  const row = getAttachmentRow(id);
  db.delete(attachments).where(eq(attachments.id, id)).run();
  removeDir(path.dirname(absPath(row)));
  if (!row.draft) {
    logActivity({ projectId: row.projectId, itemId: row.itemId, kind: 'updated', message: `Removed attachment ${row.filename}`, meta: { attachmentId: id } });
    bus.publish({ type: 'item.changed', projectId: row.projectId, itemId: row.itemId });
  }
}

/** Files of a comment that is about to be (or was) deleted; the rows go with the comment's cascade. */
export function removeCommentAttachments(commentId: string): void {
  const rows = db.select().from(attachments).where(eq(attachments.commentId, commentId)).all();
  for (const r of rows) removeDir(path.dirname(absPath(r)));
}

export function removeItemAttachments(projectId: string, itemId: string): void {
  removeDir(itemDir(projectId, itemId));
}

export function removeProjectAttachments(projectId: string): void {
  removeDir(path.join(config.attachmentsDir, projectId));
}

/** Drafts uploaded from the composer but never posted. */
export function pruneDrafts(olderThanMs = DAY_MS): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const rows = db
    .select()
    .from(attachments)
    .where(and(eq(attachments.draft, true), isNull(attachments.commentId), lt(attachments.createdAt, cutoff)))
    .all();
  for (const r of rows) {
    db.delete(attachments).where(eq(attachments.id, r.id)).run();
    removeDir(path.dirname(absPath(r)));
  }
  return rows.length;
}

/** "- design.png (image/png, 412 KB, added with the item) — /abs/path" */
function promptLine(row: AttachmentRow, origin: string): string {
  const unreadable = isClaudeReadable(row.mimeType, row.filename) ? '' : ' (format not readable by you)';
  return `- ${row.filename} (${row.mimeType}, ${formatBytes(row.size)}, ${origin})${unreadable} — ${absPath(row)}`;
}

/**
 * The item's attachments for a Claude prompt: the folder to pass with
 * `--add-dir` and a Markdown list of every file. With `commentId`, only that
 * message's files are listed (the folder still covers them all).
 */
export function attachmentsForPrompt(itemId: string, opts: { commentId?: string } = {}): { dir: string | null; block: string } {
  const rows = db
    .select({ a: attachments, commentAt: comments.createdAt, commentAuthor: comments.author })
    .from(attachments)
    .leftJoin(comments, eq(attachments.commentId, comments.id))
    .where(and(eq(attachments.itemId, itemId), eq(attachments.draft, false), opts.commentId ? eq(attachments.commentId, opts.commentId) : undefined))
    .orderBy(asc(attachments.createdAt))
    .all();
  if (!rows.length) return { dir: null, block: '' };
  const lines = rows.map(({ a, commentAt }) =>
    promptLine(a, a.commentId ? `with the owner's comment of ${(commentAt ?? a.createdAt).slice(0, 16).replace('T', ' ')}` : 'added with the item'),
  );
  return { dir: path.resolve(itemDir(rows[0]!.a.projectId, itemId)), block: lines.join('\n') };
}

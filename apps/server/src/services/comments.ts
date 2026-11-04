import type { Attachment, Comment, CommentAuthor, CommentKind } from '@shipyard/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, type CommentRow } from '../db/schema.js';
import { bus } from '../lib/events.js';
import { conflict, newId, notFound, now, truncate } from '../lib/util.js';
import { logActivity } from './activity.js';
import { attachmentsFor, commentFilesForPrompt, linkToComment, removeCommentAttachments } from './attachments.js';
import { getItemRow } from './items.js';

/** An item's discussion thread: the owner's comments and Claude's replies. */

function toComment(row: CommentRow, attachments: Attachment[] = []): Comment {
  return {
    id: row.id,
    itemId: row.itemId,
    author: row.author,
    kind: row.kind,
    body: row.body,
    planUpdated: row.planUpdated,
    runId: row.runId,
    attachments,
    createdAt: row.createdAt,
  };
}

export function listComments(itemId: string): Comment[] {
  const rows = db.select().from(comments).where(eq(comments.itemId, itemId)).orderBy(asc(comments.createdAt)).all();
  const files = attachmentsFor(rows.map((r) => r.id));
  return rows.map((r) => toComment(r, files.get(r.id)));
}

export function commentCounts(itemIds: string[]): Map<string, number> {
  if (!itemIds.length) return new Map();
  const rows = db
    .select({ itemId: comments.itemId, n: sql<number>`count(*)` })
    .from(comments)
    .where(inArray(comments.itemId, itemIds))
    .groupBy(comments.itemId)
    .all();
  return new Map(rows.map((r) => [r.itemId, r.n]));
}

export function addComment(input: {
  itemId: string;
  author: CommentAuthor;
  kind: CommentKind;
  body: string;
  planUpdated?: boolean;
  runId?: string | null;
  /** Draft attachments uploaded from the composer; linked in the same transaction as the insert. */
  attachmentIds?: string[];
}): Comment {
  const item = getItemRow(input.itemId);
  const row: CommentRow = {
    id: newId('cmt'),
    projectId: item.projectId,
    itemId: item.id,
    author: input.author,
    kind: input.kind,
    body: input.body.trim(),
    planUpdated: input.planUpdated ?? false,
    runId: input.runId ?? null,
    createdAt: now(),
  };
  db.transaction(() => {
    db.insert(comments).values(row).run();
    if (input.author === 'user') linkToComment(input.attachmentIds ?? [], item.id, row.id);
  });
  const files = attachmentsFor([row.id]).get(row.id) ?? [];
  const who = input.author === 'user' ? 'You' : 'Claude';
  const what = input.kind === 'answers' ? 'answered the open questions' : input.kind === 'change_request' ? 'requested changes' : input.kind === 'plan' ? 'posted a plan' : 'commented';
  const excerpt = input.kind === 'comment' && row.body ? `: ${truncate(row.body.replace(/\s+/g, ' '), 140)}` : '';
  const attached = files.length ? ` (${files.length} attachment${files.length === 1 ? '' : 's'})` : '';
  logActivity({
    projectId: item.projectId,
    itemId: item.id,
    kind: 'comment',
    message: `${who} ${what}${excerpt}${attached}`,
    meta: { commentId: row.id },
  });
  bus.publish({ type: 'item.changed', projectId: item.projectId, itemId: item.id });
  return toComment(row, files);
}

/** Owners can delete their own comments (and their attachments); Claude's replies stay as the record. */
export function deleteComment(id: string): void {
  const row = db.select().from(comments).where(eq(comments.id, id)).get();
  if (!row) throw notFound('Comment');
  if (row.author !== 'user') throw conflict("Claude's replies can't be deleted");
  removeCommentAttachments(id);
  db.delete(comments).where(and(eq(comments.id, id))).run();
  bus.publish({ type: 'item.changed', projectId: row.projectId, itemId: row.itemId });
}

/**
 * The thread as text for prompts. When it's long, the oldest messages are
 * dropped first and a note says so, so the latest context always fits.
 * Each message lists the files attached to it.
 */
export function threadForPrompt(itemId: string, maxChars = 16_000): string {
  const files = commentFilesForPrompt(itemId);
  const lines = listComments(itemId).map((c) => {
    const who = c.author === 'user' ? 'Owner' : 'Claude';
    const label = c.kind === 'answers' ? ' (answers to open questions)' : c.kind === 'change_request' ? ' (change request)' : c.kind === 'plan' ? ' (plan update)' : '';
    const attached = files.get(c.id);
    return `**${who}**${label}, ${c.createdAt.slice(0, 16).replace('T', ' ')}:\n${c.body || '(attachments only)'}${attached ? `\nAttachments: ${attached.join(', ')}` : ''}`;
  });
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    size += lines[i]!.length + 2;
    if (size > maxChars) {
      kept.unshift(`(${i + 1} earlier message${i === 0 ? '' : 's'} omitted)`);
      break;
    }
    kept.unshift(lines[i]!);
  }
  return kept.join('\n\n');
}

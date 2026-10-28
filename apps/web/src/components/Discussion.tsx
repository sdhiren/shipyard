import type { BacklogItem, Comment, CommentIntent, CommentKind, Run } from '@shipyard/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, ListChecks, MessageSquare, RotateCcw, Send, Sparkles, Trash2, User, Wrench } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { useItemComments, useItemRuns } from '../api/hooks';
import { cn, timeAgo } from '../lib/utils';
import { Md } from './domain';
import { Badge, Button, Spinner, Textarea } from './ui';

/**
 * A Jira-style conversation on a backlog item. The owner comments or asks
 * Claude; Claude replies in the thread and revises the plan when the
 * discussion changes it. Open questions from the plan get a quick answer form.
 */
export function Discussion({ item, onShowPlan, onShowLog }: { item: BacklogItem; onShowPlan: () => void; onShowLog: () => void }) {
  const { data: comments, isLoading } = useItemComments(item.id);
  const { data: runs } = useItemRuns(item.id);
  const activeRun = runs?.find((r) => r.status === 'running' || r.status === 'queued');
  const failedReply = useFailedReply(runs, comments);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [comments?.length, activeRun?.id]);

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1 space-y-4 px-5 py-4">
        {isLoading ? (
          <Spinner />
        ) : comments?.length ? (
          <ol className="space-y-4">
            {comments.map((c) => (
              <CommentEntry key={c.id} comment={c} onShowPlan={onShowPlan} />
            ))}
          </ol>
        ) : (
          !item.openQuestions.length && (
            <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
              <MessageSquare className="mx-auto mb-2 size-5 text-faint" />
              No discussion yet. Ask Claude about the approach, add context, or leave a note for later.
            </div>
          )
        )}

        {/* The current ask sits at the end of the thread, next to the composer. */}
        {item.openQuestions.length > 0 && <OpenQuestionsForm item={item} busy={!!activeRun} />}
        {activeRun && <PendingReply run={activeRun} onShowLog={onShowLog} />}
        {!activeRun && failedReply && <FailedReply itemId={item.id} run={failedReply} onShowLog={onShowLog} />}
        <div ref={endRef} />
      </div>
      <Composer item={item} busy={!!activeRun} />
    </div>
  );
}

/** The latest discussion run failed and nothing was posted after it. */
function useFailedReply(runs: Run[] | undefined, comments: Comment[] | undefined): Run | null {
  return useMemo(() => {
    const last = runs?.find((r) => r.kind === 'discuss');
    if (!last || last.status !== 'failed') return null;
    const lastClaude = [...(comments ?? [])].reverse().find((c) => c.author === 'claude');
    return !lastClaude || lastClaude.createdAt < last.createdAt ? last : null;
  }, [runs, comments]);
}

function usePost(itemId: string) {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const send = async (body: string, intent: CommentIntent, kind: CommentKind = 'comment') => {
    setPending(true);
    try {
      await api.postComment(itemId, { body, intent, kind });
      for (const key of [['item-comments', itemId], ['item-runs', itemId], ['item', itemId]]) void qc.invalidateQueries({ queryKey: key });
      if (intent === 'change_request') toast.success('Claude is revising the branch');
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setPending(false);
    }
  };
  return { send, pending };
}

// ---------------------------------------------------------------------------
// Open questions → one answer box each, sent as a single reply
// ---------------------------------------------------------------------------

function OpenQuestionsForm({ item, busy }: { item: BacklogItem; busy: boolean }) {
  const [answers, setAnswers] = useState<string[]>(() => item.openQuestions.map(() => ''));
  const { send, pending } = usePost(item.id);
  useEffect(() => setAnswers(item.openQuestions.map(() => '')), [item.openQuestions]);
  const answered = answers.filter((a) => a.trim()).length;

  const submit = async () => {
    const body = [
      '**Answers to the open questions**',
      ...item.openQuestions.map((q, i) => {
        const a = answers[i]?.trim();
        return `${i + 1}. *${q}*\n\n   ${a ? a.replace(/\n/g, '\n   ') : '_No answer yet: use your judgement._'}`;
      }),
    ].join('\n\n');
    if (await send(body, 'ask', 'answers')) setAnswers(item.openQuestions.map(() => ''));
  };

  return (
    <section className="overflow-hidden rounded-xl border border-violet-500/30 bg-violet-500/[0.04]">
      <div className="flex items-center gap-2 border-b border-violet-500/20 px-4 py-2.5 text-sm font-medium text-violet-300">
        <ListChecks className="size-4" />
        Claude needs your input on {item.openQuestions.length} question{item.openQuestions.length === 1 ? '' : 's'} before implementing
      </div>
      <ol className="space-y-4 p-4">
        {item.openQuestions.map((q, i) => (
          <li key={i} className="space-y-2">
            <div className="flex gap-2 text-sm text-fg">
              <span className="font-mono text-xs leading-6 text-faint">{i + 1}.</span>
              <Md className="prose-p:my-0">{q}</Md>
            </div>
            <Textarea
              className="ml-5 min-h-14 w-[calc(100%-1.25rem)]"
              placeholder="Your answer (optional; Claude uses its judgement for anything left blank)"
              value={answers[i] ?? ''}
              onChange={(e) => setAnswers((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && answered) void submit();
              }}
            />
          </li>
        ))}
      </ol>
      <div className="flex items-center justify-between gap-3 border-t border-violet-500/20 px-4 py-2.5">
        <span className="text-xs text-faint">Claude replies here and updates the plan with your answers.</span>
        <Button size="sm" variant="primary" icon={<Send className="size-3.5" />} disabled={!answered || busy} loading={pending} onClick={() => void submit()}>
          Send {answered ? `${answered} answer${answered === 1 ? '' : 's'}` : 'answers'}
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Thread entries
// ---------------------------------------------------------------------------

const KIND_LABEL: Partial<Record<CommentKind, { label: string; icon: React.ReactNode }>> = {
  plan: { label: 'Plan', icon: <ListChecks className="size-3" /> },
  answers: { label: 'Answers', icon: <ListChecks className="size-3" /> },
  change_request: { label: 'Change request', icon: <Wrench className="size-3" /> },
};

function CommentEntry({ comment: c, onShowPlan }: { comment: Comment; onShowPlan: () => void }) {
  const qc = useQueryClient();
  const isClaude = c.author === 'claude';
  const kind = KIND_LABEL[c.kind];
  const remove = async () => {
    try {
      await api.deleteComment(c.id);
      void qc.invalidateQueries({ queryKey: ['item-comments', c.itemId] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <li className="group flex gap-3">
      <span
        className={cn(
          'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
          isClaude ? 'bg-accent text-accent-fg' : 'border border-line bg-raised text-muted',
        )}
      >
        {isClaude ? <Sparkles className="size-3.5" /> : <User className="size-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-fg">{isClaude ? 'Claude' : 'You'}</span>
          <span className="text-faint" title={new Date(c.createdAt).toLocaleString()}>
            {timeAgo(c.createdAt)}
          </span>
          {kind && (
            <Badge className="text-faint">
              {kind.icon}
              {kind.label}
            </Badge>
          )}
          {c.planUpdated && (
            <button onClick={onShowPlan} className="inline-flex items-center gap-1 rounded-md border border-violet-500/30 px-1.5 text-[11px] font-medium text-violet-300 hover:bg-violet-500/10">
              <ListChecks className="size-3" /> {c.kind === 'plan' ? 'View plan' : 'Updated the plan'}
            </button>
          )}
          {!isClaude && (
            <button onClick={() => void remove()} className="ml-auto rounded p-1 text-faint opacity-0 group-hover:opacity-100 hover:text-rose-400" title="Delete comment">
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
        <div className={cn('mt-1.5 rounded-xl border px-3.5 py-2.5', isClaude ? 'border-line bg-panel' : 'border-line bg-bg')}>
          <Md className="prose-p:my-1.5">{c.body}</Md>
        </div>
      </div>
    </li>
  );
}

const PENDING_TEXT: Partial<Record<Run['kind'], string>> = {
  discuss: 'Claude is reading the thread and the code…',
  plan: 'Claude is drafting the plan…',
  implement: 'Claude is implementing this item…',
  revise: 'Claude is revising the branch with your feedback…',
  rebase: 'Rebasing onto the latest main…',
};

function PendingReply({ run, onShowLog }: { run: Run; onShowLog: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-dashed border-line px-4 py-3 text-sm text-muted">
      <span className="flex size-7 items-center justify-center rounded-full bg-accent/15 text-accent">
        <Spinner className="size-3.5 text-accent" />
      </span>
      <span className="flex-1">{run.status === 'queued' ? (run.waitingReason ?? 'Queued…') : (PENDING_TEXT[run.kind] ?? 'Claude is working…')}</span>
      <button className="text-xs text-faint hover:text-fg" onClick={onShowLog}>
        View log
      </button>
    </div>
  );
}

function FailedReply({ itemId, run, onShowLog }: { itemId: string; run: Run; onShowLog: () => void }) {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  return (
    <div className="flex items-start gap-3 rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-400">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Claude couldn't reply.</div>
        {run.error && <div className="mt-0.5 line-clamp-2 text-xs text-rose-400/80">{run.error}</div>}
      </div>
      <button className="text-xs text-rose-400/80 hover:text-rose-300" onClick={onShowLog}>
        Log
      </button>
      <Button
        size="xs"
        icon={<RotateCcw className="size-3" />}
        loading={pending}
        onClick={async () => {
          setPending(true);
          try {
            await api.retryDiscussion(itemId);
            void qc.invalidateQueries({ queryKey: ['item-runs', itemId] });
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
          } finally {
            setPending(false);
          }
        }}
      >
        Retry
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function Composer({ item, busy }: { item: BacklogItem; busy: boolean }) {
  const [body, setBody] = useState('');
  const { send, pending } = usePost(item.id);
  const canRevise = item.status === 'in_review' && !!item.branch;
  const empty = !body.trim();
  const post = async (intent: CommentIntent) => {
    if (empty) return;
    if (await send(body, intent)) setBody('');
  };

  return (
    <div className="sticky bottom-0 border-t border-line bg-panel/95 px-5 py-3 backdrop-blur">
      <Textarea
        className="min-h-20"
        placeholder={canRevise ? 'Ask Claude about the change, request edits to the branch, or leave a note…' : 'Ask Claude about the approach, answer a question, add context, or leave a note…'}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void post(busy ? 'comment' : 'ask');
          }
        }}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="mr-auto text-xs text-faint">
          {busy ? 'Claude is busy with this item. You can still leave a comment.' : 'Claude reads the code and this thread, and updates the plan if your reply changes it.'}
        </span>
        <Button size="sm" variant="ghost" disabled={empty} loading={pending} onClick={() => void post('comment')} title="Post without asking Claude">
          Comment
        </Button>
        {canRevise && (
          <Button size="sm" icon={<Wrench className="size-3.5" />} disabled={empty || busy} onClick={() => void post('change_request')} title="Claude changes the branch and updates the PR">
            Request changes
          </Button>
        )}
        <Button size="sm" variant="primary" icon={<Sparkles className="size-3.5" />} disabled={empty || busy} onClick={() => void post('ask')} title="⌘↵">
          Ask Claude
        </Button>
      </div>
    </div>
  );
}

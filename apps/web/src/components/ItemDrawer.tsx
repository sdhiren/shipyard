import {
  EFFORTS,
  ITEM_TYPES,
  PRIORITIES,
  PRIORITY_LABELS,
  TYPE_LABELS,
  type Activity,
  type BacklogItem,
  type Effort,
  type ItemType,
  type Priority,
} from '@shipyard/shared';
import {
  AlarmClock,
  Archive,
  Check,
  Ellipsis,
  ExternalLink,
  FileDiff,
  FileText,
  GitBranch,
  GitMerge,
  GitPullRequest,
  History,
  ListChecks,
  MessageSquare,
  Play,
  RefreshCw,
  Send,
  SkipForward,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Undo2,
  WandSparkles,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import { useAction, useDecide, useItem, useItemActivity, useItemRuns, useProject } from '../api/hooks';
import { cn, formatCost, formatDuration, timeAgo } from '../lib/utils';
import { EffortBadge, Md, PrBadge, PriorityIcon, RunStatusIcon, ScoreBadge, StatusBadge, TypeIcon } from './domain';
import { RunLog } from './RunLog';
import { Badge, Button, Dialog, Field, Input, Menu, Spinner, Tabs, Textarea } from './ui';

type Tab = 'overview' | 'activity' | 'runs' | 'diff';

export function ItemDrawer({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const { data: item, isLoading } = useItem(itemId);
  const [tab, setTab] = useState<Tab>('overview');
  const { data: runs } = useItemRuns(itemId);
  const activeRun = runs?.find((r) => r.status === 'running' || r.status === 'queued');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Jump to the live log when a run starts.
  useEffect(() => {
    if (activeRun) setTab('runs');
  }, [activeRun?.id]);

  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="animate-fade-in absolute inset-0 bg-black/30" onClick={onClose} />
      <aside className="animate-slide-in relative flex h-full w-full max-w-3xl flex-col border-l border-line bg-panel shadow-2xl">
        {isLoading || !item ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <>
            <DrawerHeader item={item} onClose={onClose} />
            <ActionBar item={item} busy={!!activeRun} onShowDiff={() => setTab('diff')} />
            <div className="border-b border-line px-5">
              <Tabs
                value={tab}
                onChange={setTab}
                tabs={[
                  { value: 'overview', label: 'Overview', icon: <FileText className="size-3.5" /> },
                  { value: 'activity', label: 'Activity', icon: <History className="size-3.5" /> },
                  { value: 'runs', label: 'Claude runs', icon: <Sparkles className="size-3.5" />, count: runs?.length },
                  ...(item.worktreePath || item.branch ? [{ value: 'diff' as const, label: 'Changes', icon: <FileDiff className="size-3.5" /> }] : []),
                ]}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {tab === 'overview' && <Overview item={item} />}
              {tab === 'activity' && <ActivityTab item={item} />}
              {tab === 'runs' && <RunsTab itemId={item.id} />}
              {tab === 'diff' && <DiffTab item={item} />}
            </div>
          </>
        )}
      </aside>
    </div>,
    document.body,
  );
}

function DrawerHeader({ item, onClose }: { item: BacklogItem; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const save = useAction((t: string) => api.updateItem(item.id, { title: t }));
  useEffect(() => setTitle(item.title), [item.title]);

  return (
    <div className="border-b border-line px-5 pt-4 pb-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono text-faint">{item.key}</span>
        <StatusBadge status={item.status} />
        {item.pr && <PrBadge pr={item.pr} />}
        {item.source !== 'manual' && <Badge className="text-faint">{item.source === 'ai' ? '✦ AI suggestion' : `from ${item.sourceRef ?? item.source}`}</Badge>}
        {item.snoozedUntil && new Date(item.snoozedUntil) > new Date() && (
          <Badge className="text-amber-400">
            <AlarmClock className="size-3" /> until {item.snoozedUntil.slice(0, 10)}
          </Badge>
        )}
        <button onClick={onClose} className="ml-auto rounded-md p-1 text-faint hover:bg-hover hover:text-fg" title="Close (Esc)">
          <X className="size-4" />
        </button>
      </div>
      {editing ? (
        <Input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (title.trim() && title !== item.title) save.mutate(title.trim());
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="mt-2 h-10 text-lg font-semibold"
        />
      ) : (
        <h2 onClick={() => setEditing(true)} className="mt-2 cursor-text text-lg leading-snug font-semibold tracking-tight text-fg">
          {item.title}
        </h2>
      )}
      <PropertyRow item={item} />
    </div>
  );
}

function PropertyRow({ item }: { item: BacklogItem }) {
  const update = useAction((patch: Parameters<typeof api.updateItem>[1]) => api.updateItem(item.id, patch));
  const selectCls = 'h-6 cursor-pointer rounded-md border border-line bg-transparent px-1.5 text-xs text-muted hover:border-line-strong focus:outline-none';
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5">
        <TypeIcon type={item.type} />
        <select className={selectCls} value={item.type} onChange={(e) => update.mutate({ type: e.target.value as ItemType })}>
          {ITEM_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5">
        <PriorityIcon priority={item.priority} />
        <select className={selectCls} value={item.priority} onChange={(e) => update.mutate({ priority: e.target.value as Priority })}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
      <select className={selectCls} value={item.effort ?? ''} onChange={(e) => update.mutate({ effort: (e.target.value || null) as Effort | null })} title="Effort">
        <option value="">Effort…</option>
        {EFFORTS.map((x) => (
          <option key={x} value={x}>
            Effort {x.toUpperCase()}
          </option>
        ))}
      </select>
      <select
        className={selectCls}
        value={item.impact ?? ''}
        onChange={(e) => update.mutate({ impact: e.target.value ? Number(e.target.value) : null })}
        title="Impact"
      >
        <option value="">Impact…</option>
        {[1, 2, 3, 4, 5].map((n) => (
          <option key={n} value={n}>
            Impact {n}/5
          </option>
        ))}
      </select>
      <ScoreBadge score={item.score} />
      {item.totalCostUsd > 0 && <Badge title="Claude spend on this item">{formatCost(item.totalCostUsd)}</Badge>}
      {item.tags.map((t) => (
        <Badge key={t} className="text-faint">
          #{t}
        </Badge>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The decision bar: what can I do with this item right now?
// ---------------------------------------------------------------------------

function ActionBar({ item, busy, onShowDiff }: { item: BacklogItem; busy: boolean; onShowDiff: () => void }) {
  const decide = useDecide();
  const { data: project } = useProject(item.projectId);
  const hasGithub = !!project?.git.githubRepo;
  const [dialog, setDialog] = useState<null | 'skip' | 'revise' | 'link' | 'merge' | 'delete'>(null);
  const d = (decision: Parameters<typeof decide.mutate>[0]['decision'], extra: { reason?: string; until?: string } = {}) =>
    decide.mutate({ id: item.id, decision, ...extra });
  const openPr = useAction(() => api.openPr(item.id), { success: 'Pull request opened' });
  const syncPr = useAction(() => api.syncPr(item.id), { success: 'PR status refreshed' });
  const del = useAction(() => api.deleteItem(item.id), { success: 'Deleted permanently' });
  const snoozeDays = (days: number) => d('snooze', { until: new Date(Date.now() + days * 86_400_000).toISOString() });

  const snoozeMenu = (
    <Menu
      trigger={
        <Button size="sm" variant="ghost" icon={<AlarmClock className="size-3.5" />}>
          Snooze
        </Button>
      }
      items={[
        { label: 'Tomorrow', onSelect: () => snoozeDays(1) },
        { label: 'Next week', onSelect: () => snoozeDays(7) },
        { label: 'Next month', onSelect: () => snoozeDays(30) },
        { label: 'In 3 months', onSelect: () => snoozeDays(90) },
      ]}
    />
  );

  const more = (
    <Menu
      trigger={<Button size="sm" variant="ghost" icon={<Ellipsis className="size-4" />} aria-label="More actions" />}
      items={[
        { label: 'Draft a plan with Claude', icon: <ListChecks className="size-3.5" />, onSelect: () => d('plan'), disabled: busy },
        { label: 'Link existing PR…', icon: <GitPullRequest className="size-3.5" />, onSelect: () => setDialog('link'), disabled: !hasGithub },
        { label: 'Mark done', icon: <Check className="size-3.5" />, onSelect: () => d('done') },
        'separator',
        ...(item.worktreePath
          ? [{ label: 'Discard workspace (keeps branch)', icon: <Trash2 className="size-3.5" />, onSelect: () => void api.discardWorkspace(item.id) }]
          : []),
        { label: 'Archive', icon: <Archive className="size-3.5" />, onSelect: () => d('archive'), danger: true },
      ]}
    />
  );

  let primary: ReactNode = null;
  switch (item.status) {
    case 'proposed':
      primary = (
        <>
          <Button size="sm" variant="primary" icon={<ThumbsUp className="size-3.5" />} onClick={() => d('approve')}>
            Approve
          </Button>
          <Button size="sm" icon={<Play className="size-3.5" />} onClick={() => d('up_next')}>
            Approve as Up next
          </Button>
          <Button size="sm" variant="ghost" icon={<ThumbsDown className="size-3.5" />} onClick={() => d('reject')}>
            Reject
          </Button>
        </>
      );
      break;
    case 'backlog':
    case 'planned':
      primary = (
        <>
          <Button size="sm" variant="primary" icon={<WandSparkles className="size-3.5" />} onClick={() => d('implement')} disabled={busy}>
            Implement with Claude
          </Button>
          <Button size="sm" icon={<ListChecks className="size-3.5" />} onClick={() => d('plan')} disabled={busy}>
            {item.plan ? 'Re-plan' : 'Plan first'}
          </Button>
          {item.status === 'backlog' && (
            <Button size="sm" variant="ghost" icon={<Play className="size-3.5" />} onClick={() => d('up_next')}>
              Up next
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<SkipForward className="size-3.5" />} onClick={() => setDialog('skip')}>
            Skip
          </Button>
          {snoozeMenu}
        </>
      );
      break;
    case 'in_progress':
      primary = busy ? (
        <span className="flex items-center gap-2 text-xs text-amber-400">
          <Spinner className="size-3.5 text-amber-400" /> Claude is working on this. Follow along in the Claude runs tab.
        </span>
      ) : (
        <Button size="sm" variant="primary" icon={<WandSparkles className="size-3.5" />} onClick={() => d('implement')}>
          Resume implementation
        </Button>
      );
      break;
    case 'in_review':
      primary = (
        <>
          {item.pr ? (
            <a href={item.pr.url} target="_blank" rel="noreferrer">
              <Button size="sm" variant="primary" icon={<ExternalLink className="size-3.5" />}>
                Review PR #{item.pr.number}
              </Button>
            </a>
          ) : hasGithub ? (
            <Button size="sm" variant="primary" icon={<GitPullRequest className="size-3.5" />} loading={openPr.isPending} onClick={() => openPr.mutate(undefined)}>
              Push & open PR
            </Button>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-muted" title="This project has no GitHub remote, so the branch stays local">
              <GitBranch className="size-3.5" /> Branch ready locally
            </span>
          )}
          <Button size="sm" icon={<MessageSquare className="size-3.5" />} onClick={() => setDialog('revise')} disabled={busy}>
            Request changes
          </Button>
          {item.pr?.state === 'OPEN' && (
            <Button size="sm" variant="success" icon={<GitMerge className="size-3.5" />} onClick={() => setDialog('merge')}>
              Merge
            </Button>
          )}
          {item.pr && (
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={syncPr.isPending} onClick={() => syncPr.mutate(undefined)}>
              Sync
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<FileDiff className="size-3.5" />} onClick={onShowDiff}>
            Diff
          </Button>
        </>
      );
      break;
    case 'done':
      primary = (
        <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} onClick={() => d('restore')}>
          Reopen
        </Button>
      );
      break;
    default:
      primary = (
        <>
          <Button size="sm" icon={<Undo2 className="size-3.5" />} onClick={() => d('restore')}>
            Restore to backlog
          </Button>
          <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => setDialog('delete')}>
            Delete permanently
          </Button>
        </>
      );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-bg/40 px-5 py-2.5">
      {primary}
      <div className="ml-auto">{more}</div>

      <ReasonDialog
        open={dialog === 'skip'}
        title="Skip this item?"
        description="It leaves the board but stays in history. A short reason helps future you."
        confirm="Skip"
        onClose={() => setDialog(null)}
        onConfirm={(reason) => d('skip', { reason })}
      />
      <ReviseDialog open={dialog === 'revise'} item={item} onClose={() => setDialog(null)} />
      <LinkPrDialog open={dialog === 'link'} item={item} onClose={() => setDialog(null)} />
      <ConfirmDialog
        open={dialog === 'merge'}
        title={`Squash-merge PR #${item.pr?.number}?`}
        description="This merges into the default branch on GitHub and deletes the remote branch."
        confirm="Squash & merge"
        onClose={() => setDialog(null)}
        onConfirm={() => api.mergePr(item.id).then(() => undefined)}
      />
      <ConfirmDialog
        open={dialog === 'delete'}
        title="Delete permanently?"
        description="The item and its timeline are removed for good. Runs and branches are not affected."
        confirm="Delete"
        danger
        onClose={() => setDialog(null)}
        onConfirm={() => del.mutateAsync(undefined).then(() => undefined)}
      />
    </div>
  );
}

function ReasonDialog(props: { open: boolean; title: string; description: string; confirm: string; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      description={props.description}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              props.onConfirm(reason);
              props.onClose();
              setReason('');
            }}
          >
            {props.confirm}
          </Button>
        </>
      }
    >
      <Textarea autoFocus placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
    </Dialog>
  );
}

function ConfirmDialog(props: { open: boolean; title: string; description: string; confirm: string; danger?: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [loading, setLoading] = useState(false);
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      description={props.description}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant={props.danger ? 'danger' : 'primary'}
            loading={loading}
            onClick={async () => {
              setLoading(true);
              try {
                await props.onConfirm();
                props.onClose();
              } finally {
                setLoading(false);
              }
            }}
          >
            {props.confirm}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">This can't be undone from Shipyard.</p>
    </Dialog>
  );
}

function ReviseDialog({ open, item, onClose }: { open: boolean; item: BacklogItem; onClose: () => void }) {
  const [feedback, setFeedback] = useState('');
  const revise = useAction((f: string) => api.revise(item.id, f), { success: 'Claude is revising the branch' });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Request changes from Claude"
      description="Claude resumes its session on the same branch, applies your feedback, commits and pushes to the PR."
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Send className="size-3.5" />}
            loading={revise.isPending}
            disabled={feedback.trim().length < 3}
            onClick={() => revise.mutate(feedback, { onSuccess: () => (onClose(), setFeedback('')) })}
          >
            Send to Claude
          </Button>
        </>
      }
    >
      <Textarea autoFocus className="min-h-40" placeholder="e.g. Rename the config flag to RATE_LIMIT_RPS and add a test for the 429 path." value={feedback} onChange={(e) => setFeedback(e.target.value)} />
    </Dialog>
  );
}

function LinkPrDialog({ open, item, onClose }: { open: boolean; item: BacklogItem; onClose: () => void }) {
  const [ref, setRef] = useState('');
  const link = useAction((r: string) => api.linkPr(item.id, r), { success: 'PR linked' });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Link an existing pull request"
      footer={
        <Button variant="primary" loading={link.isPending} disabled={!ref.trim()} onClick={() => link.mutate(ref, { onSuccess: onClose })}>
          Link PR
        </Button>
      }
    >
      <Field label="PR URL or number">
        <Input autoFocus placeholder="https://github.com/you/repo/pull/42 or 42" value={ref} onChange={(e) => setRef(e.target.value)} />
      </Field>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="px-5 py-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-faint uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Overview({ item }: { item: BacklogItem }) {
  const [editing, setEditing] = useState(false);
  const [desc, setDesc] = useState(item.description);
  const [criteria, setCriteria] = useState(item.acceptanceCriteria.join('\n'));
  const save = useAction((patch: Parameters<typeof api.updateItem>[1]) => api.updateItem(item.id, patch), { success: 'Saved' });
  useEffect(() => {
    setDesc(item.description);
    setCriteria(item.acceptanceCriteria.join('\n'));
  }, [item.description, item.acceptanceCriteria]);

  return (
    <div className="divide-y divide-line">
      <Section
        title="Description"
        action={
          editing ? (
            <div className="flex gap-1">
              <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="xs"
                variant="primary"
                onClick={() => {
                  save.mutate({
                    description: desc,
                    acceptanceCriteria: criteria
                      .split('\n')
                      .map((s) => s.replace(/^[-*]\s*/, '').trim())
                      .filter(Boolean),
                  });
                  setEditing(false);
                }}
              >
                Save
              </Button>
            </div>
          ) : (
            <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )
        }
      >
        {editing ? (
          <div className="space-y-3">
            <Textarea className="min-h-48 font-mono text-xs" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Markdown supported" />
            <Field label="Acceptance criteria (one per line)">
              <Textarea className="min-h-28 font-mono text-xs" value={criteria} onChange={(e) => setCriteria(e.target.value)} />
            </Field>
          </div>
        ) : item.description ? (
          <Md>{item.description}</Md>
        ) : (
          <p className="text-sm text-faint">No description yet. Add one, or ask Claude to plan it.</p>
        )}
      </Section>

      {!editing && item.acceptanceCriteria.length > 0 && (
        <Section title="Acceptance criteria">
          <ul className="space-y-1.5">
            {item.acceptanceCriteria.map((c, i) => (
              <li key={i} className="flex gap-2 text-sm text-fg">
                <Check className={cn('mt-0.5 size-4 shrink-0', item.status === 'done' ? 'text-emerald-400' : 'text-faint')} />
                {c}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {item.rationale && (
        <Section title="Why Claude suggested this">
          <p className="text-sm text-muted">{item.rationale}</p>
          {item.affectedFiles.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {item.affectedFiles.map((f) => (
                <code key={f} className="rounded bg-hover px-1.5 py-0.5 font-mono text-[11px] text-muted">
                  {f}
                </code>
              ))}
            </div>
          )}
        </Section>
      )}

      {item.plan && (
        <Section title="Implementation plan">
          <div className="rounded-xl border border-line bg-bg p-4">
            <Md>{item.plan}</Md>
          </div>
        </Section>
      )}

      {(item.branch || item.decisionReason) && (
        <Section title="Delivery">
          <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
            {item.branch && (
              <>
                <dt className="text-faint">Branch</dt>
                <dd className="flex items-center gap-1.5 font-mono text-xs text-muted">
                  <GitBranch className="size-3.5" />
                  {item.branch}
                </dd>
              </>
            )}
            {item.worktreePath && (
              <>
                <dt className="text-faint">Worktree</dt>
                <dd className="truncate font-mono text-xs text-muted" title={item.worktreePath}>
                  {item.worktreePath}
                </dd>
              </>
            )}
            {item.pr && (
              <>
                <dt className="text-faint">Pull request</dt>
                <dd className="flex items-center gap-2 text-xs text-muted">
                  <PrBadge pr={item.pr} />
                  {item.pr.additions != null && (
                    <span>
                      <span className="text-emerald-400">+{item.pr.additions}</span> <span className="text-rose-400">−{item.pr.deletions}</span> in {item.pr.changedFiles} files
                    </span>
                  )}
                  {item.pr.reviewDecision && <Badge>{item.pr.reviewDecision.toLowerCase().replace('_', ' ')}</Badge>}
                  <span className="text-faint">synced {timeAgo(item.pr.lastSyncedAt)}</span>
                </dd>
              </>
            )}
            {item.decisionReason && (
              <>
                <dt className="text-faint">Decision note</dt>
                <dd className="text-muted">{item.decisionReason}</dd>
              </>
            )}
          </dl>
        </Section>
      )}

      <Section title="Details">
        <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 text-xs text-muted">
          <dt className="text-faint">Created</dt>
          <dd>{timeAgo(item.createdAt)}</dd>
          <dt className="text-faint">Updated</dt>
          <dd>{timeAgo(item.updatedAt)}</dd>
          {item.startedAt && (
            <>
              <dt className="text-faint">Started</dt>
              <dd>{timeAgo(item.startedAt)}</dd>
            </>
          )}
          {item.completedAt && (
            <>
              <dt className="text-faint">Completed</dt>
              <dd>{timeAgo(item.completedAt)}</dd>
            </>
          )}
          <dt className="text-faint">Effort</dt>
          <dd>
            <EffortBadge effort={item.effort} />
          </dd>
        </dl>
      </Section>
    </div>
  );
}

const ACTIVITY_ICON: Partial<Record<Activity['kind'], ReactNode>> = {
  created: <Sparkles className="size-3.5" />,
  note: <MessageSquare className="size-3.5" />,
  run_started: <Play className="size-3.5" />,
  run_finished: <Check className="size-3.5" />,
  pr_opened: <GitPullRequest className="size-3.5" />,
  pr_updated: <RefreshCw className="size-3.5" />,
  pr_merged: <GitMerge className="size-3.5" />,
  plan_ready: <ListChecks className="size-3.5" />,
};

function ActivityTab({ item }: { item: BacklogItem }) {
  const { data: activity } = useItemActivity(item.id);
  const [note, setNote] = useState('');
  const add = useAction((b: string) => api.addNote(item.id, b), { invalidate: [['item-activity', item.id]] });
  return (
    <div className="px-5 py-4">
      <div className="mb-5 flex gap-2">
        <Textarea
          className="min-h-16"
          placeholder="Add a note… (⌘↵ to save)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && note.trim()) add.mutate(note, { onSuccess: () => setNote('') });
          }}
        />
        <Button className="self-end" disabled={!note.trim()} loading={add.isPending} onClick={() => add.mutate(note, { onSuccess: () => setNote('') })}>
          Note
        </Button>
      </div>
      <ol className="relative space-y-4 border-l border-line pl-5">
        {activity?.map((a) => (
          <li key={a.id} className="relative">
            <span className="absolute top-0.5 -left-[29px] flex size-[18px] items-center justify-center rounded-full border border-line bg-panel text-faint">
              {ACTIVITY_ICON[a.kind] ?? <span className="size-1.5 rounded-full bg-faint" />}
            </span>
            {a.kind === 'note' ? (
              <div className="rounded-lg border border-line bg-bg p-3">
                <Md>{a.message}</Md>
              </div>
            ) : (
              <p className="text-sm text-fg">
                {a.message}
                {typeof a.meta?.url === 'string' && (
                  <a className="ml-1 text-accent" href={a.meta.url} target="_blank" rel="noreferrer">
                    ↗
                  </a>
                )}
              </p>
            )}
            <time className="text-xs text-faint">{timeAgo(a.createdAt)}</time>
          </li>
        ))}
      </ol>
    </div>
  );
}

function RunsTab({ itemId }: { itemId: string }) {
  const { data: runs } = useItemRuns(itemId);
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected ?? runs?.[0]?.id ?? null;
  if (!runs?.length) return <p className="px-5 py-8 text-center text-sm text-faint">No Claude runs yet.</p>;
  return (
    <div className="flex h-full flex-col gap-3 px-5 py-4">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {runs.map((r) => (
          <button
            key={r.id}
            onClick={() => setSelected(r.id)}
            className={cn(
              'flex shrink-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs',
              current === r.id ? 'border-accent bg-accent-soft text-fg' : 'border-line text-muted hover:bg-hover',
            )}
          >
            <RunStatusIcon status={r.status} />
            <span className="capitalize">{r.kind}</span>
            <span className="text-faint">{timeAgo(r.createdAt)}</span>
            {r.costUsd != null && <span className="text-faint">{formatCost(r.costUsd)}</span>}
            {r.durationMs != null && <span className="text-faint">{formatDuration(r.durationMs)}</span>}
          </button>
        ))}
      </div>
      {current && <RunLog runId={current} className="min-h-[420px] flex-1" />}
    </div>
  );
}

function DiffTab({ item }: { item: BacklogItem }) {
  const [data, setData] = useState<{ stat: string; diff: string } | null>(null);
  useEffect(() => {
    void api.diff(item.id).then(setData);
  }, [item.id, item.updatedAt]);
  if (!data) return <Spinner className="m-5" />;
  if (!data.diff) return <p className="px-5 py-8 text-center text-sm text-faint">No local changes to show (the worktree may have been cleaned up).</p>;
  return (
    <div className="space-y-3 px-5 py-4">
      <pre className="rounded-lg border border-line bg-bg p-3 font-mono text-[11px] text-muted">{data.stat}</pre>
      <pre className="overflow-x-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11px] leading-relaxed">
        {data.diff.split('\n').map((line, i) => (
          <div
            key={i}
            className={cn(
              line.startsWith('+') && !line.startsWith('+++') && 'bg-emerald-500/10 text-emerald-400',
              line.startsWith('-') && !line.startsWith('---') && 'bg-rose-500/10 text-rose-400',
              line.startsWith('@@') && 'text-sky-400',
              line.startsWith('diff --git') && 'mt-3 font-semibold text-fg',
            )}
          >
            {line || ' '}
          </div>
        ))}
      </pre>
    </div>
  );
}

import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
  type BacklogItem,
  type ChecksState,
  type ItemStatus,
  type ItemType,
  type Priority,
  type PullRequestInfo,
  type RunStatus,
} from '@shipyard/shared';
import {
  BookOpen,
  Bug,
  CircleCheck,
  CircleDot,
  CircleX,
  Flame,
  FlaskConical,
  Gauge,
  GitMerge,
  GitPullRequest,
  Hammer,
  Lightbulb,
  LoaderCircle,
  Shield,
  Sparkles,
  TrendingUp,
  Wrench,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../lib/utils';
import { Badge } from './ui';

export const STATUS_STYLES: Record<ItemStatus, { dot: string; text: string }> = {
  proposed: { dot: 'bg-violet-400', text: 'text-violet-400' },
  backlog: { dot: 'bg-zinc-400', text: 'text-muted' },
  planned: { dot: 'bg-sky-400', text: 'text-sky-400' },
  in_progress: { dot: 'bg-amber-400', text: 'text-amber-400' },
  in_review: { dot: 'bg-indigo-400', text: 'text-indigo-400' },
  done: { dot: 'bg-emerald-400', text: 'text-emerald-400' },
  skipped: { dot: 'bg-zinc-500', text: 'text-faint' },
  rejected: { dot: 'bg-rose-400', text: 'text-rose-400' },
  archived: { dot: 'bg-zinc-600', text: 'text-faint' },
};

export function StatusDot({ status, className }: { status: ItemStatus; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0 rounded-full', STATUS_STYLES[status].dot, className)}>
      {status === 'in_progress' && <span className="absolute inset-0 animate-ping rounded-full bg-amber-400 opacity-60" />}
    </span>
  );
}

export function StatusBadge({ status }: { status: ItemStatus }) {
  return (
    <Badge className={cn('gap-1.5', STATUS_STYLES[status].text)}>
      <StatusDot status={status} />
      {STATUS_LABELS[status]}
    </Badge>
  );
}

const PRIORITY_STYLES: Record<Priority, string> = {
  p0: 'text-rose-400',
  p1: 'text-orange-400',
  p2: 'text-sky-400',
  p3: 'text-faint',
};

/** Signal-bar priority glyph, Linear style. */
export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  if (priority === 'p0') return <Flame className={cn('size-3.5', PRIORITY_STYLES.p0, className)} aria-label="Urgent" />;
  const bars = priority === 'p1' ? 3 : priority === 'p2' ? 2 : 1;
  return (
    <span className={cn('inline-flex h-3.5 items-end gap-[2px]', className)} title={PRIORITY_LABELS[priority]} aria-label={PRIORITY_LABELS[priority]}>
      {[1, 2, 3].map((b) => (
        <span key={b} className={cn('w-[3px] rounded-sm', b <= bars ? 'bg-current' : 'bg-line-strong', PRIORITY_STYLES[priority])} style={{ height: `${b * 4 + 2}px` }} />
      ))}
    </span>
  );
}

const TYPE_ICONS: Record<ItemType, typeof Bug> = {
  feature: Sparkles,
  improvement: TrendingUp,
  bug: Bug,
  tech_debt: Wrench,
  performance: Gauge,
  security: Shield,
  testing: FlaskConical,
  docs: BookOpen,
  dx: Hammer,
};
const TYPE_COLORS: Record<ItemType, string> = {
  feature: 'text-violet-400',
  improvement: 'text-sky-400',
  bug: 'text-rose-400',
  tech_debt: 'text-amber-400',
  performance: 'text-emerald-400',
  security: 'text-red-400',
  testing: 'text-teal-400',
  docs: 'text-zinc-400',
  dx: 'text-orange-400',
};

export function TypeIcon({ type, className }: { type: ItemType; className?: string }) {
  const Icon = TYPE_ICONS[type];
  return <Icon className={cn('size-3.5 shrink-0', TYPE_COLORS[type], className)} aria-label={TYPE_LABELS[type]} />;
}

export function TypeBadge({ type }: { type: ItemType }) {
  return (
    <Badge>
      <TypeIcon type={type} className="size-3" />
      {TYPE_LABELS[type]}
    </Badge>
  );
}

export function EffortBadge({ effort }: { effort: BacklogItem['effort'] }) {
  if (!effort) return null;
  return (
    <Badge className="font-mono uppercase" title="Effort">
      {effort}
    </Badge>
  );
}

export function ScoreBadge({ score }: { score: number | null }) {
  if (score == null) return null;
  const tone = score >= 1.5 ? 'text-emerald-400 border-emerald-500/30' : score >= 0.8 ? 'text-sky-400 border-sky-500/30' : 'text-faint';
  return (
    <Badge className={tone} title="Impact ÷ effort: higher is a better bet">
      <Lightbulb className="size-3" />
      {score.toFixed(1)}
    </Badge>
  );
}

const CHECK_ICON: Record<ChecksState, React.ReactNode> = {
  passing: <CircleCheck className="size-3 text-emerald-400" />,
  failing: <CircleX className="size-3 text-rose-400" />,
  pending: <LoaderCircle className="size-3 animate-spin text-amber-400" />,
  none: null,
};

export function PrBadge({ pr, compact }: { pr: PullRequestInfo; compact?: boolean }) {
  const merged = pr.state === 'MERGED';
  const closed = pr.state === 'CLOSED';
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium transition-colors hover:brightness-125',
        merged ? 'border-violet-500/30 text-violet-400' : closed ? 'border-rose-500/30 text-rose-400' : 'border-emerald-500/30 text-emerald-400',
      )}
      title={`PR #${pr.number} · ${pr.state.toLowerCase()}${pr.reviewDecision ? ` · ${pr.reviewDecision.toLowerCase()}` : ''}`}
    >
      {merged ? <GitMerge className="size-3" /> : <GitPullRequest className="size-3" />}#{pr.number}
      {!compact && pr.isDraft && <span className="text-faint">draft</span>}
      {!merged && CHECK_ICON[pr.checks]}
    </a>
  );
}

export const RUN_STATUS_STYLES: Record<RunStatus, string> = {
  queued: 'text-faint',
  running: 'text-amber-400',
  succeeded: 'text-emerald-400',
  failed: 'text-rose-400',
  cancelled: 'text-faint',
};

export function RunStatusIcon({ status, className }: { status: RunStatus; className?: string }) {
  const c = cn('size-3.5 shrink-0', RUN_STATUS_STYLES[status], className);
  if (status === 'running') return <LoaderCircle className={cn(c, 'animate-spin')} />;
  if (status === 'succeeded') return <CircleCheck className={c} />;
  if (status === 'failed') return <CircleX className={c} />;
  return <CircleDot className={c} />;
}

export function ProjectDot({ color, className }: { color: string; className?: string }) {
  return <span className={cn('inline-block size-2.5 shrink-0 rounded-[4px]', className)} style={{ background: color }} />;
}

export function Md({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('prose-shipyard', className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
        {children}
      </Markdown>
    </div>
  );
}

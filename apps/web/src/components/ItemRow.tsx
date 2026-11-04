import type { BacklogItem } from '@shipyard/shared';
import { AlarmClock, GitBranch, Paperclip } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn, timeAgo } from '../lib/utils';
import { EffortBadge, PrBadge, PriorityIcon, ScoreBadge, StatusDot, TypeIcon } from './domain';
import { useUi } from '../lib/ui-context';

/** Compact single-line item used by lists, dashboards and the inbox. */
export function ItemRow({
  item,
  leading,
  trailing,
  meta,
  selected,
  className,
}: {
  item: BacklogItem;
  leading?: ReactNode;
  trailing?: ReactNode;
  meta?: ReactNode;
  selected?: boolean;
  className?: string;
}) {
  const ui = useUi();
  const snoozed = item.snoozedUntil && new Date(item.snoozedUntil) > new Date();
  return (
    <div
      onClick={() => ui.openItem(item.id)}
      className={cn(
        'group flex h-10 cursor-pointer items-center gap-3 px-4 text-sm transition-colors hover:bg-hover/60',
        selected && 'bg-accent-soft/60',
        className,
      )}
    >
      {leading}
      <PriorityIcon priority={item.priority} className="w-3.5 shrink-0" />
      <span className="w-14 shrink-0 font-mono text-xs text-faint">{item.key}</span>
      <StatusDot status={item.status} />
      <TypeIcon type={item.type} />
      <span className="min-w-0 flex-1 truncate text-fg">{item.title}</span>
      {meta}
      {item.attachmentCount > 0 && (
        <span className="inline-flex items-center gap-0.5 text-xs text-faint" title={`${item.attachmentCount} attachment${item.attachmentCount === 1 ? '' : 's'}`}>
          <Paperclip className="size-3.5" />
          {item.attachmentCount}
        </span>
      )}
      {snoozed && <AlarmClock className="size-3.5 text-amber-400" />}
      {item.branch && !item.pr && <GitBranch className="size-3.5 text-faint" />}
      {item.pr && <PrBadge pr={item.pr} compact />}
      <ScoreBadge score={item.score} />
      <EffortBadge effort={item.effort} />
      <span className="hidden w-16 shrink-0 text-right text-xs text-faint lg:block">{timeAgo(item.updatedAt).replace(' ago', '')}</span>
      {trailing}
    </div>
  );
}

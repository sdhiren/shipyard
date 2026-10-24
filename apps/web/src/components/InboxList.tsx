import { PRIORITY_LABELS, TYPE_LABELS, type BacklogItem } from '@shipyard/shared';
import { Inbox, Play, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useBulkDecide, useDecide } from '../api/hooks';
import { cn, isTypingTarget } from '../lib/utils';
import { EffortBadge, Md, PriorityIcon, ScoreBadge, TypeIcon } from './domain';
import { useUi } from './Layout';
import { Badge, Button, EmptyState, Kbd } from './ui';

/**
 * Triage queue for AI suggestions and imports.
 * Keyboard: j/k move · a approve · u approve as Up next · r reject · ↵ open.
 */
export function InboxList({ items, header, projectLabel }: { items: BacklogItem[]; header?: ReactNode; projectLabel?: (item: BacklogItem) => ReactNode }) {
  const [cursor, setCursor] = useState(0);
  const decide = useDecide();
  const bulk = useBulkDecide();
  const ui = useUi();
  const current = items[Math.min(cursor, items.length - 1)];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || new URLSearchParams(location.search).has('item')) return;
      if (!current) return;
      const act = (decision: 'approve' | 'up_next' | 'reject') => decide.mutate({ id: current.id, decision });
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          setCursor((c) => Math.min(c + 1, items.length - 1));
          break;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          setCursor((c) => Math.max(c - 1, 0));
          break;
        case 'a':
          act('approve');
          break;
        case 'u':
          act('up_next');
          break;
        case 'r':
          act('reject');
          break;
        case 'Enter':
          ui.openItem(current.id);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, items.length, decide, ui]);

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Inbox className="size-5" />}
        title="Inbox zero"
        description="New AI suggestions and imported items show up here for you to approve or reject."
      />
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        {header}
        <div className="ml-auto flex items-center gap-3 text-xs text-faint">
          <span className="hidden items-center gap-1 md:flex">
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> move <Kbd>A</Kbd> approve <Kbd>U</Kbd> up next <Kbd>R</Kbd> reject
          </span>
          <Button size="sm" icon={<ThumbsUp className="size-3.5" />} onClick={() => bulk.mutate({ ids: items.map((i) => i.id), decision: 'approve' })}>
            Approve all {items.length}
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        {items.map((it, idx) => (
          <article
            key={it.id}
            onMouseEnter={() => setCursor(idx)}
            className={cn(
              'rounded-xl border bg-panel p-4 transition-colors',
              current?.id === it.id ? 'border-accent/60 ring-1 ring-accent/30' : 'border-line',
            )}
          >
            <div className="flex items-start gap-3">
              <TypeIcon type={it.type} className="mt-1 size-4" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
                  {projectLabel?.(it)}
                  <span className="font-mono">{it.key}</span>
                  <span>{TYPE_LABELS[it.type]}</span>
                  <span className="flex items-center gap-1">
                    <PriorityIcon priority={it.priority} /> {PRIORITY_LABELS[it.priority]}
                  </span>
                  <EffortBadge effort={it.effort} />
                  {it.impact && <Badge title="Impact">impact {it.impact}/5</Badge>}
                  <ScoreBadge score={it.score} />
                  <Badge className="text-faint">{it.source === 'ai' ? '✦ Claude' : (it.sourceRef ?? it.source)}</Badge>
                </div>
                <button className="mt-1 text-left text-[15px] font-medium text-fg hover:underline" onClick={() => ui.openItem(it.id)}>
                  {it.title}
                </button>
                {it.rationale && <p className="mt-1 text-sm text-muted">{it.rationale}</p>}
                {current?.id === it.id && it.description && (
                  <div className="mt-3 max-h-56 overflow-hidden rounded-lg border border-line bg-bg p-3 [mask-image:linear-gradient(to_bottom,black_75%,transparent)]">
                    <Md>{it.description}</Md>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 flex-col gap-1.5">
                <Button size="sm" variant="primary" icon={<ThumbsUp className="size-3.5" />} onClick={() => decide.mutate({ id: it.id, decision: 'approve' })}>
                  Approve
                </Button>
                <Button size="sm" icon={<Play className="size-3.5" />} onClick={() => decide.mutate({ id: it.id, decision: 'up_next' })}>
                  Up next
                </Button>
                <Button size="sm" variant="ghost" icon={<ThumbsDown className="size-3.5" />} onClick={() => decide.mutate({ id: it.id, decision: 'reject' })}>
                  Reject
                </Button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

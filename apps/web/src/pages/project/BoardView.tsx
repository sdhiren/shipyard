import { BOARD_STATUSES, STATUS_LABELS, type BacklogItem, type ItemStatus } from '@shipyard/shared';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useQueryClient } from '@tanstack/react-query';
import { AlarmClock, Clock, GitBranch, Plus, Sparkles, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { useDecide, useItems, useItemRuns } from '../../api/hooks';
import { EffortBadge, PrBadge, PriorityIcon, ScoreBadge, StatusDot, TypeIcon } from '../../components/domain';
import { useUi } from '../../lib/ui-context';
import { Spinner } from '../../components/ui';
import { cn } from '../../lib/utils';

/**
 * Kanban board. Dragging a card into "In progress" asks Claude to implement it;
 * other columns are plain status moves. Cards can be reordered within a column.
 */
export function BoardView({ projectId, search }: { projectId: string; search: string }) {
  const { data: items, isLoading } = useItems(projectId, { status: BOARD_STATUSES, q: search || undefined });
  const [dragging, setDragging] = useState<BacklogItem | null>(null);
  const qc = useQueryClient();
  const decide = useDecide();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const columns = useMemo(() => {
    const map = new Map<ItemStatus, BacklogItem[]>(BOARD_STATUSES.map((s) => [s, []]));
    for (const it of items ?? []) map.get(it.status)?.push(it);
    for (const list of map.values()) list.sort((a, b) => a.position - b.position);
    // Keep "Done" short: most recent first.
    map.get('done')?.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
    return map;
  }, [items]);

  const onDragEnd = async (e: DragEndEvent) => {
    setDragging(null);
    const item = items?.find((i) => i.id === e.active.id);
    if (!item || !e.over) return;
    const overId = String(e.over.id);
    let status: ItemStatus;
    let position: number;
    if (overId.startsWith('col:')) {
      status = overId.slice(4) as ItemStatus;
      const col = columns.get(status) ?? [];
      position = (col.at(-1)?.position ?? 0) + 1000;
    } else {
      const target = items?.find((i) => i.id === overId);
      if (!target || target.id === item.id) return;
      status = target.status;
      const col = (columns.get(status) ?? []).filter((i) => i.id !== item.id);
      const idx = col.findIndex((i) => i.id === target.id);
      const before = col[idx - 1]?.position ?? target.position - 1000;
      position = (before + target.position) / 2;
    }

    if (status === 'in_progress' && item.status !== 'in_progress') {
      decide.mutate({ id: item.id, decision: 'implement' });
      return;
    }
    if (status === item.status && position === item.position) return;

    // Optimistic update so the card lands immediately.
    qc.setQueriesData<BacklogItem[]>({ queryKey: ['items', projectId] }, (old) => old?.map((i) => (i.id === item.id ? { ...i, status, position } : i)));
    try {
      await api.moveItem(item.id, status, position);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Move failed');
    } finally {
      void qc.invalidateQueries({ queryKey: ['items', projectId] });
    }
  };

  if (isLoading) return <Spinner className="m-8" />;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={(e) => setDragging(items?.find((i) => i.id === e.active.id) ?? null)}
      onDragCancel={() => setDragging(null)}
      onDragEnd={onDragEnd}
    >
      <div className="flex h-full min-h-0 gap-3 overflow-x-auto px-6 pb-6">
        {BOARD_STATUSES.map((status) => (
          <Column key={status} status={status} items={columns.get(status) ?? []} projectId={projectId} />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>{dragging && <Card item={dragging} overlay />}</DragOverlay>
    </DndContext>
  );
}

const COLUMN_HINTS: Partial<Record<ItemStatus, string>> = {
  in_progress: 'Drop here to have Claude implement it',
};

function Column({ status, items, projectId }: { status: ItemStatus; items: BacklogItem[]; projectId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}` });
  const ui = useUi();
  return (
    <div
      ref={setNodeRef}
      className={cn('flex w-72 shrink-0 flex-col rounded-xl border border-transparent bg-panel/60 transition-colors', isOver && 'border-accent/50 bg-accent-soft/30')}
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <StatusDot status={status} />
        <span className="text-sm font-medium">{STATUS_LABELS[status]}</span>
        <span className="text-xs text-faint tabular-nums">{items.length}</span>
        {(status === 'backlog' || status === 'planned') && (
          <button className="ml-auto rounded p-1 text-faint hover:bg-hover hover:text-fg" onClick={() => ui.newItem({ projectId, status })} title="Add item">
            <Plus className="size-3.5" />
          </button>
        )}
      </div>
      <div className="min-h-24 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
        {items.map((it) => (
          <DraggableCard key={it.id} item={it} />
        ))}
        {items.length === 0 && COLUMN_HINTS[status] && (
          <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-faint">{COLUMN_HINTS[status]}</div>
        )}
      </div>
    </div>
  );
}

function DraggableCard({ item }: { item: BacklogItem }) {
  const drag = useDraggable({ id: item.id });
  const drop = useDroppable({ id: item.id });
  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      {...drag.attributes}
      {...drag.listeners}
      className={cn('relative', drag.isDragging && 'opacity-30')}
    >
      {drop.isOver && !drag.isDragging && <div className="absolute -top-1.5 right-1 left-1 h-0.5 rounded bg-accent" />}
      <Card item={item} />
    </div>
  );
}

function Card({ item, overlay }: { item: BacklogItem; overlay?: boolean }) {
  const ui = useUi();
  const { data: runs } = useItemRuns(item.status === 'in_progress' || item.status === 'in_review' ? item.id : null);
  const active = runs?.find((r) => r.status === 'running' || r.status === 'queued');
  const running = active?.status === 'running';
  const queued = active?.status === 'queued';
  const snoozed = item.snoozedUntil && new Date(item.snoozedUntil) > new Date();
  return (
    <div
      onClick={() => ui.openItem(item.id)}
      className={cn(
        'cursor-pointer rounded-lg border border-line bg-raised p-3 shadow-sm transition-all hover:border-line-strong',
        overlay && 'rotate-2 shadow-2xl',
        running && 'border-amber-500/40',
        !active && item.pr?.needsRebase && 'border-rose-500/40',
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-faint">
        <TypeIcon type={item.type} className="size-3" />
        <span className="font-mono">{item.key}</span>
        <span className="ml-auto">
          <PriorityIcon priority={item.priority} />
        </span>
      </div>
      <p className="mt-1.5 line-clamp-3 text-[13px] leading-snug text-fg">{item.title}</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {running && (
          <span className="inline-flex items-center gap-1 text-[11px] text-amber-400">
            <Sparkles className="size-3 animate-pulse" /> {active?.kind === 'rebase' ? 'Rebasing' : 'Claude working'}
          </span>
        )}
        {queued && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted" title={active?.waitingReason ?? undefined}>
            <Clock className="size-3" /> Queued
          </span>
        )}
        {!active && item.pr?.needsRebase && (
          <span className="inline-flex items-center gap-1 text-[11px] text-rose-400">
            <TriangleAlert className="size-3" /> Needs rebase
          </span>
        )}
        {item.pr && <PrBadge pr={item.pr} compact />}
        {!item.pr && item.branch && <GitBranch className="size-3 text-faint" />}
        {snoozed && <AlarmClock className="size-3 text-amber-400" />}
        <ScoreBadge score={item.score} />
        <EffortBadge effort={item.effort} />
        {item.tags.slice(0, 2).map((t) => (
          <span key={t} className="text-[11px] text-faint">
            #{t}
          </span>
        ))}
      </div>
    </div>
  );
}

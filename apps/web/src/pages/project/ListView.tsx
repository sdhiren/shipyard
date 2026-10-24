import { EFFORT_POINTS, ITEM_STATUSES, STATUS_LABELS, type BacklogItem, type DecisionInput, type ItemStatus } from '@shipyard/shared';
import { Archive, Check, Play, SkipForward, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useBulkDecide, useItems } from '../../api/hooks';
import { StatusDot } from '../../components/domain';
import { ItemRow } from '../../components/ItemRow';
import { Button, EmptyState, Select, Spinner } from '../../components/ui';
import { cn } from '../../lib/utils';

type Sort = 'manual' | 'priority' | 'score' | 'newest' | 'updated';
const PRIORITY_RANK = { p0: 0, p1: 1, p2: 2, p3: 3 };

const FILTERS: { label: string; statuses: ItemStatus[] }[] = [
  { label: 'Open', statuses: ['backlog', 'planned', 'in_progress', 'in_review'] },
  { label: 'Backlog', statuses: ['backlog'] },
  { label: 'Up next', statuses: ['planned'] },
  { label: 'Active', statuses: ['in_progress', 'in_review'] },
  { label: 'Done', statuses: ['done'] },
  { label: 'Skipped & rejected', statuses: ['skipped', 'rejected'] },
  { label: 'Archived', statuses: ['archived'] },
  { label: 'All', statuses: [...ITEM_STATUSES] },
];

/** Dense, sortable, multi-select list with bulk decisions. */
export function ListView({ projectId, search }: { projectId: string; search: string }) {
  const [filter, setFilter] = useState(0);
  const [sort, setSort] = useState<Sort>('priority');
  const [groupByStatus, setGroupByStatus] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data: items, isLoading } = useItems(projectId, { status: FILTERS[filter]!.statuses, q: search || undefined, includeSnoozed: true });
  const bulk = useBulkDecide();

  const sorted = useMemo(() => {
    const list = [...(items ?? [])];
    const cmp: Record<Sort, (a: BacklogItem, b: BacklogItem) => number> = {
      manual: (a, b) => a.position - b.position,
      priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (b.score ?? 0) - (a.score ?? 0),
      score: (a, b) => (b.score ?? -1) - (a.score ?? -1) || (a.effort ? EFFORT_POINTS[a.effort] : 9) - (b.effort ? EFFORT_POINTS[b.effort] : 9),
      newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
      updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    };
    return list.sort(cmp[sort]);
  }, [items, sort]);

  const groups = useMemo(() => {
    if (!groupByStatus) return [{ status: null as ItemStatus | null, items: sorted }];
    return ITEM_STATUSES.map((s) => ({ status: s as ItemStatus | null, items: sorted.filter((i) => i.status === s) })).filter((g) => g.items.length);
  }, [sorted, groupByStatus]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const apply = (decision: DecisionInput['decision']) => bulk.mutate({ ids: [...selected], decision }, { onSuccess: () => setSelected(new Set()) });

  return (
    <div className="px-6 pb-10">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f, i) => (
            <button
              key={f.label}
              onClick={() => {
                setFilter(i);
                setSelected(new Set());
              }}
              className={cn('h-7 rounded-full border px-3 text-xs transition-colors', filter === i ? 'border-accent bg-accent-soft text-fg' : 'border-line text-muted hover:text-fg')}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={groupByStatus} onChange={(e) => setGroupByStatus(e.target.checked)} /> Group by status
          </label>
          <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-7 w-40 text-xs">
            <option value="priority">Sort: Priority</option>
            <option value="score">Sort: Best bet (impact/effort)</option>
            <option value="newest">Sort: Newest</option>
            <option value="updated">Sort: Recently updated</option>
            <option value="manual">Sort: Manual</option>
          </Select>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="sticky top-0 z-10 mb-3 flex items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-sm shadow-lg">
          <span className="font-medium">{selected.size} selected</span>
          <Button size="xs" icon={<Play className="size-3" />} onClick={() => apply('up_next')}>
            Up next
          </Button>
          <Button size="xs" icon={<SkipForward className="size-3" />} onClick={() => apply('skip')}>
            Skip
          </Button>
          <Button size="xs" icon={<Check className="size-3" />} onClick={() => apply('done')}>
            Done
          </Button>
          <Button size="xs" icon={<Undo2 className="size-3" />} onClick={() => apply('restore')}>
            Restore
          </Button>
          <Button size="xs" variant="danger" icon={<Archive className="size-3" />} onClick={() => apply('archive')}>
            Archive
          </Button>
          <button className="ml-auto text-xs text-muted hover:text-fg" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      {isLoading ? (
        <Spinner />
      ) : sorted.length === 0 ? (
        <EmptyState title="No items match" description="Try another filter, or press C to add one." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          {groups.map((g) => (
            <div key={g.status ?? 'all'}>
              {g.status && (
                <div className="flex items-center gap-2 border-b border-line bg-bg/40 px-4 py-1.5 text-xs font-medium text-muted">
                  <StatusDot status={g.status} />
                  {STATUS_LABELS[g.status]}
                  <span className="text-faint">{g.items.length}</span>
                </div>
              )}
              <div className="divide-y divide-line/60 border-b border-line last:border-b-0">
                {g.items.map((it) => (
                  <ItemRow
                    key={it.id}
                    item={it}
                    selected={selected.has(it.id)}
                    leading={
                      <input
                        type="checkbox"
                        className={cn('shrink-0 opacity-0 group-hover:opacity-100', selected.size > 0 && 'opacity-100', selected.has(it.id) && 'opacity-100')}
                        checked={selected.has(it.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggle(it.id)}
                      />
                    }
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

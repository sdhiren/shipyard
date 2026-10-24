import type { BacklogItem } from '@shipyard/shared';
import { useQueries } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../api/client';
import { useProjects } from '../api/hooks';
import { ProjectDot } from '../components/domain';
import { InboxList } from '../components/InboxList';
import { Spinner } from '../components/ui';
import { cn } from '../lib/utils';

/** Every project's Inbox in one triage queue. */
export function InboxPage() {
  const { data: projects } = useProjects();
  const [only, setOnly] = useState<string | null>(null);
  const results = useQueries({
    queries: (projects ?? []).map((p) => ({ queryKey: ['items', p.id, { status: ['proposed'] }], queryFn: () => api.items(p.id, { status: ['proposed'] }) })),
  });
  const byId = useMemo(() => new Map(projects?.map((p) => [p.id, p])), [projects]);
  const items = useMemo(
    () =>
      results
        .flatMap((r) => r.data ?? [])
        .filter((i) => !only || i.projectId === only)
        .sort((a, b) => a.priority.localeCompare(b.priority) || (b.score ?? 0) - (a.score ?? 0)),
    [results, only],
  );
  const loading = !projects || results.some((r) => r.isLoading);

  const label = (it: BacklogItem) => {
    const p = byId.get(it.projectId);
    return p ? (
      <span className="flex items-center gap-1.5 text-muted">
        <ProjectDot color={p.color} className="size-2" />
        {p.name}
      </span>
    ) : null;
  };

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
      <p className="mt-1 text-sm text-muted">Suggestions from Claude and imported items. Approve what's worth doing, reject the rest.</p>
      <div className="mt-5 mb-4 flex flex-wrap gap-1.5">
        <button onClick={() => setOnly(null)} className={cn('h-7 rounded-full border px-3 text-xs', !only ? 'border-accent bg-accent-soft' : 'border-line text-muted')}>
          All projects
        </button>
        {projects
          ?.filter((p) => p.stats.inbox > 0)
          .map((p) => (
            <button
              key={p.id}
              onClick={() => setOnly(p.id)}
              className={cn('flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs', only === p.id ? 'border-accent bg-accent-soft' : 'border-line text-muted')}
            >
              <ProjectDot color={p.color} className="size-2" />
              {p.name} <span className="text-faint">{p.stats.inbox}</span>
            </button>
          ))}
      </div>
      {loading ? <Spinner /> : <InboxList items={items} projectLabel={label} />}
    </div>
  );
}

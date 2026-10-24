import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useProjects, useRuns } from '../api/hooks';
import { ProjectDot, RunStatusIcon } from '../components/domain';
import { RunLog } from '../components/RunLog';
import { EmptyState, Spinner } from '../components/ui';
import { cn, formatCost, formatDuration, timeAgo } from '../lib/utils';

/** Every Claude run across projects, with a live log for the selected one. */
export function RunsPage() {
  const { data: runs, isLoading } = useRuns({ limit: 100 });
  const { data: projects } = useProjects();
  const [params, setParams] = useSearchParams();
  const selected = params.get('run') ?? runs?.[0]?.id ?? null;
  const byId = useMemo(() => new Map(projects?.map((p) => [p.id, p])), [projects]);
  const total = runs?.reduce((s, r) => s + (r.costUsd ?? 0), 0) ?? 0;

  if (isLoading) return <Spinner className="m-8" />;
  if (!runs?.length) return <EmptyState title="No Claude runs yet" description="Analyses, plans and implementations show up here with their full logs." />;

  return (
    <div className="flex h-full">
      <div className="flex w-96 shrink-0 flex-col border-r border-line">
        <div className="border-b border-line px-5 py-4">
          <h1 className="text-lg font-semibold tracking-tight">Claude runs</h1>
          <p className="text-xs text-faint">
            Last {runs.length} runs · {formatCost(total)} total
          </p>
        </div>
        <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
          {runs.map((r) => {
            const p = byId.get(r.projectId);
            return (
              <li key={r.id}>
                <button
                  onClick={() => setParams({ run: r.id })}
                  className={cn('flex w-full flex-col gap-1 px-5 py-3 text-left hover:bg-hover/60', selected === r.id && 'bg-hover')}
                >
                  <div className="flex items-center gap-2 text-sm">
                    <RunStatusIcon status={r.status} />
                    <span className="font-medium capitalize">{r.kind}</span>
                    {p && (
                      <span className="flex items-center gap-1.5 text-xs text-muted">
                        <ProjectDot color={p.color} className="size-2" /> {p.name}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-faint">{timeAgo(r.createdAt)}</span>
                  </div>
                  <div className="flex items-center gap-3 pl-5 text-xs text-faint">
                    <span>{r.model}</span>
                    <span>{formatDuration(r.durationMs)}</span>
                    <span>{formatCost(r.costUsd)}</span>
                  </div>
                  {(r.summary || r.error) && <div className={cn('line-clamp-1 pl-5 text-xs', r.error ? 'text-rose-400' : 'text-muted')}>{r.error ?? r.summary}</div>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="min-w-0 flex-1 p-5">{selected && <RunLog key={selected} runId={selected} className="h-full" />}</div>
    </div>
  );
}

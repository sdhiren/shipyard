import { CircleCheck, DollarSign, FolderPlus, GitPullRequest, Inbox, ListChecks, Sparkles, Terminal } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useDashboard, useProjects } from '../api/hooks';
import { Md, ProjectDot, RunStatusIcon } from '../components/domain';
import { ItemRow } from '../components/ItemRow';
import { useUi } from '../components/Layout';
import { Button, Card, EmptyState, Spinner, Stat } from '../components/ui';
import { formatCost, timeAgo } from '../lib/utils';

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function DashboardPage() {
  const { data, isLoading } = useDashboard();
  const { data: projects } = useProjects();
  const ui = useUi();

  if (isLoading || !data) return <Spinner className="m-8" />;
  if (data.totals.projects === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<FolderPlus className="size-5" />}
          title="Welcome to Shipyard"
          description="Add the repositories you're working on. Shipyard maps their backlog, asks Claude for ideas, and ships approved work as pull requests."
          action={
            <Button variant="primary" onClick={ui.addProject}>
              Add your first project
            </Button>
          }
        />
      </div>
    );
  }

  const max = Math.max(1, ...data.throughput.map((w) => Math.max(w.created, w.completed)));

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{greeting()}</h1>
        <p className="mt-1 text-sm text-muted">
          {data.totals.inbox > 0 ? `${data.totals.inbox} suggestion${data.totals.inbox === 1 ? '' : 's'} waiting for triage · ` : ''}
          {data.totals.inReview} in review · {data.totals.doneThisWeek} shipped this week
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Link to="/inbox">
          <Stat label="Inbox" value={data.totals.inbox} sub="awaiting a decision" icon={<Inbox className="size-4" />} />
        </Link>
        <Stat label="Open" value={data.totals.open} sub={`${data.totals.inProgress} in progress`} icon={<ListChecks className="size-4" />} />
        <Stat label="In review" value={data.totals.inReview} sub={`${data.openPrs.length} open PRs`} icon={<GitPullRequest className="size-4" />} />
        <Stat label="Shipped (7d)" value={data.totals.doneThisWeek} icon={<CircleCheck className="size-4" />} />
        <Stat label="Claude spend" value={formatCost(data.totals.spendThisMonthUsd)} sub="this month" icon={<DollarSign className="size-4" />} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {data.activeRuns.length > 0 && (
            <Card>
              <CardHeader icon={<Sparkles className="size-4 text-amber-400" />} title="Claude is working" />
              <ul className="divide-y divide-line">
                {data.activeRuns.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <RunStatusIcon status={r.status} />
                    <span className="text-xs text-faint capitalize">{r.kind}</span>
                    {r.itemId ? (
                      <button className="min-w-0 flex-1 truncate text-left text-fg hover:underline" onClick={() => ui.openItem(r.itemId!)}>
                        <span className="mr-2 font-mono text-xs text-faint">{r.itemKey}</span>
                        {r.itemTitle}
                      </button>
                    ) : (
                      <Link to={`/projects/${r.projectId}?tab=insights`} className="flex-1 text-fg hover:underline">
                        Analysing {r.projectName}
                      </Link>
                    )}
                    <span className="text-xs text-faint">{timeAgo(r.startedAt ?? r.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <CardHeader icon={<GitPullRequest className="size-4 text-emerald-400" />} title="Open pull requests" />
            {data.openPrs.length ? (
              <div className="divide-y divide-line">
                {data.openPrs.map((i) => (
                  <ItemRow key={i.id} item={i} meta={<span className="text-xs text-faint">{i.projectName}</span>} />
                ))}
              </div>
            ) : (
              <p className="px-4 py-6 text-sm text-faint">No open PRs. Pick something from Up next and let Claude build it.</p>
            )}
          </Card>

          <Card>
            <CardHeader icon={<ListChecks className="size-4 text-sky-400" />} title="Up next" />
            {data.upNext.length ? (
              <div className="divide-y divide-line">
                {data.upNext.map((i) => (
                  <ItemRow key={i.id} item={i} meta={<span className="text-xs text-faint">{i.projectName}</span>} />
                ))}
              </div>
            ) : (
              <p className="px-4 py-6 text-sm text-faint">Nothing queued. Mark backlog items as “Up next” to line them up here.</p>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between text-sm font-medium">
              Throughput
              <span className="flex items-center gap-3 text-xs font-normal text-faint">
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-sm bg-line-strong" /> created
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-sm bg-accent" /> shipped
                </span>
              </span>
            </div>
            <div className="flex h-28 items-end gap-2">
              {data.throughput.map((w) => (
                <div key={w.week} className="flex flex-1 flex-col items-center gap-1" title={`Week of ${w.week}: ${w.created} created, ${w.completed} shipped`}>
                  <div className="flex h-24 w-full items-end justify-center gap-0.5">
                    <div className="w-1/2 rounded-t-sm bg-line-strong" style={{ height: `${(w.created / max) * 100}%` }} />
                    <div className="w-1/2 rounded-t-sm bg-accent" style={{ height: `${(w.completed / max) * 100}%` }} />
                  </div>
                  <span className="text-[10px] text-faint">{w.week.slice(5)}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Projects" />
            <ul className="divide-y divide-line">
              {projects?.map((p) => (
                <li key={p.id}>
                  <Link to={`/projects/${p.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-hover/60">
                    <ProjectDot color={p.color} />
                    <span className="flex-1 truncate">{p.name}</span>
                    {p.stats.inbox > 0 && <span className="rounded bg-violet-500/15 px-1.5 text-[11px] text-violet-400">{p.stats.inbox} new</span>}
                    <span className="text-xs text-faint tabular-nums">
                      {p.stats.open} open · {p.stats.done} done
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader icon={<Terminal className="size-4 text-faint" />} title="Recent activity" />
            <ul className="space-y-3 px-4 py-3">
              {data.recentActivity.slice(0, 14).map((a) => (
                <li key={a.id} className="text-xs">
                  <div className="flex items-center gap-1.5 text-faint">
                    <span>{a.projectName}</span>
                    {a.itemKey && (
                      <button className="font-mono hover:text-fg" onClick={() => a.itemId && ui.openItem(a.itemId)}>
                        {a.itemKey}
                      </button>
                    )}
                    <span className="ml-auto">{timeAgo(a.createdAt)}</span>
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-muted">{a.kind === 'note' ? <Md className="prose-p:my-0">{a.message}</Md> : a.message}</div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function CardHeader({ title, icon }: { title: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-medium">
      {icon}
      {title}
    </div>
  );
}

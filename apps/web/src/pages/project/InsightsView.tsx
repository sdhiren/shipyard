import { FOCUS_LABELS, type HealthScores, type Project } from '@shipyard/shared';
import { CircleAlert, CircleCheck, GitBranch, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useAnalyses, useProjectActivity } from '../../api/hooks';
import { Md, RunStatusIcon } from '../../components/domain';
import { RunLog } from '../../components/RunLog';
import { Badge, Button, Card, EmptyState } from '../../components/ui';
import { cn, formatCost, timeAgo } from '../../lib/utils';

const HEALTH_LABELS: Record<keyof HealthScores, string> = {
  architecture: 'Architecture',
  testing: 'Testing',
  security: 'Security',
  performance: 'Performance',
  documentation: 'Documentation',
  developerExperience: 'Dev experience',
};

function scoreColor(n: number): string {
  if (n >= 8) return 'bg-emerald-400';
  if (n >= 6) return 'bg-sky-400';
  if (n >= 4) return 'bg-amber-400';
  return 'bg-rose-400';
}

/** Project overview: stack, git state, Claude's health assessment and analysis history. */
export function InsightsView({ project, onAnalyze }: { project: Project; onAnalyze: () => void }) {
  const { data: analyses } = useAnalyses(project.id);
  const { data: activity } = useProjectActivity(project.id);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const latest = analyses?.find((a) => a.status === 'succeeded');
  const running = analyses?.find((a) => a.status === 'running' || a.status === 'queued');

  return (
    <div className="grid gap-6 px-6 pb-10 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        {running?.runId && (
          <Card className="overflow-hidden">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-medium">
              <Sparkles className="size-4 animate-pulse text-amber-400" /> Claude is analysing {project.name}
            </div>
            <RunLog runId={running.runId} className="h-96 rounded-none border-0" compact />
          </Card>
        )}

        {latest ? (
          <Card>
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="text-sm font-medium">Latest assessment</div>
              <span className="text-xs text-faint">
                {timeAgo(latest.finishedAt)} · {latest.focus.map((f) => FOCUS_LABELS[f]).join(', ')}
              </span>
            </div>
            <div className="space-y-5 p-4">
              {latest.summary && <Md>{latest.summary}</Md>}
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <h4 className="mb-2 text-xs font-semibold tracking-wide text-faint uppercase">Strengths</h4>
                  <ul className="space-y-1.5">
                    {latest.strengths.map((s, i) => (
                      <li key={i} className="flex gap-2 text-sm text-muted">
                        <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4 className="mb-2 text-xs font-semibold tracking-wide text-faint uppercase">Risks</h4>
                  <ul className="space-y-1.5">
                    {latest.risks.map((s, i) => (
                      <li key={i} className="flex gap-2 text-sm text-muted">
                        <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </Card>
        ) : (
          !running && (
            <Card>
              <EmptyState
                icon={<Sparkles className="size-5" />}
                title="No assessment yet"
                description="Ask Claude to read this codebase. You'll get a health check plus concrete suggestions for your Inbox."
                action={
                  <Button variant="primary" icon={<Sparkles className="size-3.5" />} onClick={onAnalyze}>
                    Explore improvements
                  </Button>
                }
              />
            </Card>
          )
        )}

        <Card>
          <div className="border-b border-line px-4 py-3 text-sm font-medium">Analysis history</div>
          {analyses?.length ? (
            <ul className="divide-y divide-line">
              {analyses.map((a) => (
                <li key={a.id}>
                  <button className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-hover/60" onClick={() => setOpenRun(openRun === a.runId ? null : a.runId)}>
                    <RunStatusIcon status={a.status} />
                    <span className="flex-1 truncate text-muted">{a.focus.map((f) => FOCUS_LABELS[f]).join(' · ')}</span>
                    {a.status === 'succeeded' && <Badge>{a.suggestionCount} suggestions</Badge>}
                    <span className="text-xs text-faint">{formatCost(a.costUsd)}</span>
                    <span className="w-20 text-right text-xs text-faint">{timeAgo(a.createdAt)}</span>
                  </button>
                  {openRun && openRun === a.runId && <RunLog runId={openRun} className="mx-4 mb-4 h-80" compact />}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-sm text-faint">No analyses yet.</p>
          )}
        </Card>
      </div>

      <div className="space-y-6">
        <Card className="p-4">
          <h4 className="mb-3 text-sm font-medium">Health</h4>
          {project.health ? (
            <div className="space-y-2.5">
              {(Object.keys(HEALTH_LABELS) as (keyof HealthScores)[]).map((k) => (
                <div key={k}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="text-muted">{HEALTH_LABELS[k]}</span>
                    <span className="text-faint tabular-nums">{project.health![k]}/10</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-hover">
                    <div className={cn('h-full rounded-full', scoreColor(project.health![k]))} style={{ width: `${project.health![k] * 10}%` }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-faint">Run an analysis to score this project.</p>
          )}
        </Card>

        <Card className="p-4">
          <h4 className="mb-3 text-sm font-medium">Stack</h4>
          <div className="flex flex-wrap gap-1.5">
            {[...project.stack.languages, ...project.stack.frameworks].map((s) => (
              <Badge key={s}>{s}</Badge>
            ))}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-y-1.5 text-xs">
            <dt className="text-faint">Tests</dt>
            <dd className="text-muted">{project.stack.hasTests ? 'Yes' : 'None found'}</dd>
            <dt className="text-faint">CI</dt>
            <dd className="text-muted">{project.stack.hasCi ? 'GitHub Actions' : 'None'}</dd>
            <dt className="text-faint">Docker</dt>
            <dd className="text-muted">{project.stack.hasDocker ? 'Yes' : 'No'}</dd>
            <dt className="text-faint">Check command</dt>
            <dd className="font-mono text-muted">{project.settings.testCommand || '—'}</dd>
          </dl>
          {project.stack.keyFiles.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {project.stack.keyFiles.map((f) => (
                <code key={f} className="rounded bg-hover px-1.5 py-0.5 font-mono text-[11px] text-faint">
                  {f}
                </code>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h4 className="mb-3 flex items-center gap-2 text-sm font-medium">
            <GitBranch className="size-4 text-faint" /> Repository
          </h4>
          <dl className="grid grid-cols-[90px_1fr] gap-y-1.5 text-xs">
            <dt className="text-faint">Remote</dt>
            <dd className="truncate text-muted">
              {project.git.githubRepo ? (
                <a className="text-accent" href={`https://github.com/${project.git.githubRepo}`} target="_blank" rel="noreferrer">
                  {project.git.githubRepo}
                </a>
              ) : (
                (project.git.remoteUrl ?? 'none')
              )}
            </dd>
            <dt className="text-faint">Default</dt>
            <dd className="font-mono text-muted">{project.git.defaultBranch}</dd>
            <dt className="text-faint">Checked out</dt>
            <dd className="font-mono text-muted">
              {project.git.currentBranch} {project.git.dirty && <span className="text-amber-400">(uncommitted changes)</span>}
            </dd>
            <dt className="text-faint">Commits</dt>
            <dd className="text-muted">{project.git.commitCount}</dd>
            <dt className="text-faint">Last commit</dt>
            <dd className="text-muted">
              {timeAgo(project.git.lastCommitAt)}
              <div className="truncate text-faint">{project.git.lastCommitMessage}</div>
            </dd>
          </dl>
        </Card>

        <Card className="p-4">
          <h4 className="mb-3 text-sm font-medium">Recent activity</h4>
          <ul className="space-y-2.5">
            {activity?.slice(0, 12).map((a) => (
              <li key={a.id} className="text-xs">
                <span className="text-faint">{timeAgo(a.createdAt)}</span>
                {a.itemKey && <span className="ml-1.5 font-mono text-faint">{a.itemKey}</span>}
                <div className="line-clamp-2 text-muted">{a.message}</div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

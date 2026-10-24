import type { GlobalSettings } from '@shipyard/shared';
import type { Project } from '@shipyard/shared';
import { useQuery } from '@tanstack/react-query';
import { ArchiveRestore, CircleCheck, CircleX, RefreshCw, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAction, useHealth, useSettings } from '../api/hooks';
import { RemoveProjectDialog, useRestoreProject } from '../components/dialogs/ProjectLifecycle';
import { ProjectDot } from '../components/domain';
import { Button, Card, Field, Input, Select, Spinner, Textarea } from '../components/ui';
import { timeAgo } from '../lib/utils';

function Check({ ok, label, fix }: { ok: boolean; label: string; fix: string }) {
  return (
    <div className="flex items-start gap-3 py-2">
      {ok ? <CircleCheck className="mt-0.5 size-4 text-emerald-400" /> : <CircleX className="mt-0.5 size-4 text-rose-400" />}
      <div>
        <div className="text-sm">{label}</div>
        {!ok && <code className="text-xs text-muted">{fix}</code>}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { data: health, refetch } = useHealth();
  const { data: settings } = useSettings();
  const [s, setS] = useState<GlobalSettings | null>(null);
  useEffect(() => setS(settings ?? null), [settings]);
  const save = useAction(() => api.updateSettings(s!), { success: 'Settings saved', invalidate: [['settings']] });
  const sync = useAction(() => api.syncAllPrs(), { success: 'Pull requests synced', invalidate: [['items'], ['dashboard']] });

  if (!s) return <Spinner className="m-8" />;
  const d = s.defaultProjectSettings;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Card className="p-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Environment</h3>
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => void refetch()}>
            Recheck
          </Button>
        </div>
        {health && (
          <div className="divide-y divide-line">
            <Check ok={health.claude} label="Claude Code CLI available" fix="npm install -g @anthropic-ai/claude-code && claude" />
            <Check ok={health.gh.installed} label="GitHub CLI installed" fix="brew install gh" />
            <Check ok={health.gh.authenticated} label="GitHub CLI signed in" fix="gh auth login" />
            <div className="py-2 text-xs text-faint">
              Data folder: <code>{health.dataDir}</code>
            </div>
          </div>
        )}
      </Card>

      <Card className="space-y-4 p-5">
        <h3 className="text-sm font-semibold">Runs & syncing</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Concurrent Claude runs">
            <Input type="number" min={1} max={8} value={s.maxConcurrentRuns} onChange={(e) => setS({ ...s, maxConcurrentRuns: Number(e.target.value) })} />
          </Field>
          <Field label="PR poll interval (seconds)">
            <Input type="number" min={30} value={s.prPollIntervalSec} onChange={(e) => setS({ ...s, prPollIntervalSec: Number(e.target.value) })} />
          </Field>
        </div>
        <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={sync.isPending} onClick={() => sync.mutate(undefined)}>
          Sync all open PRs now
        </Button>
      </Card>

      <Card className="space-y-4 p-5">
        <h3 className="text-sm font-semibold">Defaults for new projects</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Model">
            <Input
              value={d.model ?? 'opus'}
              className="font-mono text-xs"
              onChange={(e) => setS({ ...s, defaultProjectSettings: { ...d, model: e.target.value } })}
            />
          </Field>
          <Field label="Effort">
            <Select value={d.effort ?? 'high'} onChange={(e) => setS({ ...s, defaultProjectSettings: { ...d, effort: e.target.value as 'high' } })}>
              {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Discovery folders" hint="Scanned (two levels deep) for git repositories in “Add project”. One per line.">
          <Textarea
            className="font-mono text-xs"
            value={s.discoveryRoots.join('\n')}
            onChange={(e) =>
              setS({
                ...s,
                discoveryRoots: e.target.value
                  .split('\n')
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
      </Card>

      <div className="flex justify-end">
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
          Save settings
        </Button>
      </div>

      <ArchivedProjects />
    </div>
  );
}

function ArchivedProjects() {
  const { data } = useQuery({ queryKey: ['projects', 'archived'], queryFn: () => api.projects(true) });
  const restore = useRestoreProject();
  const [removing, setRemoving] = useState<Project | null>(null);
  const archived = data?.filter((p) => p.archived) ?? [];

  return (
    <Card>
      <div className="border-b border-line px-5 py-3">
        <h3 className="text-sm font-semibold">Archived projects</h3>
        <p className="text-xs text-muted">Hidden from the sidebar and dashboard. Their backlog and history are kept.</p>
      </div>
      {archived.length === 0 ? (
        <p className="px-5 py-4 text-sm text-faint">No archived projects.</p>
      ) : (
        <ul className="divide-y divide-line">
          {archived.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-5 py-3">
              <ProjectDot color={p.color} />
              <div className="min-w-0 flex-1">
                <Link to={`/projects/${p.id}`} className="text-sm text-fg hover:underline">
                  {p.name}
                </Link>
                <div className="truncate font-mono text-[11px] text-faint">{p.path}</div>
              </div>
              <span className="text-xs text-faint">archived {timeAgo(p.updatedAt)}</span>
              <Button size="sm" icon={<ArchiveRestore className="size-3.5" />} onClick={() => void restore(p)}>
                Restore
              </Button>
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setRemoving(p)} aria-label={`Remove ${p.name}`} />
            </li>
          ))}
        </ul>
      )}
      {removing && <RemoveProjectDialog project={removing} open stayOnPage onClose={() => setRemoving(null)} />}
    </Card>
  );
}

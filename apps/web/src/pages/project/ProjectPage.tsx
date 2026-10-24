import { Archive, ArchiveRestore, Ellipsis, FolderX, Trash2, ExternalLink, Gauge, Import, Inbox, Kanban, List, Pin, Plus, RefreshCw, Search, Settings, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAction, useAnalyses, useItems, useProject, useProjects } from '../../api/hooks';
import { ProjectDot } from '../../components/domain';
import { AnalyzeDialog } from '../../components/dialogs/AnalyzeDialog';
import { ImportDialog } from '../../components/dialogs/ImportDialog';
import { RemoveProjectDialog, useArchiveProject, useRestoreProject } from '../../components/dialogs/ProjectLifecycle';
import { InboxList } from '../../components/InboxList';
import { useUi } from '../../lib/ui-context';
import { Badge, Button, EmptyState, Input, Menu, Spinner, Tabs } from '../../components/ui';
import { BoardView } from './BoardView';
import { InsightsView } from './InsightsView';
import { ListView } from './ListView';
import { ProjectSettings } from './ProjectSettings';

type Tab = 'board' | 'list' | 'inbox' | 'insights' | 'settings';

export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'board';
  const setTab = (t: Tab) =>
    setParams((p) => {
      p.set('tab', t);
      return p;
    });
  const { data: project, isLoading, error } = useProject(projectId);
  const { data: projects } = useProjects();
  const { data: inbox } = useItems(projectId, { status: ['proposed'] });
  const { data: analyses } = useAnalyses(projectId);
  const [search, setSearch] = useState('');
  const [analyze, setAnalyze] = useState(false);
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const archive = useArchiveProject();
  const restore = useRestoreProject();
  const ui = useUi();
  const stats = projects?.find((p) => p.id === projectId)?.stats;
  const analysing = analyses?.some((a) => a.status === 'running' || a.status === 'queued');

  const rescan = useAction(() => api.rescanProject(projectId!), { success: 'Rescanned repository', invalidate: [['project', projectId], ['projects']] });
  const pin = useAction(() => api.updateProject(projectId!, { pinned: !project?.pinned }), { invalidate: [['project', projectId], ['projects']] });

  if (error && !project) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<FolderX className="size-5" />}
          title="Project not found"
          description="It may have been removed from Shipyard. Your repository on disk is unaffected."
          action={
            <Link to="/">
              <Button variant="primary">Go to dashboard</Button>
            </Link>
          }
        />
      </div>
    );
  }
  if (isLoading || !project) return <Spinner className="m-8" />;

  return (
    <div className="flex h-full flex-col">
      {project.archived && (
        <div className="flex items-center gap-3 border-b border-amber-500/20 bg-amber-500/5 px-6 py-2 text-sm text-amber-400">
          <Archive className="size-4" />
          This project is archived. It's hidden from the sidebar and dashboard.
          <Button size="xs" className="ml-auto" icon={<ArchiveRestore className="size-3" />} onClick={() => void restore(project)}>
            Restore
          </Button>
        </div>
      )}
      <header className="px-6 pt-6">
        <div className="flex items-start gap-3">
          <ProjectDot color={project.color} className="mt-2 size-3.5" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight">{project.name}</h1>
              {project.git.githubRepo && (
                <a href={`https://github.com/${project.git.githubRepo}`} target="_blank" rel="noreferrer" className="text-faint hover:text-fg" title={project.git.githubRepo}>
                  <ExternalLink className="size-4" />
                </a>
              )}
            </div>
            {project.description && <p className="mt-0.5 line-clamp-1 max-w-3xl text-sm text-muted">{project.description}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[...project.stack.languages, ...project.stack.frameworks.slice(0, 5)].map((s) => (
                <Badge key={s}>{s}</Badge>
              ))}
              {stats && (
                <span className="ml-2 text-xs leading-5 text-faint">
                  {stats.open} open · {stats.inReview} in review · {stats.done} done
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button icon={<Import className="size-3.5" />} onClick={() => setImporting(true)}>
              Import
            </Button>
            <Button icon={<Plus className="size-3.5" />} onClick={() => ui.newItem({ projectId: project.id })}>
              New item
            </Button>
            <Button variant="primary" icon={<Sparkles className={analysing ? 'size-3.5 animate-pulse' : 'size-3.5'} />} onClick={() => setAnalyze(true)} disabled={analysing}>
              {analysing ? 'Analysing…' : 'Explore with Claude'}
            </Button>
            <Menu
              trigger={<Button variant="ghost" icon={<Ellipsis className="size-4" />} aria-label="More" />}
              items={[
                { label: 'Rescan repository', icon: <RefreshCw className="size-3.5" />, onSelect: () => rescan.mutate(undefined) },
                { label: project.pinned ? 'Unpin' : 'Pin to top', icon: <Pin className="size-3.5" />, onSelect: () => pin.mutate(undefined) },
                { label: 'Project settings', icon: <Settings className="size-3.5" />, onSelect: () => setTab('settings') },
                'separator',
                project.archived
                  ? { label: 'Restore project', icon: <ArchiveRestore className="size-3.5" />, onSelect: () => void restore(project) }
                  : { label: 'Archive project', icon: <Archive className="size-3.5" />, onSelect: () => void archive(project) },
                { label: 'Remove from Shipyard…', icon: <Trash2 className="size-3.5" />, onSelect: () => setRemoving(true), danger: true },
              ]}
            />
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between gap-4 border-b border-line pb-2">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'board', label: 'Board', icon: <Kanban className="size-3.5" /> },
              { value: 'list', label: 'List', icon: <List className="size-3.5" /> },
              { value: 'inbox', label: 'Inbox', icon: <Inbox className="size-3.5" />, count: inbox?.length },
              { value: 'insights', label: 'Insights', icon: <Gauge className="size-3.5" /> },
              { value: 'settings', label: 'Settings', icon: <Settings className="size-3.5" /> },
            ]}
          />
          {(tab === 'board' || tab === 'list') && (
            <div className="relative w-64">
              <Search className="absolute top-2 left-2.5 size-4 text-faint" />
              <Input placeholder="Filter items…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 pl-8" />
            </div>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pt-4">
        {tab === 'board' && <BoardView projectId={project.id} search={search} />}
        {tab === 'list' && <ListView projectId={project.id} search={search} />}
        {tab === 'inbox' && (
          <div className="mx-auto max-w-4xl px-6 pb-10">
            <InboxList
              items={inbox ?? []}
              header={
                <Button size="sm" variant="ghost" icon={<Sparkles className="size-3.5" />} onClick={() => setAnalyze(true)}>
                  Ask Claude for more ideas
                </Button>
              }
            />
          </div>
        )}
        {tab === 'insights' && <InsightsView project={project} onAnalyze={() => setAnalyze(true)} />}
        {tab === 'settings' && <ProjectSettings project={project} />}
      </div>

      <AnalyzeDialog open={analyze} onClose={() => setAnalyze(false)} project={project} />
      <ImportDialog open={importing} onClose={() => setImporting(false)} projectId={project.id} />
      <RemoveProjectDialog project={project} open={removing} onClose={() => setRemoving(false)} />
    </div>
  );
}

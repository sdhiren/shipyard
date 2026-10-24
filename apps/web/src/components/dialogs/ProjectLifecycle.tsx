import type { Project } from '@shipyard/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Check, CircleAlert, FolderGit2, Trash2 } from 'lucide-react';
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { useProjects } from '../../api/hooks';
import { Button, ConfirmDialog } from '../ui';

function useInvalidateProject() {
  const qc = useQueryClient();
  return useCallback(
    (id: string) => {
      for (const key of [['projects'], ['project', id], ['dashboard'], ['items', id]]) void qc.invalidateQueries({ queryKey: key });
    },
    [qc],
  );
}

/** Archive hides a project everywhere but keeps all its data; the toast offers an immediate undo. */
export function useArchiveProject() {
  const navigate = useNavigate();
  const invalidate = useInvalidateProject();
  return useCallback(
    async (project: Pick<Project, 'id' | 'name'>) => {
      try {
        await api.updateProject(project.id, { archived: true });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not archive the project');
        return;
      }
      invalidate(project.id);
      navigate('/');
      toast.success(`Archived ${project.name}`, {
        description: 'Hidden from the sidebar and dashboard. Restore it any time from Settings.',
        action: {
          label: 'Undo',
          onClick: () => {
            void api.updateProject(project.id, { archived: false }).then(() => {
              invalidate(project.id);
              navigate(`/projects/${project.id}`);
            });
          },
        },
      });
    },
    [invalidate, navigate],
  );
}

export function useRestoreProject() {
  const invalidate = useInvalidateProject();
  return useCallback(
    async (project: Pick<Project, 'id' | 'name'>) => {
      try {
        await api.updateProject(project.id, { archived: false });
        invalidate(project.id);
        toast.success(`Restored ${project.name}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not restore the project');
      }
    },
    [invalidate],
  );
}

/**
 * Removing a project deletes Shipyard's records for it. The dialog spells out
 * what goes and what stays, offers Archive as the reversible alternative, and
 * asks for the project name before it deletes anything.
 */
export function RemoveProjectDialog({
  project,
  open,
  onClose,
  stayOnPage,
}: {
  project: Project;
  open: boolean;
  onClose: () => void;
  /** Don't navigate home afterwards (e.g. when removing from the Settings list). */
  stayOnPage?: boolean;
}) {
  const { data: projects } = useProjects();
  const stats = projects?.find((p) => p.id === project.id)?.stats;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const archive = useArchiveProject();

  const itemSummary = stats
    ? [
        stats.open && `${stats.open} open`,
        stats.done && `${stats.done} done`,
        stats.inbox && `${stats.inbox} in the Inbox`,
      ]
        .filter(Boolean)
        .join(', ')
    : '';

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      tone="danger"
      title={`Remove ${project.name} from Shipyard?`}
      confirmLabel="Remove project"
      requireText={project.name}
      width="max-w-xl"
      secondaryAction={
        !project.archived && (
          <Button
            variant="ghost"
            icon={<Archive className="size-3.5" />}
            onClick={() => {
              onClose();
              void archive(project);
            }}
          >
            Archive instead
          </Button>
        )
      }
      onConfirm={async () => {
        await api.deleteProject(project.id);
        qc.removeQueries({ queryKey: ['project', project.id] });
        void qc.invalidateQueries({ queryKey: ['projects'] });
        void qc.invalidateQueries({ queryKey: ['dashboard'] });
        if (!stayOnPage) navigate('/');
        toast.success(`Removed ${project.name} from Shipyard`, { description: 'Your repository was not changed.' });
      }}
    >
      {stats && stats.activeRuns > 0 && (
        <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-400">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          Claude is working on this project right now. Stop its {stats.activeRuns === 1 ? 'run' : `${stats.activeRuns} runs`} before removing it.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.03] p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-red-400">
            <Trash2 className="size-3.5" /> Deleted from Shipyard
          </div>
          <ul className="space-y-1.5 text-xs leading-relaxed">
            <li>All backlog items{itemSummary ? ` (${itemSummary})` : ''}, with their notes and timelines</li>
            <li>Analyses, health scores and Claude run logs</li>
            <li>Shipyard's worktrees for this project</li>
          </ul>
        </div>
        <div className="rounded-xl border border-line bg-bg/60 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
            <Check className="size-3.5" /> Not touched
          </div>
          <ul className="space-y-1.5 text-xs leading-relaxed">
            <li>Your repository and its files</li>
            <li>Its branches and commits, including Shipyard's branches</li>
            <li>Pull requests on GitHub</li>
          </ul>
        </div>
      </div>

      <div className="flex items-center gap-2 rounded-lg bg-bg/60 px-3 py-2 text-xs">
        <FolderGit2 className="size-3.5 shrink-0 text-faint" />
        <code className="truncate font-mono text-fg" title={project.path}>
          {project.path}
        </code>
      </div>

      <p className="text-xs">This can't be undone. To hide the project but keep its history, archive it instead.</p>
    </ConfirmDialog>
  );
}

import type { Project } from '@shipyard/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderGit2, FolderSearch, GitBranch, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../../api/client';
import { showError } from '../../api/hooks';
import { cn, timeAgo } from '../../lib/utils';
import { Badge, Button, Dialog, Field, Input, Spinner } from '../ui';

/**
 * Point a project at the folder it was moved to. Shipyard searches the home
 * folder for repos with the project's git remote and suggests them, most
 * recently active first; any path can also be entered by hand.
 */
export function RelocateProjectDialog({ project, open, onClose }: { project: Project; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [manual, setManual] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ path: string; message: string } | null>(null);
  const candidates = useQuery({
    queryKey: ['relocation-candidates', project.id],
    queryFn: () => api.relocationCandidates(project.id),
    enabled: open,
    staleTime: 0,
  });

  useEffect(() => {
    if (!open) {
      setManual('');
      setConfirm(null);
    }
  }, [open]);

  const use = async (path: string, force = false) => {
    setPending(path);
    try {
      const updated = await api.relocateProject(project.id, { path, force });
      for (const key of [['project', project.id], ['projects'], ['dashboard'], ['items', project.id]]) void qc.invalidateQueries({ queryKey: key });
      toast.success(`${project.name} now points to its new folder`, { description: updated.path });
      onClose();
    } catch (err) {
      // A different git remote needs an explicit "use it anyway".
      if (err instanceof ApiError && err.status === 409 && err.message.includes('is not this project')) setConfirm({ path, message: err.message });
      else showError(err);
    } finally {
      setPending(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <FolderSearch className="size-4 text-accent" /> Update the location of {project.name}
        </span>
      }
      description={
        <>
          Shipyard looks for the project at <code className="font-mono">{project.path}</code>
          {project.folderMissing ? ', which no longer exists.' : '.'} Pick where it lives now.
        </>
      }
      width="max-w-2xl"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <div className="space-y-5">
        <section>
          <h4 className="mb-2 text-xs font-semibold tracking-wide text-faint uppercase">
            {project.git.remoteUrl ? 'Repos with the same git remote' : 'Folders with the same name'}
          </h4>
          {candidates.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner /> Searching your home folder{project.git.githubRepo ? ` for ${project.git.githubRepo}` : ''}…
            </div>
          ) : candidates.error ? (
            <p className="text-sm text-rose-400">{(candidates.error as Error).message}</p>
          ) : candidates.data?.length ? (
            <ul className="space-y-2">
              {candidates.data.map((c, i) => (
                <li key={c.path} className={cn('flex items-start gap-3 rounded-xl border p-3', i === 0 ? 'border-accent/50 bg-accent-soft/30' : 'border-line')}>
                  <FolderGit2 className="mt-0.5 size-4 shrink-0 text-faint" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="font-mono text-xs break-all text-fg">{c.path}</code>
                      {i === 0 && candidates.data.length > 1 && <Badge className="border-accent/40 text-accent">Most recent</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                      {c.branch && (
                        <span className="flex items-center gap-1">
                          <GitBranch className="size-3" /> {c.branch}
                        </span>
                      )}
                      <span>{c.commitCount} commits</span>
                      <span title={c.lastCommitMessage ?? undefined}>last commit {timeAgo(c.lastCommitAt)}</span>
                      {c.uncommittedFiles > 0 && <span className="text-amber-400">{c.uncommittedFiles} uncommitted files</span>}
                    </div>
                    {c.lastCommitMessage && <div className="mt-0.5 truncate text-xs text-faint">“{c.lastCommitMessage}”</div>}
                  </div>
                  <Button size="sm" variant={i === 0 ? 'primary' : 'secondary'} loading={pending === c.path} disabled={!!pending} onClick={() => void use(c.path)}>
                    Use this folder
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No matching repos found in your home folder. Enter the path below.</p>
          )}
        </section>

        <Field label="Or enter the folder path">
          <div className="flex gap-2">
            <Input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && manual.trim() && void use(manual.trim())}
              placeholder="~/Documents/my-repo"
              className="font-mono text-xs"
            />
            <Button disabled={!manual.trim() || !!pending} loading={pending === manual.trim()} onClick={() => void use(manual.trim())}>
              Use path
            </Button>
          </div>
        </Field>

        {confirm && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-400">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <div className="flex-1">
              <div>{confirm.message}</div>
              <div className="mt-2 flex gap-2">
                <Button size="xs" variant="danger" onClick={() => void use(confirm.path, true)}>
                  Use it anyway
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

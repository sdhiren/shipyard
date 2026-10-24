import { useQuery } from '@tanstack/react-query';
import { FolderGit2, FolderSearch } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { useAction } from '../../api/hooks';
import { Badge, Button, Dialog, Field, Input, Spinner } from '../ui';

/** Register a local repository, by path or from auto-discovery. */
export function AddProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const navigate = useNavigate();
  const discovered = useQuery({ queryKey: ['discover'], queryFn: api.discover, enabled: open, staleTime: 60_000 });
  const add = useAction((p: { path: string; name?: string }) => api.createProject(p), { invalidate: [['projects'], ['discover'], ['dashboard']] });

  const submit = (p: string, n?: string) =>
    add.mutate(
      { path: p, name: n || undefined },
      {
        onSuccess: (project) => {
          toast.success(`Added ${project.name}`, { description: `${project.stack.languages.join(', ')} · ${project.git.githubRepo ?? 'local only'}` });
          setPath('');
          setName('');
          onClose();
          navigate(`/projects/${project.id}`);
        },
      },
    );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a project"
      description="Point Shipyard at a local git repository. It detects the stack, git remote and test command."
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!path.trim()} loading={add.isPending} onClick={() => submit(path.trim(), name.trim())}>
            Add project
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[2fr_1fr] gap-3">
          <Field label="Repository path">
            <Input autoFocus placeholder="~/Desktop/Go/url-shortener" value={path} onChange={(e) => setPath(e.target.value)} className="font-mono text-xs" />
          </Field>
          <Field label="Display name (optional)">
            <Input placeholder="URL Shortener" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-faint uppercase">
            <FolderSearch className="size-3.5" /> Found on this machine
          </div>
          {discovered.isLoading ? (
            <Spinner />
          ) : (
            <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line">
              {discovered.data?.map((r) => (
                <li key={r.path} className="flex items-center gap-3 px-3 py-2">
                  <FolderGit2 className="size-4 shrink-0 text-faint" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-fg">{r.name}</div>
                    <div className="truncate font-mono text-[11px] text-faint">{r.path}</div>
                  </div>
                  {r.alreadyAdded ? (
                    <Badge>added</Badge>
                  ) : (
                    <Button size="xs" onClick={() => submit(r.path)} disabled={add.isPending}>
                      Add
                    </Button>
                  )}
                </li>
              ))}
              {!discovered.data?.length && <li className="px-3 py-4 text-sm text-faint">No repositories found in the discovery folders (see Settings).</li>}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}

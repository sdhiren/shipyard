import type { ImportCandidate, ItemSource } from '@shipyard/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useAction } from '../../api/hooks';
import { TypeIcon } from '../domain';
import { Badge, Button, Dialog, EmptyState, Spinner } from '../ui';

const SOURCE_LABEL: Partial<Record<ItemSource, string>> = {
  backlog_file: 'Backlog files',
  todo_comment: 'TODO / FIXME comments',
  github_issue: 'GitHub issues',
};

/** Pull existing work from BACKLOG.md, TODO comments and GitHub issues into the Inbox. */
export function ImportDialog({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['imports', projectId], queryFn: () => api.importCandidates(projectId), enabled: open });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (data) setSelected(new Set(data.filter((c) => !c.alreadyImported && c.source !== 'todo_comment').map((c) => c.sourceRef)));
  }, [data]);
  const groups = useMemo(() => {
    const m = new Map<ItemSource, ImportCandidate[]>();
    for (const c of data ?? []) m.set(c.source, [...(m.get(c.source) ?? []), c]);
    return [...m.entries()];
  }, [data]);
  const apply = useAction(() => api.applyImports(projectId, [...selected]), { success: `Imported ${selected.size} item(s) into the Inbox` });

  const toggle = (ref: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(ref)) n.delete(ref);
      else n.add(ref);
      return n;
    });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import existing backlog"
      description="Unchecked items from BACKLOG.md / TODO.md / ROADMAP.md, TODO and FIXME comments, and open GitHub issues."
      width="max-w-3xl"
      footer={
        <>
          <span className="mr-auto text-xs text-faint">{selected.size} selected · imported items land in the Inbox for triage</span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!selected.size} loading={apply.isPending} onClick={() => apply.mutate(undefined, { onSuccess: onClose })}>
            Import {selected.size}
          </Button>
        </>
      }
    >
      {isLoading ? (
        <Spinner />
      ) : !data?.length ? (
        <EmptyState title="Nothing to import" description="No unchecked backlog entries, TODO comments or open issues were found." />
      ) : (
        <div className="space-y-5">
          {groups.map(([source, list]) => (
            <div key={source}>
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-xs font-semibold tracking-wide text-faint uppercase">
                  {SOURCE_LABEL[source] ?? source} · {list.length}
                </h4>
                <button
                  className="text-xs text-accent"
                  onClick={() =>
                    setSelected((s) => {
                      const n = new Set(s);
                      const all = list.filter((c) => !c.alreadyImported).every((c) => n.has(c.sourceRef));
                      list.forEach((c) => !c.alreadyImported && (all ? n.delete(c.sourceRef) : n.add(c.sourceRef)));
                      return n;
                    })
                  }
                >
                  Toggle all
                </button>
              </div>
              <ul className="divide-y divide-line rounded-xl border border-line">
                {list.map((c) => (
                  <li key={c.sourceRef}>
                    <label className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-hover">
                      <input type="checkbox" className="mt-1" disabled={c.alreadyImported} checked={selected.has(c.sourceRef)} onChange={() => toggle(c.sourceRef)} />
                      <TypeIcon type={c.type} className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-fg">{c.title}</div>
                        {c.description && <div className="line-clamp-1 text-xs text-faint">{c.description}</div>}
                      </div>
                      <code className="shrink-0 font-mono text-[11px] text-faint">{c.sourceRef}</code>
                      {c.alreadyImported && <Badge>imported</Badge>}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

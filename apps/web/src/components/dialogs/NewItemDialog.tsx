import { EFFORTS, ITEM_TYPES, PRIORITIES, PRIORITY_LABELS, TYPE_LABELS, type Effort, type ItemStatus, type ItemType, type Priority } from '@shipyard/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { useAction, useProjects } from '../../api/hooks';
import { Button, Dialog, Field, Input, Select, Textarea } from '../ui';

/** Manually add a backlog item. Opens with "c" anywhere in the app. */
export function NewItemDialog({
  open,
  onClose,
  projectId: initialProjectId,
  status = 'backlog',
}: {
  open: boolean;
  onClose: () => void;
  projectId?: string;
  status?: ItemStatus;
}) {
  const { data: projects } = useProjects();
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<ItemType>('feature');
  const [priority, setPriority] = useState<Priority>('p2');
  const [effort, setEffort] = useState<Effort | ''>('');
  const [impact, setImpact] = useState('');
  const [criteria, setCriteria] = useState('');
  const [tags, setTags] = useState('');
  const [another, setAnother] = useState(false);

  useEffect(() => {
    if (open) setProjectId(initialProjectId ?? projects?.[0]?.id ?? '');
  }, [open, initialProjectId, projects]);

  const reset = () => {
    setTitle('');
    setDescription('');
    setCriteria('');
    setTags('');
  };

  const create = useAction(
    () =>
      api.createItem(projectId, {
        title: title.trim(),
        description,
        type,
        priority,
        effort: effort || null,
        impact: impact ? Number(impact) : null,
        status,
        acceptanceCriteria: criteria
          .split('\n')
          .map((s) => s.replace(/^[-*]\s*/, '').trim())
          .filter(Boolean),
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      }),
    {},
  );

  const submit = () =>
    create.mutate(undefined, {
      onSuccess: (item) => {
        toast.success(`Created ${item.key}`, { description: item.title });
        reset();
        if (!another) onClose();
      },
    });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New backlog item"
      width="max-w-2xl"
      footer={
        <>
          <label className="mr-auto flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={another} onChange={(e) => setAnother(e.target.checked)} /> Create another
          </label>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={title.trim().length < 3 || !projectId} loading={create.isPending} onClick={submit}>
            Create item
          </Button>
        </>
      }
    >
      <div
        className="space-y-4"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && title.trim().length >= 3) submit();
        }}
      >
        {!initialProjectId && (
          <Field label="Project">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Input autoFocus placeholder="Title, e.g. “Add a weekly digest email”" className="h-10 text-base" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Textarea placeholder="Describe the problem and the idea (Markdown)…" className="min-h-32" value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="grid grid-cols-4 gap-3">
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value as ItemType)}>
              {ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Effort">
            <Select value={effort} onChange={(e) => setEffort(e.target.value as Effort)}>
              <option value="">—</option>
              {EFFORTS.map((x) => (
                <option key={x} value={x}>
                  {x.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Impact">
            <Select value={impact} onChange={(e) => setImpact(e.target.value)}>
              <option value="">—</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} / 5
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Acceptance criteria" hint="One per line">
          <Textarea className="min-h-20" value={criteria} onChange={(e) => setCriteria(e.target.value)} />
        </Field>
        <Field label="Tags" hint="Comma separated">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="api, onboarding" />
        </Field>
      </div>
    </Dialog>
  );
}

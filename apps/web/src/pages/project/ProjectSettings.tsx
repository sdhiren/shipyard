import type { Project, ProjectSettings as Settings } from '@shipyard/shared';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useAction } from '../../api/hooks';
import { Button, Card, Field, Input, Select, Textarea, Toggle } from '../../components/ui';

/** Per-project knobs for how Claude works on this repository. */
export function ProjectSettings({ project }: { project: Project }) {
  const [s, setS] = useState<Settings>(project.settings);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [color, setColor] = useState(project.color);
  const navigate = useNavigate();
  useEffect(() => setS(project.settings), [project.settings]);

  const save = useAction(() => api.updateProject(project.id, { name, description, color, settings: s }), {
    success: 'Project settings saved',
    invalidate: [['project', project.id], ['projects']],
  });
  const remove = useAction(() => api.deleteProject(project.id), { success: 'Project removed from Shipyard', invalidate: [['projects']] });
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((p) => ({ ...p, [k]: v }));

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 pb-16">
      <Card className="space-y-4 p-5">
        <h3 className="text-sm font-semibold">General</h3>
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Color">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-8 w-14 cursor-pointer rounded-lg border border-line bg-panel" />
          </Field>
        </div>
        <Field label="Description" hint="Shown in the UI and given to Claude as context.">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Path">
          <Input value={project.path} disabled className="font-mono text-xs" />
        </Field>
      </Card>

      <Card className="space-y-4 p-5">
        <h3 className="text-sm font-semibold">Claude</h3>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Model" hint="Alias (opus, sonnet, haiku) or full model id">
            <Input value={s.model} onChange={(e) => set('model', e.target.value)} className="font-mono text-xs" />
          </Field>
          <Field label="Effort">
            <Select value={s.effort} onChange={(e) => set('effort', e.target.value as Settings['effort'])}>
              {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </Select>
          </Field>
          <Field label="Budget per run (USD)" hint="0 = no cap">
            <Input type="number" min={0} step={0.5} value={s.maxBudgetUsd} onChange={(e) => set('maxBudgetUsd', Number(e.target.value))} />
          </Field>
        </div>
        <Field label="Autonomy when implementing">
          <Select value={s.autonomy} onChange={(e) => set('autonomy', e.target.value as Settings['autonomy'])}>
            <option value="guarded">Guarded: file edits plus the allow-listed commands below</option>
            <option value="full">Full: skip permission checks (runs in an isolated worktree, but commands are unrestricted)</option>
          </Select>
        </Field>
        <Field label="Allowed commands (guarded mode)" hint="One Claude Code permission rule per line, e.g. Bash(npm test*)">
          <Textarea
            className="min-h-28 font-mono text-xs"
            value={s.allowedTools.join('\n')}
            onChange={(e) =>
              set(
                'allowedTools',
                e.target.value
                  .split('\n')
                  .map((x) => x.trim())
                  .filter(Boolean),
              )
            }
          />
        </Field>
        <Field label="Verification command" hint="Claude runs this before finishing an implementation.">
          <Input value={s.testCommand} onChange={(e) => set('testCommand', e.target.value)} className="font-mono text-xs" placeholder="npm test" />
        </Field>
        <Field label="Standing instructions" hint="Appended to every prompt for this project: conventions, no-go areas, product direction.">
          <Textarea
            className="min-h-28"
            value={s.customInstructions}
            onChange={(e) => set('customInstructions', e.target.value)}
            placeholder="e.g. Keep the API backwards compatible. Prefer the standard library over new dependencies."
          />
        </Field>
      </Card>

      <Card className="space-y-4 p-5">
        <h3 className="text-sm font-semibold">Delivery</h3>
        <Field label="Branch prefix">
          <Input value={s.branchPrefix} onChange={(e) => set('branchPrefix', e.target.value)} className="font-mono text-xs" />
        </Field>
        <div className="flex flex-col gap-3">
          <Toggle checked={s.autoPr} onChange={(v) => set('autoPr', v)} label="Push and open a PR automatically when Claude finishes" />
          <Toggle checked={s.draftPr} onChange={(v) => set('draftPr', v)} label="Open PRs as drafts" />
          <Toggle checked={s.cleanupWorktreeOnMerge} onChange={(v) => set('cleanupWorktreeOnMerge', v)} label="Delete the worktree when the PR merges" />
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <Button
          variant="danger"
          onClick={() => {
            if (confirm(`Remove ${project.name} from Shipyard? Your repository is not touched.`)) remove.mutate(undefined, { onSuccess: () => navigate('/') });
          }}
        >
          Remove project
        </Button>
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
          Save changes
        </Button>
      </div>
    </div>
  );
}

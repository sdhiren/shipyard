import { ANALYSIS_FOCUS, FOCUS_LABELS, type AnalysisFocus, type Project } from '@shipyard/shared';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api/client';
import { useAction } from '../../api/hooks';
import { cn } from '../../lib/utils';
import { Button, Dialog, Field, Textarea } from '../ui';

const PRESETS: { label: string; focus: AnalysisFocus[] }[] = [
  { label: 'Ideas for new features', focus: ['features', 'ux'] },
  { label: 'Production hardening', focus: ['security', 'observability', 'testing'] },
  { label: 'Speed it up', focus: ['performance'] },
  { label: 'Clean house', focus: ['tech_debt', 'dx', 'testing'] },
];

/** Ask Claude to study a project and propose backlog items into the Inbox. */
export function AnalyzeDialog({ open, onClose, project }: { open: boolean; onClose: () => void; project: Project }) {
  const [focus, setFocus] = useState<AnalysisFocus[]>(['features', 'ux']);
  const [count, setCount] = useState(8);
  const [guidance, setGuidance] = useState('');
  const start = useAction(() => api.analyze(project.id, { focus, count, guidance }), {
    success: 'Claude is studying the codebase. Suggestions will land in the Inbox.',
    invalidate: [['analyses', project.id], ['runs']],
  });
  const toggle = (f: AnalysisFocus) => setFocus((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Explore improvements for ${project.name}`}
      description="Claude reads the repository (read-only) and proposes concrete, PR-sized items. Nothing is added to your backlog until you approve it."
      width="max-w-xl"
      footer={
        <>
          <span className="mr-auto text-xs text-faint">
            Model <span className="font-mono">{project.settings.model}</span> · budget ${project.settings.maxBudgetUsd}
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Sparkles className="size-3.5" />} disabled={!focus.length} loading={start.isPending} onClick={() => start.mutate(undefined, { onSuccess: onClose })}>
            Start analysis
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button key={p.label} onClick={() => setFocus(p.focus)} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:border-accent hover:text-fg">
              {p.label}
            </button>
          ))}
        </div>
        <Field label="Focus areas">
          <div className="grid grid-cols-2 gap-2">
            {ANALYSIS_FOCUS.map((f) => (
              <button
                key={f}
                onClick={() => toggle(f)}
                className={cn(
                  'rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                  focus.includes(f) ? 'border-accent bg-accent-soft text-fg' : 'border-line text-muted hover:bg-hover',
                )}
              >
                {FOCUS_LABELS[f]}
              </button>
            ))}
          </div>
        </Field>
        <Field label={`Number of suggestions: ${count}`}>
          <input type="range" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} className="accent-[var(--accent)]" />
        </Field>
        <Field label="Steer (optional)" hint="Goals, constraints or ideas you want Claude to consider.">
          <Textarea
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            placeholder="e.g. I want this to be usable by friends, not just me. Avoid adding new infrastructure."
          />
        </Field>
      </div>
    </Dialog>
  );
}

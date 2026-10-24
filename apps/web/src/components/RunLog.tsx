import type { RunEvent } from '@shipyard/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CircleAlert, Square, Terminal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useRun } from '../api/hooks';
import { subscribeRunEvents } from '../api/live';
import { cn, formatCost, formatDuration } from '../lib/utils';
import { Md, RunStatusIcon } from './domain';
import { Button, Spinner } from './ui';

/** Live, streaming transcript of one Claude run. */
export function RunLog({ runId, className, compact }: { runId: string; className?: string; compact?: boolean }) {
  const { data: run } = useRun(runId);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [follow, setFollow] = useState(true);
  const [showPrompt, setShowPrompt] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    setEvents([]);
    setLoading(true);
    const seen = new Set<number>();
    const add = (list: RunEvent[]) =>
      setEvents((prev) => {
        const fresh = list.filter((e) => !seen.has(e.seq));
        fresh.forEach((e) => seen.add(e.seq));
        return fresh.length ? [...prev, ...fresh].sort((a, b) => a.seq - b.seq) : prev;
      });
    // Subscribe first, then backfill, so nothing between the two is lost.
    const unsub = subscribeRunEvents(runId, (e) => add([e]));
    api.runEvents(runId).then((list) => {
      if (!cancelled) {
        add(list);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [runId]);

  useEffect(() => {
    if (follow && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [events, follow]);

  const active = run?.status === 'running' || run?.status === 'queued';

  return (
    <div className={cn('flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-bg', className)}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs">
        {run ? <RunStatusIcon status={run.status} /> : <Spinner className="size-3.5" />}
        <span className="font-medium text-fg capitalize">{run?.kind ?? 'run'}</span>
        <span className="text-faint">·</span>
        <span className="text-muted">{run?.model}</span>
        {run?.branch && <span className="truncate font-mono text-faint">{run.branch}</span>}
        <span className="ml-auto flex items-center gap-3 text-faint tabular-nums">
          {run?.durationMs ? <span>{formatDuration(run.durationMs)}</span> : null}
          {run?.costUsd != null && <span>{formatCost(run.costUsd)}</span>}
          {!compact && (
            <button className="hover:text-fg" onClick={() => setShowPrompt((s) => !s)}>
              {showPrompt ? 'Hide prompt' : 'Prompt'}
            </button>
          )}
          {active && (
            <Button
              size="xs"
              variant="danger"
              icon={<Square className="size-3" />}
              onClick={async () => {
                await api.cancelRun(runId);
                void qc.invalidateQueries({ queryKey: ['run', runId] });
              }}
            >
              Stop
            </Button>
          )}
        </span>
      </div>
      {showPrompt && run && (
        <pre className="max-h-64 overflow-auto border-b border-line bg-panel p-3 font-mono text-[11px] whitespace-pre-wrap text-muted">{run.prompt}</pre>
      )}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3 font-mono text-[12px] leading-relaxed"
      >
        {loading && events.length === 0 && <Spinner />}
        {events.map((e) => (
          <EventLine key={e.seq} event={e} />
        ))}
        {active && (
          <div className="flex items-center gap-2 pt-1 text-faint">
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-amber-400" /> working…
          </div>
        )}
        {run?.error && (
          <div className="mt-2 flex gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2 font-sans text-xs text-rose-400">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span className="whitespace-pre-wrap">{run.error}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function EventLine({ event }: { event: RunEvent }) {
  const [open, setOpen] = useState(false);
  const isError = (event.data as { isError?: boolean } | null)?.isError;
  const lines = useMemo(() => event.text.split('\n'), [event.text]);

  switch (event.type) {
    case 'text':
      return (
        <div className="my-2 rounded-lg border border-line bg-panel px-3 py-2 font-sans">
          <Md className="prose-p:my-1">{event.text}</Md>
        </div>
      );
    case 'tool_use':
      return (
        <div className="flex gap-2 text-sky-400">
          <Terminal className="mt-0.5 size-3 shrink-0" />
          <span className="break-all whitespace-pre-wrap">{event.text}</span>
        </div>
      );
    case 'tool_result':
      if (!event.text) return null;
      return (
        <div className={cn('pl-5', isError ? 'text-rose-400' : 'text-faint')}>
          <button className="flex items-center gap-1 hover:text-muted" onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            <span className="truncate">{lines[0]?.slice(0, 120)}</span>
            {lines.length > 1 && <span className="shrink-0">(+{lines.length - 1} lines)</span>}
          </button>
          {open && <pre className="mt-1 max-h-80 overflow-auto rounded bg-panel p-2 whitespace-pre-wrap">{event.text}</pre>}
        </div>
      );
    case 'status':
      return <div className="text-[11px] tracking-wide text-faint uppercase">— {event.text}</div>;
    case 'step':
      return <div className="text-violet-400">▸ {event.text}</div>;
    case 'result':
      return <div className="font-medium text-emerald-400">✓ {event.text}</div>;
    case 'stderr':
      return <div className="whitespace-pre-wrap text-rose-400/80">{event.text}</div>;
    default:
      return <div className="text-muted">{event.text}</div>;
  }
}

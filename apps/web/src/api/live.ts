import type { LiveEvent, RunEvent } from '@shipyard/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

/**
 * One EventSource for the whole app. Server events invalidate the matching
 * React Query caches, so every view stays live without polling.
 */

type RunListener = (e: RunEvent) => void;
const runListeners = new Map<string, Set<RunListener>>();
const statusListeners = new Set<(connected: boolean) => void>();
let connected = false;

export function subscribeRunEvents(runId: string, fn: RunListener): () => void {
  if (!runListeners.has(runId)) runListeners.set(runId, new Set());
  runListeners.get(runId)!.add(fn);
  return () => runListeners.get(runId)?.delete(fn);
}

export function useLiveConnection(): boolean {
  const [state, setState] = useState(connected);
  useEffect(() => {
    statusListeners.add(setState);
    return () => void statusListeners.delete(setState);
  }, []);
  return state;
}

export function useLiveUpdates(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const pending = new Set<string>();
    let flushTimer: number | undefined;
    const invalidate = (...keys: unknown[][]) => {
      for (const k of keys) pending.add(JSON.stringify(k));
      window.clearTimeout(flushTimer);
      flushTimer = window.setTimeout(() => {
        for (const k of pending) void qc.invalidateQueries({ queryKey: JSON.parse(k) as unknown[] });
        pending.clear();
      }, 150);
    };

    const es = new EventSource('/api/events');
    const setConnected = (v: boolean) => {
      connected = v;
      statusListeners.forEach((fn) => fn(v));
    };
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data as string) as LiveEvent;
      switch (e.type) {
        case 'run.event':
          runListeners.get(e.runId)?.forEach((fn) => fn(e.event));
          break;
        case 'run.changed':
          invalidate(['runs'], ['run', e.runId], ['dashboard'], ['projects']);
          if (e.itemId) invalidate(['item-runs', e.itemId], ['item', e.itemId]);
          break;
        case 'item.changed':
          invalidate(['items', e.projectId], ['item', e.itemId], ['item-activity', e.itemId], ['projects'], ['dashboard']);
          break;
        case 'items.changed':
          invalidate(['items', e.projectId], ['projects'], ['dashboard']);
          break;
        case 'project.changed':
          invalidate(['projects'], ['project', e.projectId], ['dashboard']);
          break;
        case 'analysis.changed':
          invalidate(['analyses', e.projectId], ['project', e.projectId]);
          break;
        case 'activity':
          invalidate(['activity', e.activity.projectId], ['dashboard']);
          if (e.activity.itemId) invalidate(['item-activity', e.activity.itemId]);
          break;
      }
    };
    return () => {
      es.close();
      window.clearTimeout(flushTimer);
    };
  }, [qc]);
}

import type { DecisionInput } from '@shipyard/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type ItemQuery } from './client';

export const useHealth = () => useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 });
export const useDashboard = () => useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard });
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: api.settings });
export const useProjects = () => useQuery({ queryKey: ['projects'], queryFn: () => api.projects() });
export const useProject = (id: string | undefined) =>
  useQuery({ queryKey: ['project', id], queryFn: () => api.project(id!), enabled: !!id });
export const useItems = (projectId: string | undefined, q: ItemQuery = {}) =>
  useQuery({ queryKey: ['items', projectId, q], queryFn: () => api.items(projectId!, q), enabled: !!projectId });
export const useItem = (id: string | undefined | null) => useQuery({ queryKey: ['item', id], queryFn: () => api.item(id!), enabled: !!id });
export const useItemActivity = (id: string | undefined | null) =>
  useQuery({ queryKey: ['item-activity', id], queryFn: () => api.itemActivity(id!), enabled: !!id });
export const useItemRuns = (id: string | undefined | null) => useQuery({ queryKey: ['item-runs', id], queryFn: () => api.itemRuns(id!), enabled: !!id });
export const useAnalyses = (projectId: string | undefined) =>
  useQuery({ queryKey: ['analyses', projectId], queryFn: () => api.analyses(projectId!), enabled: !!projectId });
export const useProjectActivity = (projectId: string | undefined) =>
  useQuery({ queryKey: ['activity', projectId], queryFn: () => api.projectActivity(projectId!), enabled: !!projectId });
export const useRuns = (params: { projectId?: string; status?: string; limit?: number } = {}) =>
  useQuery({ queryKey: ['runs', params], queryFn: () => api.runs(params) });
export const useRun = (id: string | undefined | null) => useQuery({ queryKey: ['run', id], queryFn: () => api.run(id!), enabled: !!id });

const errorToast = (err: unknown) => toast.error(err instanceof Error ? err.message : String(err));

const DECISION_TOASTS: Record<DecisionInput['decision'], string> = {
  implement: 'Claude started implementing',
  plan: 'Claude is drafting a plan',
  up_next: 'Moved to Up next',
  skip: 'Skipped',
  snooze: 'Snoozed',
  archive: 'Archived',
  restore: 'Restored to backlog',
  approve: 'Added to backlog',
  reject: 'Rejected',
  done: 'Marked done',
};

export function useDecide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: DecisionInput & { id: string }) => api.decide(id, input),
    onSuccess: (res, vars) => {
      toast.success(DECISION_TOASTS[vars.decision], { description: res.item.title });
      void qc.invalidateQueries({ queryKey: ['items', res.item.projectId] });
      void qc.invalidateQueries({ queryKey: ['item', res.item.id] });
    },
    onError: errorToast,
  });
}

export function useBulkDecide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, ...input }: DecisionInput & { ids: string[] }) => api.bulkDecide(ids, input),
    onSuccess: (res, vars) => {
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length) toast.error(`${failed.length} item(s) failed`, { description: failed[0]?.error });
      else toast.success(`${DECISION_TOASTS[vars.decision]} · ${res.results.length} item(s)`);
      void qc.invalidateQueries({ queryKey: ['items'] });
    },
    onError: errorToast,
  });
}

/** Generic mutation with toast + broad invalidation, for one-off actions. */
export function useAction<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>, opts: { success?: string; invalidate?: unknown[][] } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      if (opts.success) toast.success(opts.success);
      for (const key of opts.invalidate ?? [['items'], ['projects']]) void qc.invalidateQueries({ queryKey: key });
    },
    onError: errorToast,
  });
}

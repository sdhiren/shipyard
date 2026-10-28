import type {
  Activity,
  Analysis,
  AnalyzeInput,
  BacklogItem,
  CreateItemInput,
  CreateProjectInput,
  DashboardSummary,
  DecisionInput,
  DiscoveredRepo,
  GlobalSettings,
  ImportCandidate,
  ItemStatus,
  Project,
  ProjectWithStats,
  Run,
  RunEvent,
  UpdateItemInput,
  UpdateProjectInput,
} from '@shipyard/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Shipyard': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: { path: string[]; message: string }[] };
  if (!res.ok) {
    const detail = data.issues?.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ApiError(res.status, detail ? `${data.error}: ${detail}` : (data.error ?? res.statusText));
  }
  return data as T;
}

const get = <T>(url: string) => request<T>('GET', url);
const post = <T>(url: string, body: unknown = {}) => request<T>('POST', url, body);
const patch = <T>(url: string, body: unknown) => request<T>('PATCH', url, body);
const put = <T>(url: string, body: unknown) => request<T>('PUT', url, body);
const del = <T>(url: string) => request<T>('DELETE', url);

export interface Health {
  ok: boolean;
  claude: boolean;
  gh: { installed: boolean; authenticated: boolean };
  dataDir: string;
  queue: { running: string[]; queued: string[] };
}

export interface ItemQuery {
  status?: ItemStatus[];
  q?: string;
  includeSnoozed?: boolean;
}

const qs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : '';
};

export const api = {
  health: () => get<Health>('/health'),
  dashboard: () => get<DashboardSummary>('/dashboard'),
  settings: () => get<GlobalSettings>('/settings'),
  updateSettings: (s: Partial<GlobalSettings>) => put<GlobalSettings>('/settings', s),
  syncAllPrs: () => post<{ synced: number; failed: number }>('/prs/sync'),

  projects: (archived = false) => get<ProjectWithStats[]>(`/projects${archived ? '?archived=true' : ''}`),
  project: (id: string) => get<Project>(`/projects/${id}`),
  createProject: (input: CreateProjectInput) => post<Project>('/projects', input),
  updateProject: (id: string, input: UpdateProjectInput) => patch<Project>(`/projects/${id}`, input),
  deleteProject: (id: string) => del<void>(`/projects/${id}`),
  rescanProject: (id: string) => post<Project>(`/projects/${id}/rescan`),
  discover: () => get<DiscoveredRepo[]>('/projects/discover'),
  importCandidates: (id: string) => get<ImportCandidate[]>(`/projects/${id}/imports`),
  applyImports: (id: string, sourceRefs: string[]) => post<{ imported: number }>(`/projects/${id}/imports`, { sourceRefs }),
  projectActivity: (id: string) => get<Activity[]>(`/projects/${id}/activity?limit=100`),

  items: (projectId: string, q: ItemQuery = {}) =>
    get<BacklogItem[]>(
      `/projects/${projectId}/items${qs({ status: q.status?.join(','), q: q.q, includeSnoozed: q.includeSnoozed ? 'true' : undefined })}`,
    ),
  createItem: (projectId: string, input: CreateItemInput) => post<BacklogItem>(`/projects/${projectId}/items`, input),
  item: (id: string) => get<BacklogItem>(`/items/${id}`),
  updateItem: (id: string, input: UpdateItemInput) => patch<BacklogItem>(`/items/${id}`, input),
  deleteItem: (id: string) => del<void>(`/items/${id}`),
  moveItem: (id: string, status: ItemStatus, position: number) => post<BacklogItem>(`/items/${id}/move`, { status, position }),
  decide: (id: string, input: DecisionInput) => post<{ item: BacklogItem; run: Run | null }>(`/items/${id}/decision`, input),
  bulkDecide: (itemIds: string[], input: DecisionInput) =>
    post<{ results: { id: string; ok: boolean; error?: string }[] }>('/items/bulk-decision', { itemIds, ...input }),
  addNote: (id: string, body: string) => post<{ ok: true }>(`/items/${id}/notes`, { body }),
  itemActivity: (id: string) => get<Activity[]>(`/items/${id}/activity`),
  itemRuns: (id: string) => get<Run[]>(`/items/${id}/runs`),
  revise: (id: string, feedback: string) => post<Run>(`/items/${id}/revise`, { feedback }),
  rebase: (id: string) => post<Run>(`/items/${id}/rebase`),
  diff: (id: string) => get<{ stat: string; diff: string }>(`/items/${id}/diff`),
  discardWorkspace: (id: string) => del<BacklogItem>(`/items/${id}/workspace`),
  openPr: (id: string) => post<BacklogItem>(`/items/${id}/pr`),
  linkPr: (id: string, prUrlOrNumber: string) => post<BacklogItem>(`/items/${id}/pr/link`, { prUrlOrNumber }),
  syncPr: (id: string) => post<BacklogItem>(`/items/${id}/pr/sync`),
  mergePr: (id: string, method: 'squash' | 'merge' | 'rebase' = 'squash') => post<BacklogItem>(`/items/${id}/pr/merge`, { method }),

  analyses: (projectId: string) => get<Analysis[]>(`/projects/${projectId}/analyses`),
  analyze: (projectId: string, input: AnalyzeInput) => post<Analysis>(`/projects/${projectId}/analyses`, input),

  runs: (params: { projectId?: string; status?: string; limit?: number } = {}) =>
    get<Run[]>(`/runs${qs({ projectId: params.projectId, status: params.status, limit: params.limit?.toString() })}`),
  run: (id: string) => get<Run & { prompt: string }>(`/runs/${id}`),
  runEvents: (id: string, after = 0) => get<RunEvent[]>(`/runs/${id}/events?after=${after}`),
  cancelRun: (id: string) => post<Run>(`/runs/${id}/cancel`),
};

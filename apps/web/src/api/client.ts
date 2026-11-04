import type {
  Activity,
  Analysis,
  AnalyzeInput,
  Attachment,
  BacklogItem,
  ClaudeAuthStatus,
  ClaudeLoginSession,
  Comment,
  CreateCommentInput,
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

/**
 * Uploads send the raw file body (name in X-Filename). XHR rather than fetch
 * so the composer can show upload progress.
 */
function uploadAttachment(itemId: string, file: File, opts: { draft?: boolean; onProgress?: (fraction: number) => void } = {}): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/items/${itemId}/attachments${opts.draft ? '?draft=1' : ''}`);
    xhr.setRequestHeader('X-Shipyard', '1');
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => e.lengthComputable && opts.onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data: { error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText) as { error?: string };
      } catch {
        // Non-JSON error page: fall back to the status text.
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as Attachment);
      else reject(new ApiError(xhr.status, data.error ?? (xhr.statusText || 'Upload failed')));
    };
    xhr.onerror = () => reject(new ApiError(0, `Could not upload ${file.name}`));
    xhr.send(file);
  });
}

const get = <T>(url: string) => request<T>('GET', url);
const post = <T>(url: string, body: unknown = {}) => request<T>('POST', url, body);
const patch = <T>(url: string, body: unknown) => request<T>('PATCH', url, body);
const put = <T>(url: string, body: unknown) => request<T>('PUT', url, body);
const del = <T>(url: string) => request<T>('DELETE', url);

export interface Health {
  ok: boolean;
  claude: boolean;
  claudeAuth: ClaudeAuthStatus;
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
  claudeAuth: (refresh = false) => get<{ status: ClaudeAuthStatus; login: ClaudeLoginSession | null }>(`/claude/auth${refresh ? '?refresh=true' : ''}`),
  startClaudeLogin: (method: 'claudeai' | 'console') => post<ClaudeLoginSession>('/claude/login', { method }),
  submitClaudeCode: (code: string) => post<ClaudeLoginSession>('/claude/login/code', { code }),
  cancelClaudeLogin: () => del<void>('/claude/login'),
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
  revise: (id: string, feedback: string, attachmentIds: string[] = []) => post<Run>(`/items/${id}/revise`, { feedback, attachmentIds }),
  attachments: (itemId: string) => get<Attachment[]>(`/items/${itemId}/attachments`),
  uploadAttachment,
  deleteAttachment: (id: string) => del<void>(`/attachments/${id}`),
  rebase: (id: string) => post<Run>(`/items/${id}/rebase`),
  comments: (id: string) => get<Comment[]>(`/items/${id}/comments`),
  postComment: (id: string, input: CreateCommentInput) => post<{ comment: Comment; run: Run | null }>(`/items/${id}/comments`, input),
  retryDiscussion: (id: string) => post<Run>(`/items/${id}/discuss`),
  deleteComment: (id: string) => del<void>(`/comments/${id}`),
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

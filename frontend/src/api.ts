import type { ActivityItem, AgentInfo, ApiState, CronJob, DelegationTasksData, EvolutionData, MessageResponse, OutboxData, OutboxRetryResponse, TaskItem, TasksData } from './types';

export type SessionData = {
  ok: boolean;
  auth_enabled: boolean;
  auth_mode: 'disabled' | 'local';
  authenticated: boolean;
  email: string | null;
  role: 'viewer' | 'operator' | 'admin' | null;
  capabilities: string[];
};

type ApiErrorPayload = {
  ok?: false;
  error?: string;
  request_id?: string;
};

const securityErrorMessages: Record<string, string> = {
  auth_not_enabled: '登录功能尚未启用，请稍后刷新页面。',
  authentication_required: '登录已失效，请重新登录。',
  invalid_credentials: '密码不正确，请检查后重试。',
  login_rate_limited: '密码尝试次数过多，请稍后再试。',
  forbidden: '当前账号没有执行此操作的权限。',
  csrf_rejected: '请求来源校验失败，请刷新页面后重试。',
  invalid_idempotency_key: '操作标识无效，请刷新页面后重试。',
  operation_in_progress: '相同操作仍在处理中，请勿重复提交。',
  rate_limited: '操作过于频繁，请稍后重试。',
};

function createIdempotencyKey(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function operationHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Hermes-CSRF': '1',
    'Idempotency-Key': createIdempotencyKey(),
  };
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: operationHeaders(),
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null) as T | ApiErrorPayload | null;
  if (!response.ok || !data) {
    const payload = data as ApiErrorPayload | null;
    const retryAfter = response.headers.get('Retry-After');
    const base = payload?.error ? securityErrorMessages[payload.error] ?? payload.error : `HTTP ${response.status}`;
    const retry = retryAfter ? `（${retryAfter} 秒后可重试）` : '';
    throw new Error(`${base}${retry}`);
  }
  return data as T;
}

export async function fetchSession(): Promise<SessionData> {
  const response = await fetch('/api/session', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data = await response.json().catch(() => null) as Partial<SessionData> | ApiErrorPayload | null;
  if (!response.ok || !data || !('auth_enabled' in data)) {
    const payload = data as ApiErrorPayload | null;
    throw new Error(payload?.error ? securityErrorMessages[payload.error] ?? payload.error : `HTTP ${response.status}`);
  }
  const authEnabled = Boolean(data.auth_enabled);
  return {
    ok: data.ok !== false,
    auth_enabled: authEnabled,
    auth_mode: data.auth_mode === 'local' ? 'local' : 'disabled',
    authenticated: typeof data.authenticated === 'boolean' ? data.authenticated : !authEnabled,
    email: typeof data.email === 'string' ? data.email : null,
    role: data.role === 'viewer' || data.role === 'operator' || data.role === 'admin' ? data.role : null,
    capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
  };
}

export async function loginWithPassword(password: string): Promise<SessionData> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Hermes-CSRF': '1',
    },
    credentials: 'same-origin',
    body: JSON.stringify({ password }),
  });
  const data = await response.json().catch(() => null) as ApiErrorPayload | null;
  if (!response.ok || !data?.ok) {
    const retryAfter = response.headers.get('Retry-After');
    const base = data?.error ? securityErrorMessages[data.error] ?? data.error : `HTTP ${response.status}`;
    const retry = retryAfter ? `（${retryAfter} 秒后可重试）` : '';
    throw new Error(`${base}${retry}`);
  }
  return fetchSession();
}

export async function logoutSession(): Promise<SessionData> {
  await postJson<{ ok: boolean }>('/api/auth/logout', {});
  return fetchSession();
}

async function getJson<T>(url: string, fallback: T): Promise<ApiState<T>> {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (response.status === 401 || response.status === 403) {
      const payload = await response.json().catch(() => null) as ApiErrorPayload | null;
      throw new Error(payload?.error ? securityErrorMessages[payload.error] ?? payload.error : `HTTP ${response.status}`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { data: await response.json() as T, offline: false };
  } catch (error) {
    if (error instanceof Error && /登录|权限/.test(error.message)) throw error;
    return {
      data: fallback,
      offline: true,
      error: error instanceof Error ? error.message : '网络请求失败',
    };
  }
}

export function fetchAgents() {
  return getJson<{ agents: AgentInfo[] }>('/api/agents', { agents: [] });
}

export function fetchActivity() {
  return getJson<{ items?: ActivityItem[]; events?: ActivityItem[] }>('/api/activity', { items: [] });
}

export function fetchEvolution() {
  return getJson<EvolutionData>('/api/evolution', {});
}

export function fetchCron() {
  return getJson<{ jobs: CronJob[]; total?: number; enabled?: number }>('/api/cron', { jobs: [], total: 0, enabled: 0 });
}

export function fetchTasks() {
  return getJson<TasksData>('/api/tasks', { total: 0, items: [] });
}

export async function sendMessage(agentId: string, message: string): Promise<MessageResponse> {
  try {
    const data = await postJson<MessageResponse>(
      '/api/messages',
      { agent_id: agentId, message },
    );
    if (!data.ok) throw new Error(data.error || '消息投递失败');
    return data;
  } catch (error) {
    if (import.meta.env.DEV) {
      throw error;
    }
    return { ok: false, agent_id: agentId, delivered: false, queued: false, channel: 'outbox', stored_at: new Date().toISOString(), message_preview: message.slice(0, 80), fallback_reason: 'delivery_unconfirmed', error: error instanceof Error ? error.message : '发送结果未确认' };
  }
}

export function fetchOutbox() {
  return getJson<OutboxData>('/api/outbox', { count: 0, items: [] });
}

export function fetchTopics() {
  return getJson<{ ok: boolean; topics: TopicItem[]; source: string }>(
    '/api/topics',
    { ok: true, topics: [], source: 'fallback' }
  );
}
export type TopicItem = { title: string; platform: string; reason: string; value: string };

export function fetchDelegationTasks(delegationId: string) {
  return getJson<DelegationTasksData>(
    `/api/delegation/${encodeURIComponent(delegationId)}/tasks`,
    { delegation_id: delegationId, available: false, tasks: [] }
  );
}

export async function retryOutbox(limit = 10, allowStale = false): Promise<OutboxRetryResponse> {
  const data = await postJson<OutboxRetryResponse>(
    '/api/outbox/retry',
    { limit, allow_stale: allowStale },
  );
  if (!data.ok) throw new Error('补投失败');
  return data;
}

export type PipelineStep = {
  agent_id: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'offline' | 'skipped';
  response_preview?: string;
  error?: string;
  reason?: string;
};

export type PipelineResult = {
  ok: boolean;
  status?: 'queued' | 'running' | 'completed' | 'failed';
  batch_id: string;
  steps: PipelineStep[];
  context_collected: Record<string, string>;
  final_report: string;
  synthesize_error?: string | null;
  pipeline_type: string;
  workspace_name: string;
};

export type TokenUsageData = {
  ok: boolean;
  available: boolean;
  date: string;
  total: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    total_tokens: number;
    saved_tokens: number;
    api_calls: number;
  };
  by_model: Array<{
    model: string;
    provider: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    api_calls: number;
    last_seen: string | null;
  }>;
};

export async function fetchTokenUsage() {
  return getJson<TokenUsageData>('/api/token-usage', {
    ok: true,
    available: false,
    date: '',
    total: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, total_tokens: 0, saved_tokens: 0, api_calls: 0 },
    by_model: [],
  });
}

export async function runExpertPipeline(
  workspaceName: string,
  goal: string,
  question: string,
  memberIds: string[],
  pipelineType: 'parallel' | 'serial'
): Promise<PipelineResult> {
  const data = await postJson<PipelineResult>(
    '/api/experts/pipeline',
    {
      workspace_name: workspaceName,
      goal,
      question,
      member_ids: memberIds,
      pipeline_type: pipelineType,
    },
  );
  if (!data.ok) throw new Error(`Pipeline failed: ${JSON.stringify(data)}`);
  return data;
}

export async function fetchExpertPipeline(batchId: string): Promise<PipelineResult> {
  const response = await fetch(`/api/experts/pipeline/${encodeURIComponent(batchId)}`, {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data = await response.json().catch(() => null) as (PipelineResult & { error?: string }) | null;
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
}

export async function waitForExpertPipeline(
  batchId: string,
  onUpdate?: (result: PipelineResult) => void,
): Promise<PipelineResult> {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const result = await fetchExpertPipeline(batchId);
    onUpdate?.(result);
    if (result.status === 'completed' || result.status === 'failed') return result;
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  throw new Error('专家流水线状态查询超时，请稍后按批次查看结果');
}

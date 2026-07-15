import type { ActivityItem, AgentInfo, ApiState, CronJob, EvolutionData, MessageResponse, OutboxData, OutboxRetryResponse, TaskItem, TasksData } from './types';

const mockAgents: AgentInfo[] = [
  { id: 'default', name: '小黑', status: 'online', port: 8642, port_listening: true, profile_available: true },
  { id: 'media-ops', name: '小橙', status: 'online', port: 8650, port_listening: true, profile_available: true },
  { id: 'investor', name: '小金', status: 'offline', port: 8660, port_listening: false, profile_available: true },
];

const mockActivity: ActivityItem[] = [
  { id: 1, message: '离线模拟：专家团已完成一次定价分析。' },
  { id: 2, message: '离线模拟：Cron 状态等待后端连接。' },
];

const mockEvolution: EvolutionData = {
  skills: { available: false, count: 0, recent: [{ name: '离线模拟：等待读取 skills 目录', modified_at: null }] },
  profiles: [],
};

const mockCron: CronJob[] = [
  { id: 'mock-1', name: '离线模拟：每日晨报', enabled: true, status: 'unknown', schedule: '0 8 * * *' },
];

const mockTasks: TaskItem[] = [
  { id: 'mock-running', title: '离线模拟：每日晨报', agent_id: 'default', status: 'running', source: 'cron', detail: '等待后端任务接口连接' },
  { id: 'mock-event', title: '离线模拟：Gateway 活动', status: 'event', source: 'gateway', detail: '当前展示离线预览数据' },
];

async function getJson<T>(url: string, fallback: T): Promise<ApiState<T>> {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { data: await response.json() as T, offline: false };
  } catch {
    return { data: fallback, offline: true };
  }
}

export function fetchAgents() {
  return getJson<{ agents: AgentInfo[] }>('/api/agents', { agents: mockAgents });
}

export function fetchActivity() {
  return getJson<{ items?: ActivityItem[]; events?: ActivityItem[] }>('/api/activity', { items: mockActivity });
}

export function fetchEvolution() {
  return getJson<EvolutionData>('/api/evolution', mockEvolution);
}

export function fetchCron() {
  return getJson<{ jobs: CronJob[]; total?: number; enabled?: number }>('/api/cron', { jobs: mockCron, total: 1, enabled: 1 });
}

export function fetchTasks() {
  return getJson<TasksData>('/api/tasks', { total: mockTasks.length, items: mockTasks });
}

export async function sendMessage(agentId: string, message: string): Promise<MessageResponse> {
  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ agent_id: agentId, message }),
    });
    const data = await response.json().catch(() => null) as MessageResponse | null;
    if (!response.ok || !data || !data.ok) {
      throw new Error(data?.error || `HTTP ${response.status}`);
    }
    return data;
  } catch (error) {
    if (import.meta.env.DEV) {
      throw error;
    }
    return { ok: true, agent_id: agentId, delivered: false, queued: true, channel: 'outbox', stored_at: new Date().toISOString(), message_preview: message.slice(0, 80), fallback_reason: 'preview-offline' };
  }
}

export function fetchOutbox() {
  return getJson<OutboxData>('/api/outbox', { count: 0, items: [] });
}

export async function retryOutbox(limit = 10): Promise<OutboxRetryResponse> {
  const response = await fetch('/api/outbox/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ limit }),
  });
  const data = await response.json().catch(() => null) as OutboxRetryResponse | null;
  if (!response.ok || !data || !data.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return data;
}

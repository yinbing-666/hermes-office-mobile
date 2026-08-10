export type AgentId = 'default' | 'media-ops' | 'investor';

export interface AgentInfo {
  id: AgentId;
  name: string;
  profile_path?: string;
  profile_available?: boolean;
  status: 'online' | 'offline' | 'busy' | string;
  port?: number;
  port_listening?: boolean;
  soul?: FileMeta;
  agent?: FileMeta;
}

export interface FileMeta {
  present: boolean;
  modified_at: string | null;
  size_bytes: number | null;
}

export interface ActivityItem {
  id: number | string;
  message: string;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  status: string;
  schedule?: string | null;
  next_run_at?: string | null;
  last_run_at?: string | null;
}

export type TaskStatus = 'running' | 'blocked' | 'completed' | 'queued' | 'failed' | 'paused' | 'event';

export interface TaskItem {
  id: string;
  title: string;
  agent_id?: string | null;
  status: TaskStatus;
  source: 'cron' | 'outbox' | 'sent' | 'gateway' | 'kanban' | string;
  time?: string | null;
  detail?: string | null;
  fallback_reason?: string | null;
  kanban_status?: string | null;
  kanban_id?: string | null;
  latest_comment?: string | null;
  heartbeat_at?: string | null;
  block_kind?: string | null;
  session_id?: string | null;
  action_url?: string | null;
  priority?: number | string | null;
  delegation_id?: string | null;
}

export interface TasksData {
  total: number;
  status_counts?: Partial<Record<TaskStatus, number>>;
  items: TaskItem[];
}

export interface EvolutionData {
  skills?: {
    available: boolean;
    count: number;
    recent: Array<{ name: string; modified_at: string | null }>;
  };
  profiles?: Array<{
    profile: string;
    name: string;
    profile_available: boolean;
    soul: FileMeta;
    agent: FileMeta;
  }>;
  trend?: Array<{
    date: string;
    skill_changes: number;
    profile_changes: number;
    total_changes: number;
  }>;
  milestones?: Array<{
    title: string;
    date: string;
    type: 'commit' | 'profile' | 'skill' | string;
    description: string;
  }>;
  skill_tree?: Array<{
    key: 'messaging' | 'knowledge' | 'development' | 'automation' | string;
    title: string;
    children: Array<{ name: string; modified_at: string | null }>;
  }>;
  capabilities?: Array<{
    name: string;
    matched: Array<{ name: string; modified_at: string | null }>;
  }>;
}

export interface MessageResponse {
  ok: boolean;
  agent_id: string;
  delivered: boolean;
  queued: boolean;
  channel: 'api_server' | 'outbox';
  message_preview: string;
  stored_at: string;
  response_preview?: string;
  fallback_reason?: string;
  error?: string;
}

export interface OutboxItem {
  id: number | string;
  agent_id: string;
  message_preview: string;
  stored_at?: string | null;
  fallback_reason?: string | null;
}

export interface OutboxData {
  count: number;
  items: OutboxItem[];
  stale_count?: number;
  stale_after_hours?: number;
}

export interface DelegationTask {
  index: number;
  goal: string;
  status: string;
  log_summary: string;
}

export interface DelegationTasksData {
  delegation_id: string;
  available: boolean;
  tasks: DelegationTask[];
}

export interface OutboxRetryResponse {
  ok: boolean;
  attempted: number;
  delivered: number;
  remaining: number;
  generated_at: string;
  skipped_stale?: number;
  failures?: Array<{ id?: number | string; agent_id: string; fallback_reason: string }>;
}

export interface ApiState<T> {
  data: T;
  offline: boolean;
  error?: string;
}

export type GrowthRecordType = 'growth' | 'decision' | 'pitfall' | 'review' | 'idea' | 'case' | 'skill' | 'knowledge';

export interface GrowthRecord {
  id: string;
  type: unknown;
  title: string;
  date: string | null;
  status: string;
  source: string;
}

export interface GrowthData {
  generated_at: string;
  available: boolean;
  total: number;
  summary: Partial<Record<string, number>>;
  records: GrowthRecord[];
}

export interface KnowledgeData {
  generated_at: string;
  available: boolean;
  counts: { 来源: number; 概念: number; 对比: number; 实体: number; 想法: number };
  total: number;
  trend: Array<{ date: string; files_added: number }>;
  recent_commits: GrowthRecord[];
}

export interface UsageDay {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  api_calls: number;
}

export interface UsageTrendData {
  ok: boolean;
  available: boolean;
  days: UsageDay[];
  total_calls: number;
  today?: UsageDay;
}

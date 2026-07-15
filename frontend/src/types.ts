export type AgentId = 'default' | 'media-ops' | 'investor' | string;

export interface AgentInfo {
  id: AgentId;
  name: string;
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
}

export interface OutboxRetryResponse {
  ok: boolean;
  attempted: number;
  delivered: number;
  remaining: number;
  generated_at: string;
  failures?: Array<{ id?: number | string; agent_id: string; fallback_reason: string }>;
}

export interface ApiState<T> {
  data: T;
  offline: boolean;
}

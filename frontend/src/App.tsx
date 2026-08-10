import { useEffect, useMemo, useState } from 'react';
import { fetchAgents, fetchEvolution, fetchTasks, sendMessage, fetchSession, loginWithPassword, logoutSession, fetchTokenUsage, fetchGrowth, fetchKnowledge, fetchUsageTrend, fetchHealth } from './api';
import { OfficeIcon, type OfficeIconName } from './components/OfficeIcon';
import { LoginPage } from './LoginPage';
import type { AgentInfo, EvolutionData, GrowthData, KnowledgeData, TaskItem, TaskStatus, UsageTrendData } from './types';
import type { SessionData, TokenUsageData } from './api';

type Tab = 'office' | 'agent' | 'evolution' | 'knowledge' | 'cost';
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

type RoleMeta = { role: string; focus: string; tone: string; avatar: string; tags: string[] };
type ExpertAgentId = 'default' | 'media-ops' | 'investor';
type ExpertDeliveryStatus = 'delivered' | 'queued' | 'failed';
type ExpertDeliveryResult = { agentId: ExpertAgentId; status: ExpertDeliveryStatus; error?: string; responsePreview?: string };
type ChannelHealth = { id: string; name: string; port: number; online: boolean; timeout_seconds: number; last_error_reason?: string | null; recovery_hint?: string | null };
type ResourceState = { status: 'loading' | 'success' | 'error'; error?: string };

const initialGrowth: GrowthData = { generated_at: '', available: false, total: 0, summary: {}, records: [] };
const initialKnowledge: KnowledgeData = { generated_at: '', available: false, counts: { 来源: 0, 概念: 0, 对比: 0, 实体: 0, 想法: 0 }, total: 0, trend: [], recent_commits: [] };
const initialUsageTrend: UsageTrendData = { ok: true, available: false, days: [], total_calls: 0 };
const initialTokenUsage: TokenUsageData = { ok: true, available: false, date: '', total: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, total_tokens: 0, saved_tokens: 0, api_calls: 0 }, by_model: [] };
const initialResourceState: ResourceState = { status: 'loading' };

const fallbackRole: RoleMeta = { role: 'Hermes 智能员工', focus: '自定义智能员工', tone: 'blue', avatar: '', tags: ['任务执行', '协作响应'] };

const agentNameMap: Record<string, string> = {
  default: '小黑',
  'media-ops': '小橙',
  investor: '小金',
};

const expertPanelAgents: Array<{ id: ExpertAgentId; name: string; perspective: string; prompt: string }> = [
  { id: 'default', name: '小黑', perspective: '主控汇总视角', prompt: '请从主控汇总视角梳理问题、协调判断，并形成可供后续汇总的执行意见。' },
  { id: 'media-ops', name: '小橙', perspective: '内容传播视角', prompt: '请从内容传播视角分析受众、表达、渠道与传播执行重点。' },
  { id: 'investor', name: '小金', perspective: '商业风险视角', prompt: '请从商业风险视角分析价值、成本、回报、约束与潜在风险。' },
];

function SessionLoadingPage() {
  return (
    <main className="login-shell">
      <section className="login-panel" aria-busy="true" aria-labelledby="session-loading-title">
        <div className="login-brand" aria-hidden="true">
          <OfficeIcon name="office" size={24} />
        </div>
        <p className="login-kicker">HERMES OFFICE</p>
        <h1 id="session-loading-title">正在打开办公室</h1>
        <p className="login-copy" role="status">正在确认登录状态…</p>
      </section>
    </main>
  );
}

const issueReasonMap: Record<string, string> = {
  api_request_failed: 'Hermes 通道请求失败',
  api_key_unavailable: '鉴权配置待恢复',
  api_server_offline: 'Hermes 服务未连接',
  delivery_unconfirmed: '发送结果未确认，请勿重复提交',
  profile_not_found: '员工档案未找到',
  stale_outbox_requires_confirmation: '存在超过 48 小时的旧消息，自动补投已阻止',
};

const roleMap: Record<string, RoleMeta> = {
  default: {
    role: '主控与知识系统',
    focus: '调度专家团、维护知识库、派发开发任务',
    tone: 'slate',
    avatar: '/avatars/default.webp?v=2',
    tags: ['知识库维护', '专家团调度', 'Codex派发', '浏览器验收'],
  },
  'media-ops': {
    role: '内容与媒体运营',
    focus: '负责选题、内容改写与多平台分发',
    tone: 'blue',
    avatar: '/avatars/media-ops.webp?v=2',
    tags: ['内容选题', '视频理解', '多平台分发', '文案改写'],
  },
  investor: {
    role: '商业与投资分析',
    focus: '负责定价、商业模式与收益风险判断',
    tone: 'sand',
    avatar: '/avatars/investor.webp?v=2',
    tags: ['商业分析', 'ROI判断', '定价策略', '风险评估'],
  },
};

const tabs: Array<{ key: Tab; label: string; icon: OfficeIconName }> = [
  { key: 'office', label: '办公室', icon: 'office' },
  { key: 'agent', label: '员工', icon: 'agent' },
  { key: 'evolution', label: '进化', icon: 'growth' },
  { key: 'knowledge', label: '知识库', icon: 'search' },
  { key: 'cost', label: '成本', icon: 'activity' },
];

const growthTypeLabels: Record<string, { label: string; icon: OfficeIconName }> = {
  growth: { label: '成长', icon: 'growth' },
  decision: { label: '决策', icon: 'check' },
  pitfall: { label: '踩坑', icon: 'alert' },
  review: { label: '复盘', icon: 'activity' },
  idea: { label: '想法', icon: 'search' },
  case: { label: '案例', icon: 'file' },
  skill: { label: '技能', icon: 'terminal' },
  knowledge: { label: '知识', icon: 'database' },
};


const taskStatusMeta: Record<TaskStatus, { label: string; icon: OfficeIconName }> = {
  running: { label: '进行中', icon: 'clock' },
  blocked: { label: '阻塞', icon: 'alert' },
  completed: { label: '已完成', icon: 'check' },
  queued: { label: '待补投', icon: 'database' },
  failed: { label: '失败', icon: 'alert' },
  paused: { label: '已暂停', icon: 'alert' },
  event: { label: '事件', icon: 'activity' },
};

const taskSourceLabels: Record<string, string> = { cron: '定时任务', outbox: '兜底队列', sent: '已送达', gateway: '网关事件', kanban: '智能看板' };

function formatTime(value?: string | null) {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatAttemptTime(value?: string | null) {
  if (!value) return '尚未尝试';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatAgentName(agentId?: string | null) {
  if (!agentId) return '';
  return agentNameMap[agentId] ?? agentId;
}

function ResourceStateCard({ state, onRetry, label }: { state: ResourceState; onRetry: () => void; label: string }) {
  if (state.status === 'loading') {
    return <div className="resource-state-card" role="status"><OfficeIcon name="clock" size={18} /><div><strong>正在加载{label}…</strong><small>请稍候</small></div></div>;
  }
  return (
    <div className="resource-state-card error" role="alert">
      <OfficeIcon name="alert" size={18} />
      <div><strong>{label}加载失败</strong><small>{state.error || '暂时无法读取数据，请稍后重试。'}</small></div>
      <button type="button" onClick={onRetry}><OfficeIcon name="refresh" size={14} />重试</button>
    </div>
  );
}

function isIssueCode(value?: string | null) {
  if (!value) return false;
  return Boolean(issueReasonMap[value]) || /^[a-z0-9]+(?:_[a-z0-9]+)+$/i.test(value);
}

function formatIssueReason(value?: string | null) {
  if (!value) return '';
  return issueReasonMap[value] ?? (isIssueCode(value) ? `异常原因：${value.split('_').join(' ')}` : value);
}

function formatTechnicalMeta(parts: Array<string | null | undefined>) {
  const technicalParts = parts.filter((part): part is string => Boolean(part));
  return technicalParts.length > 0 ? `技术信息：${technicalParts.join(' · ')}` : '';
}

function formatTaskDetail(task: TaskItem, emptyText: string) {
  if (task.detail) return formatIssueReason(task.detail);
  if (task.fallback_reason) return formatIssueReason(task.fallback_reason);
  return emptyText;
}

function formatTaskTechnicalMeta(task: TaskItem) {
  return formatTechnicalMeta([
    task.agent_id ? `员工标识 ${task.agent_id}` : null,
    task.fallback_reason ? `原始原因 ${task.fallback_reason}` : null,
    task.kanban_status ? `看板状态 ${task.kanban_status}` : null,
    task.heartbeat_at ? `心跳 ${formatTime(task.heartbeat_at)}` : null,
  ]);
}

function safeTaskFieldText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return typeof value === 'object' ? JSON.stringify(value) ?? '' : String(value);
  } catch {
    return '';
  }
}

function taskContainsText(task: TaskItem, query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return false;
  const taskFields = task as TaskItem & Record<string, unknown>;
  return ['title', 'detail', 'source', 'technical_message', 'fallback_reason']
    .some((field) => safeTaskFieldText(taskFields[field]).toLocaleLowerCase().includes(normalizedQuery));
}

function sortTasksByRecent(tasks: TaskItem[]) {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const leftTime = left.task.time ? new Date(left.task.time).getTime() : 0;
      const rightTime = right.task.time ? new Date(right.task.time).getTime() : 0;
      return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime) || left.index - right.index;
    })
    .map(({ task }) => task);
}

async function fetchChannelHealth(): Promise<ChannelHealth[]> {
  const response = await fetch('/api/health', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as { channels?: ChannelHealth[] };
  return data.channels ?? [];
}

function StatusPill({ status }: { status: string }) {
  const online = status === 'online';
  return (
    <span className={`pill ${online ? 'online' : 'offline'}`}>
      <span className="status-dot" />
      {online ? '在线' : '离线'}
    </span>
  );
}

function OfflineBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="offline-banner">
      <OfficeIcon name="alert" size={17} />
      <span><strong>后端暂时离线。</strong> 当前不显示在线、送达或完成状态；连接恢复后再读取真实数据。</span>
    </div>
  );
}

function MobileAccessCard({ installPrompt, installed, onInstall }: { installPrompt: BeforeInstallPromptEvent | null; installed: boolean; onInstall: () => void }) {
  const isIos = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);
  const installHint = installed
    ? '已从主屏幕运行，可像普通 App 一样继续使用。'
    : isIos
      ? '在 Safari 点“分享”，再选“添加到主屏幕”。'
      : '也可在浏览器菜单中选择“添加到主屏幕”。';

  return (
    <aside className="mobile-access-card" aria-label="手机访问说明">
      <div className="mobile-access-icon"><OfficeIcon name="monitor" size={18} /></div>
      <div>
        <strong>手机访问</strong>
        <p>同一 Tailnet 打开 <code>http://100.99.196.3:5176/</code></p>
        <small>{installHint}</small>
      </div>
      {installPrompt && !installed ? <button onClick={onInstall}>安装</button> : null}
    </aside>
  );
}

function AgentPortrait({ tone, avatar, name, large = false }: { tone: string; avatar?: string; name: string; large?: boolean }) {
  return (
    <div className={`agent-portrait tone-${tone} ${large ? 'large' : ''}`}>
      {avatar ? <img src={avatar} alt={`${name}头像`} loading="lazy" /> : <OfficeIcon name="agent" size={large ? 36 : 26} />}
    </div>
  );
}

function AgentCard({ agent, active, onClick }: { agent: AgentInfo; active: boolean; onClick: () => void }) {
  const meta = roleMap[agent.id] ?? fallbackRole;
  return (
    <button className={`workstation-card ${active ? 'active' : ''}`} onClick={onClick}>
      <div className="desk-scene">
        <AgentPortrait tone={meta.tone} avatar={meta.avatar} name={agent.name} />
      </div>
      <div className="agent-main">
        <div className="agent-row">
          <strong>{agent.name}</strong>
          <StatusPill status={agent.status} />
        </div>
        <p>{meta.role}</p>
        <small>{meta.focus}</small>
      </div>
      <OfficeIcon name="chevron" size={18} className="card-chevron" />
    </button>
  );
}

function VirtualOfficeCard({ onSelectAgent }: { onSelectAgent: (agentId: string) => void }) {
  return (
    <div className="virtual-office-card" aria-label="虚拟办公室空间示意">
      <div className="virtual-office-heading">
        <div>
          <p className="section-kicker">Virtual Workspace</p>
          <h2>今日办公室</h2>
        </div>
        <span><i />协作空间</span>
      </div>
      <div className="office-legend" aria-label="办公室分区图例">
        <span><i className="kitchen" />茶水</span>
        <span><i className="fitness" />健身</span>
        <span><i className="workstation" />工位</span>
      </div>
      <div className="office-room">
        <img className="office-scene-bg" src="/images/office-scene.webp?v=2" alt="" />
        <div className="office-world" aria-hidden="true" />
        <div className="office-annotations" aria-label="办公室分区与员工坐席">
          <span className="office-callout zone-callout kitchen-callout">茶水区 / 厨房</span>
          <span className="office-callout zone-callout fitness-callout">健身区 / 跑步机</span>
          <span className="office-callout zone-callout workstation-callout">办公工位区</span>
          <button type="button" className="office-callout seat-callout control-callout" onClick={() => onSelectAgent('default')}>主控位 · 小黑</button>
          <button type="button" className="office-callout seat-callout content-callout" onClick={() => onSelectAgent('media-ops')}>内容位 · 小橙</button>
          <button type="button" className="office-callout seat-callout business-callout" onClick={() => onSelectAgent('investor')}>商业位 · 小金</button>
        </div>
      </div>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function ResourceTaskOverview({ tasks }: { tasks: TaskItem[] }) {
  const [tokenData, setTokenData] = useState<{ total: number; byModel: Array<{model: string; tokens: number}>; loaded: boolean }>({ total: 0, byModel: [], loaded: false });

  useEffect(() => {
    fetchTokenUsage().then((res) => {
      if (res.data?.available) {
        const byModel: Array<{model: string; tokens: number}> = [];
        const modelMap = new Map<string, number>();
        for (const m of res.data.by_model ?? []) {
          const total = (m.input_tokens || 0) + (m.output_tokens || 0);
          if (total > 0) {
            modelMap.set(m.model, (modelMap.get(m.model) || 0) + total);
          }
        }
        for (const [model, tokens] of modelMap) {
          byModel.push({ model, tokens });
        }
        byModel.sort((a, b) => b.tokens - a.tokens);
        setTokenData({ total: res.data.total.total_tokens, byModel, loaded: true });
      } else {
        setTokenData(prev => ({ ...prev, loaded: true }));
      }
    }).catch(() => setTokenData(prev => ({ ...prev, loaded: true })));
  }, []);

  const counts = useMemo(() => {
    let runningCount = 0, completedCount = 0;
    for (const t of tasks) {
      if (t.status === 'running') runningCount++;
      else if (t.status === 'completed') completedCount++;
    }
    return { runningCount, completedCount };
  }, [tasks]);
  const { runningCount, completedCount } = counts;
  const recentTasks = tasks.slice(0, 8);

  return (
    <div className="resource-task-card">
      <div className="resource-task-heading">
        <div>
          <p className="section-kicker">Resource & Tasks</p>
          <h2>资源与任务概览</h2>
        </div>
        <div className="resource-task-icon"><OfficeIcon name="activity" size={19} /></div>
      </div>
      <div className="token-metrics">
        <div>
          <span>今日消耗 Token</span>
          <strong>{tokenData.loaded ? formatNum(tokenData.total) : '…'}</strong>
          <small>{tokenData.loaded ? '' : '加载中'}</small>
        </div>
      </div>
      {tokenData.loaded && tokenData.byModel.length > 0 && (
        <div className="token-model-list">
          {tokenData.byModel.map(m => (
            <div key={m.model} className="token-model-row">
              <span className="token-model-name">{m.model}</span>
              <span className="token-model-val">{formatNum(m.tokens)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="office-task-stats">
        <div><span>进行中</span><strong>{runningCount}</strong></div>
        <div><span>已完成</span><strong>{completedCount}</strong></div>
        <div><span>总计</span><strong>{tasks.length}</strong></div>
      </div>
      <div className="office-recent-tasks">
        <div className="office-recent-heading"><strong>最近任务</strong><span>{recentTasks.length} 条摘要</span></div>
        {recentTasks.length > 0 ? recentTasks.map((task) => {
          const meta = taskStatusMeta[task.status];
          return (
            <div className="office-recent-task" key={task.id}>
              <div className={`task-check ${task.status}`}><OfficeIcon name={meta.icon} size={14} /></div>
              <div>
                <div><strong>{task.title}</strong><span className={`task-status ${task.status}`}>{meta.label}</span></div>
                <p>{formatTaskDetail(task, '暂无任务详情')}</p>
                <small>{task.agent_id ? `${formatAgentName(task.agent_id)} · ` : ''}{taskSourceLabels[task.source] ?? task.source} · {formatTime(task.time)}</small>
              </div>
            </div>
          );
        }) : <div className="office-task-empty"><OfficeIcon name="clock" size={16} /><span>最近任务待记录</span></div>}
      </div>
    </div>
  );
}

function ChannelHealthCard({ channels }: { channels: ChannelHealth[] }) {
  const expectedChannels: ChannelHealth[] = channels.length > 0 ? channels : [
    { id: 'default', name: 'default', port: 8642, online: false, timeout_seconds: 45, recovery_hint: '需要启动 profile gateway' },
    { id: 'media-ops', name: 'media-ops', port: 8650, online: false, timeout_seconds: 45, recovery_hint: '需要启动 profile gateway' },
    { id: 'investor', name: 'investor', port: 8660, online: false, timeout_seconds: 45, recovery_hint: '需要启动 profile gateway' },
    { id: 'bff', name: 'BFF', port: 8787, online: false, timeout_seconds: 45 },
  ];
  return (
    <div className="channel-health-card">
      <div className="section-heading"><div><p className="section-kicker">Channel Health</p><h2>通道健康</h2></div><span>timeout=45s</span></div>
      <div className="channel-health-grid">
        {expectedChannels.map((channel) => (
          <div className={channel.online ? 'online' : 'offline'} key={channel.id}>
            <span className="channel-health-dot" />
            <div><strong>{channel.id === 'bff' ? 'BFF' : channel.id}</strong><small>端口 {channel.port}</small></div>
            <em>{channel.online ? '在线' : '离线'}</em>
            {!channel.online ? <p>{channel.id === 'bff' ? '需要启动 BFF' : channel.recovery_hint || '需要启动 profile gateway'}</p> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function HomeTaskFocus({ tasks, onOpenTasks }: { tasks: TaskItem[]; onOpenTasks: () => void }) {
  const priorityTasks = tasks.filter((task) => task.status === 'blocked' || task.status === 'running').slice(0, 6);
  return (
    <div className="home-focus-card">
      <div className="section-heading">
        <div><p className="section-kicker">Today</p><h2>今日待处理</h2></div>
        <button className="section-action" type="button" onClick={onOpenTasks}>查看任务</button>
      </div>
      {priorityTasks.length > 0 ? (
        <div className="home-task-list">
          {priorityTasks.map((task) => {
            const meta = taskStatusMeta[task.status];
            return (
              <button className="home-task-row" type="button" key={task.id} onClick={onOpenTasks}>
                <span className={`task-check ${task.status}`}><OfficeIcon name={meta.icon} size={15} /></span>
                <span className="home-task-copy">
                  <strong>{task.title}</strong>
                  <small>{task.status === 'blocked' ? '等待处理' : '正在执行'} · {task.agent_id ? formatAgentName(task.agent_id) : '未指定'}</small>
                </span>
                <OfficeIcon name="chevron" size={16} />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="home-focus-empty" role="status">
          <OfficeIcon name="check" size={17} />
          <span>当前没有阻塞或运行中的任务。</span>
        </div>
      )}
    </div>
  );
}

function QuickDispatchCard({ agents, onSelectAgent }: { agents: AgentInfo[]; onSelectAgent: (agentId: string) => void }) {
  return (
    <div className="quick-dispatch-card">
      <div className="section-heading">
        <div><p className="section-kicker">Quick Dispatch</p><h2>快速派活</h2></div>
        <span>选择员工后输入任务</span>
      </div>
      {agents.filter((a) => a.status !== 'offline').length > 0 ? (
        <div className="quick-dispatch-list">
          {agents.filter((a) => a.status !== 'offline').map((agent) => {
            const meta = roleMap[agent.id] ?? fallbackRole;
            return (
              <button className="quick-dispatch-button" type="button" key={agent.id} onClick={() => onSelectAgent(agent.id)} aria-label={`给${agent.name}派活`}>
                <AgentPortrait tone={meta.tone} avatar={meta.avatar} name={agent.name} />
                <span><strong>给{agent.name}派活</strong><small>{meta.role}</small></span>
                <OfficeIcon name="chevron" size={16} />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="home-focus-empty" role="status">
          <OfficeIcon name="agent" size={17} />
          <span>员工状态未知，连接恢复后才能派活。</span>
        </div>
      )}
    </div>
  );
}

function OfficePage({ agents, tasks, selectedId, onSelectAgent, onOpenTasks, backendOffline, loading, usageTrend, knowledge, costState, knowledgeState }: { agents: AgentInfo[]; tasks: TaskItem[]; selectedId: string; onSelectAgent: (agentId: string) => void; onOpenTasks: () => void; backendOffline: boolean; loading: boolean; usageTrend: UsageTrendData; knowledge: KnowledgeData; costState: ResourceState; knowledgeState: ResourceState }) {
  const online = agents.filter((agent) => agent.status === 'online').length;
  const offline = Math.max(agents.length - online, 0);
  const hasAgentStatus = agents.length > 0;
  const blocked = tasks.filter((task) => task.status === 'blocked').length;
  const running = tasks.filter((task) => task.status === 'running').length;
  const shanghaiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const todayCalls = costState.status === 'success' ? usageTrend.today?.api_calls ?? '—' : '—';
  const todayIngest = knowledgeState.status === 'success' ? knowledge.trend?.find((item) => item.date === shanghaiToday)?.files_added ?? '—' : '—';
  const knowledgeTotal = knowledgeState.status === 'success' ? knowledge.total ?? '—' : '—';
  return (
    <section className="page-section">
      <div className="office-overview">
        <div className="overview-heading">
          <div className="overview-mark"><OfficeIcon name="office" size={24} /></div>
          <div>
            <p className="eyebrow">Hermes Workspace</p>
            <h1>Hermes 办公室</h1>
          </div>
        </div>
        <p className="overview-copy">集中查看智能员工状态、职责与待处理任务。</p>
        <div className="status-overview">
          <div><span className="metric-dot online" /><strong>{hasAgentStatus ? online : '—'}</strong><small>在线员工</small></div>
          <div><span className="metric-dot offline" /><strong>{hasAgentStatus ? offline : '—'}</strong><small>离线员工</small></div>
          <div><span className="metric-dot pending" /><strong>{blocked + running}</strong><small>待处理任务</small></div>
        </div>
        <div className="today-overview">
          <div><strong>{todayCalls}</strong><small>今日 API 调用</small></div>
          <div><strong>{todayIngest}</strong><small>今日知识入库</small></div>
          <div><strong>{knowledgeTotal}</strong><small>知识库总量</small></div>
        </div>
      </div>
      <VirtualOfficeCard onSelectAgent={onSelectAgent} />
      <HomeTaskFocus tasks={tasks} onOpenTasks={onOpenTasks} />
      <QuickDispatchCard agents={agents} onSelectAgent={onSelectAgent} />
      <div className="section-heading">
        <div>
          <p className="section-kicker">Office Floor</p>
          <h2>智能员工</h2>
        </div>
        <span>{agents.length} 位员工</span>
      </div>
      <div className="agent-list">
        {loading ? <div className="empty-card offline-empty" role="status">正在读取员工数据…</div> : agents.length === 0 ? (
          <div className="empty-card offline-empty">
            <OfficeIcon name={backendOffline ? 'alert' : 'agent'} size={19} />
            <span>{backendOffline ? '后端离线且暂无缓存数据，其他页面仍可继续浏览。' : '暂无员工数据。'}</span>
          </div>
        ) : agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} active={agent.id === selectedId} onClick={() => onSelectAgent(agent.id)} />
        ))}
      </div>
    </section>
  );
}

function AgentPage({ agents, selectedId, onSelectAgent, agent, tasks, evolution, cameFromOffice, onBack, loading }: { agents: AgentInfo[]; selectedId: string; onSelectAgent: (id: string) => void; agent?: AgentInfo; tasks: TaskItem[]; evolution: EvolutionData; cameFromOffice?: boolean; onBack?: () => void; loading: boolean }) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState<{ type: 'sent' | 'error'; text: string } | null>(null);
  const recentTasks = useMemo(() => {
    if (!agent) return [];
    return tasks
      .filter((task) => task.agent_id === agent.id)
      .map((task, index) => ({ task, index }))
      .sort((left, right) => {
        const leftTime = left.task.time ? new Date(left.task.time).getTime() : 0;
        const rightTime = right.task.time ? new Date(right.task.time).getTime() : 0;
        const timeDifference = (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
        return timeDifference || left.index - right.index;
      })
      .slice(0, 5)
      .map(({ task }) => task);
  }, [agent, tasks]);

  useEffect(() => {
    setMessage('');
    setSendStatus(null);
  }, [agent?.id]);

  if (loading) return <div className="empty-card" role="status">正在读取员工数据…</div>;
  if (!agent) return <div className="empty-card">暂无员工数据。</div>;
  const meta = roleMap[agent.id] ?? fallbackRole;
  const evolutionProfile = evolution.profiles?.find((profile) => profile.profile === agent.id);
  const soul = evolutionProfile?.soul ?? agent.soul;
  const agentGuide = evolutionProfile?.agent ?? agent.agent;
  const latestTask = recentTasks[0];
  const latestTaskMeta = latestTask ? taskStatusMeta[latestTask.status] : null;
  const portListening = agent.port_listening ?? agent.status === 'online';
  const latestProfileUpdate = [soul?.modified_at, agentGuide?.modified_at]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0];

  async function handleSend() {
    const task = message.trim();
    if (!task || sending || !agent) return;
    setSending(true);
    setSendStatus(null);
    try {
      const result = await sendMessage(agent.id, task);
      setMessage('');
      const statusText = result.delivered
        ? '已发送到 Hermes'
        : result.queued
          ? '已确认进入兜底队列'
          : formatIssueReason(result.fallback_reason) || '发送结果未确认，请勿重复提交';
      setSendStatus({
        type: result.delivered || result.queued ? 'sent' : 'error',
        text: statusText + ' · ' + formatTime(result.stored_at),
      });
    } catch (error) {
      setSendStatus({ type: 'error', text: error instanceof Error ? error.message : '发送失败，请稍后重试' });
    } finally {
      setSending(false);
    }
  }

  const shouldShowBack = Boolean(cameFromOffice && onBack);
  const handleBack = () => {
    if (!onBack) return;
    onBack();
  };

  return (
    <section className={`page-section agent-page-slide${cameFromOffice ? ' slide-in' : ''}`}>
      {shouldShowBack && (
        <div className="agent-back-wrap">
          <button className="agent-back-btn" type="button" onClick={handleBack}>
            <OfficeIcon name="chevron" size={16} />
            <span>返回办公室</span>
          </button>
        </div>
      )}
      <div className="detail-card employee-hero">
        <div className="employee-identity">
          <AgentPortrait tone={meta.tone} avatar={meta.avatar} name={agent.name} large />
          <div>
            <p className="eyebrow">Employee Profile</p>
            <div className="detail-name">
              <h2>{agent.name}</h2>
              <StatusPill status={agent.status} />
            </div>
            <p>{meta.role}</p>
            <small>{meta.focus}</small>
          </div>
        </div>
        <div className="capability-tags" aria-label={`${agent.name}能力标签`}>
          {meta.tags.map((tag) => <span key={tag}>{tag}</span>)}
        </div>
      </div>

      <div className="employee-section-card">
        <div className="employee-section-head">
          <div className="employee-section-icon"><OfficeIcon name="agent" size={18} /></div>
          <div><span>Team Directory</span><h3>员工目录</h3></div>
          <small>{agents.length} 位</small>
        </div>
        <div className="workspace-member-options" role="tablist" aria-label="切换员工">
          {agents.map((item) => {
            const itemMeta = roleMap[item.id] ?? fallbackRole;
            const selected = item.id === selectedId;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={selected ? 'selected' : ''}
                onClick={() => onSelectAgent(item.id)}
              >
                <i className={item.id} />
                <span>
                  <strong>{item.name}</strong>
                  <small>{itemMeta.role}</small>
                </span>
                <OfficeIcon name={selected ? 'check' : 'user'} size={15} />
              </button>
            );
          })}
        </div>
      </div>

      <div className="employee-section-card">
        <div className="employee-section-head">
          <div className="employee-section-icon"><OfficeIcon name="monitor" size={18} /></div>
          <div><span>Current Status</span><h3>当前状态</h3></div>
        </div>
        <div className="employee-status-grid">
          <div><span>连接状态</span><strong className={agent.status === 'online' ? 'status-online' : 'status-offline'}>{agent.status === 'online' ? '在线' : '离线'}</strong><small>{portListening ? '服务端口可连接' : '等待服务恢复'}</small></div>
          <div><span>服务端口</span><strong>{agent.port ?? '未配置'}</strong><small>{agent.port ? `员工档案已关联 · 技术标识 ${agent.id}` : '尚未登记端口'}</small></div>
          <div><span>最近任务</span><strong>{latestTaskMeta?.label ?? '待记录'}</strong><small>{latestTask?.title ?? '暂无该员工任务'}</small></div>
        </div>
      </div>

      <div className="employee-section-card">
        <div className="employee-section-head">
          <div className="employee-section-icon"><OfficeIcon name="activity" size={18} /></div>
          <div><span>Recent Tasks</span><h3>最近任务</h3></div>
          <small>{recentTasks.length > 0 ? `最近 ${recentTasks.length} 条` : '待记录'}</small>
        </div>
        {recentTasks.length > 0 ? (
          <div className="agent-task-list">
            {recentTasks.map((task) => {
              const taskMeta = taskStatusMeta[task.status];
              return (
                <div className="agent-task-item" key={task.id}>
                  <div className={`task-check ${task.status}`}><OfficeIcon name={taskMeta.icon} size={15} /></div>
                  <div>
                    <div><strong>{task.title}</strong><span className={`task-status ${task.status}`}>{taskMeta.label}</span></div>
                    <p>{formatTaskDetail(task, '任务详情待补充')}</p>
                    <small>{taskSourceLabels[task.source] ?? task.source} · {formatTime(task.time)}{formatTaskTechnicalMeta(task) ? ` · ${formatTaskTechnicalMeta(task)}` : ''}</small>
                  </div>
                </div>
              );
            })}
          </div>
        ) : <div className="agent-empty-state"><OfficeIcon name="clock" size={18} /><span>最近任务待记录</span></div>}
      </div>

      <div className="employee-section-card">
        <div className="employee-section-head">
          <div className="employee-section-icon"><OfficeIcon name="file" size={18} /></div>
          <div><span>Work Assets</span><h3>最近产出与档案</h3></div>
          <small>{latestProfileUpdate ? `更新于 ${formatTime(latestProfileUpdate)}` : '尚未更新'}</small>
        </div>
        <div className="employee-assets-grid">
          <div className={soul?.present ? 'ready' : ''}>
            <span className="asset-icon"><OfficeIcon name="user" size={18} /></span>
            <div><strong>人格档案</strong><p>角色边界、沟通风格与长期偏好</p><small>{soul?.present ? `SOUL.md · 已归档 · ${formatTime(soul.modified_at)}` : 'SOUL.md · 待建立档案'}</small></div>
          </div>
          <div className={agentGuide?.present ? 'ready' : ''}>
            <span className="asset-icon"><OfficeIcon name="terminal" size={18} /></span>
            <div><strong>执行手册</strong><p>工作流程、工具约束与交付标准</p><small>{agentGuide?.present ? `AGENT.md · 已归档 · ${formatTime(agentGuide.modified_at)}` : 'AGENT.md · 待建立手册'}</small></div>
          </div>
        </div>
      </div>
      <div className="compose-card">
        <div className="card-title-row">
          <OfficeIcon name="message" size={19} />
          <label htmlFor="agent-task">派活入口</label>
        </div>
        <textarea
          id="agent-task"
          value={message}
          maxLength={4000}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={`给${agent.name}发一条任务`}
        />
        <button disabled={sending || !message.trim()} onClick={handleSend}>
          <OfficeIcon name="send" size={17} />
          {sending ? '正在发送…' : '发送任务'}
        </button>
        {sendStatus && <p className={`send-status ${sendStatus.type}`} role="status">{sendStatus.text}</p>}
      </div>
    </section>
  );
}

function EvolutionPage({ evolution, growth, growthState, onRetryGrowth }: { evolution: EvolutionData; growth: GrowthData; growthState: ResourceState; onRetryGrowth: () => void }) {
  const [expandedSkillGroups, setExpandedSkillGroups] = useState<Record<string, boolean>>({});
  const recentSkills = evolution.skills?.recent ?? [];
  const profiles = evolution.profiles ?? [];
  const trend = evolution.trend ?? [];
  const milestones = evolution.milestones ?? [];
  const skillTree = evolution.skill_tree ?? [];
  const skillCount = evolution.skills?.count ?? recentSkills.length;
  const readyProfiles = profiles.filter((profile) => profile.profile_available && profile.soul?.present && profile.agent?.present).length;
  const fallbackRecords = [
    ...recentSkills.map((skill) => ({
      date: skill.modified_at,
    })),
    ...profiles.flatMap((profile) => [
      { date: profile.soul?.modified_at },
      { date: profile.agent?.modified_at },
    ]),
  ].filter((record) => record.date);
  const latestEvolution = milestones[0]?.date ?? fallbackRecords.sort((left, right) => new Date(right.date ?? 0).getTime() - new Date(left.date ?? 0).getTime())[0]?.date ?? null;
  const trendMaximum = Math.max(...trend.map((item) => item.total_changes), 1);
  const trendTotal = trend.reduce((sum, item) => sum + item.total_changes, 0);
  const capabilityGroups: Array<{ title: string; icon: OfficeIconName; keywords: string[] }> = [
    { title: '工具调用', icon: 'terminal', keywords: ['api', 'cli', 'tool', 'browser', 'search', 'shell', 'mcp'] },
    { title: '内容理解', icon: 'search', keywords: ['doc', 'pdf', 'content', 'media', 'read', 'write', 'summary', 'transcript'] },
    { title: '专家协作', icon: 'agent', keywords: ['agent', 'team', 'expert', 'delegate', 'invest', 'collaborat'] },
    { title: '自动化任务', icon: 'activity', keywords: ['task', 'workflow', 'cron', 'automation', 'schedule'] },
  ];
  const capabilityMatrix = (evolution.capabilities && evolution.capabilities.length > 0)
    ? evolution.capabilities.map((cap) => ({
        title: cap.name,
        icon: capabilityGroups.find((g) => g.title === cap.name)?.icon ?? 'terminal' as OfficeIconName,
        matched: cap.matched,
      }))
    : capabilityGroups.map((group) => {
        const matched = recentSkills.filter((skill) => group.keywords.some((keyword) => skill.name.toLowerCase().includes(keyword)));
        return { ...group, matched };
      });
  const skillTreeIcons: Record<string, OfficeIconName> = {
    messaging: 'message',
    knowledge: 'search',
    development: 'terminal',
    automation: 'activity',
  };
  const milestoneIcons: Record<string, OfficeIconName> = {
    commit: 'terminal',
    profile: 'user',
    skill: 'growth',
  };

  return (
    <section className="page-section evolution-page">
      <div className="growth-hero">
        <div className="growth-hero-heading">
          <div className="overview-mark"><OfficeIcon name="growth" size={24} /></div>
          <div><p className="eyebrow">Growth Archive</p><h1>进化档案</h1></div>
        </div>
        <p>把能力沉淀、人格文件与最近变化整理成可持续追踪的成长档案。</p>
        <div className="growth-summary">
          <div><strong>{evolution.skills?.available ? skillCount : '暂无'}</strong><span>能力记录</span></div>
          <div><strong>{profiles.length ? `${readyProfiles}/${profiles.length}` : '暂无'}</strong><span>档案完整</span></div>
          <div><strong>{formatTime(latestEvolution)}</strong><span>最近进化</span></div>
        </div>
      </div>

      <div className="section-heading"><div><p className="section-kicker">Growth Records</p><h2>成长记录</h2></div><span>{growthState.status === 'loading' ? '加载中' : growthState.status === 'error' ? '加载失败' : growth.total ? `${growth.total} 条真实记录` : '待记录'}</span></div>
      <div className="archive-card growth-records-card">
        {growthState.status !== 'success' ? <ResourceStateCard state={growthState} onRetry={onRetryGrowth} label="成长记录" /> : growth.records.length === 0 ? <p className="archive-empty">暂无成长记录。试着在办公室记一笔「成长」吧。</p> : (
          <div className="growth-records-list">
            {growth.records.slice(0, 12).map((record) => {
              const recordType = typeof record.type === 'string' ? record.type : 'other';
              const meta = growthTypeLabels[recordType] ?? { label: recordType === 'other' ? '其他' : recordType, icon: 'file' as OfficeIconName };
              return (
                <div className="growth-record-item" key={record.id}>
                  <span className={`growth-record-type ${recordType}`}><OfficeIcon name={meta.icon} size={13} />{meta.label}</span>
                  <div className="growth-record-body"><strong>{record.title}</strong><time>{formatTime(record.date)}</time></div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="section-heading"><div><p className="section-kicker">Capability Matrix</p><h2>能力矩阵</h2></div><span>按现有 Skill 名称归档</span></div>
      <div className="capability-grid">
        {capabilityMatrix.map((capability) => (
          <div className="capability-card" key={capability.title}>
            <div className="capability-icon"><OfficeIcon name={capability.icon} size={18} /></div>
            <div><strong>{capability.title}</strong><small>{capability.matched.length ? `已记录 ${capability.matched.length} 项` : '待记录'}</small></div>
            <span className={capability.matched.length ? 'capability-state recorded' : 'capability-state'}>{capability.matched.length ? '已有沉淀' : '暂无数据'}</span>
          </div>
        ))}
      </div>

      <div className="section-heading"><div><p className="section-kicker">Growth Trend</p><h2>能力增长曲线</h2></div><span>最近 7 天 · {trendTotal} 次变化</span></div>
      <div className="archive-card trend-card">
        <div className="trend-legend">
          <span><i className="skill" />Skill 修改</span>
          <span><i className="profile" />档案修改</span>
        </div>
        {trend.length === 0 ? <p className="archive-empty">暂无趋势记录。</p> : (
          <div className="trend-chart" aria-label="最近七天能力增长条形趋势">
            {trend.map((item) => (
              <div className="trend-column" key={item.date}>
                <span>{item.total_changes}</span>
                <div className="trend-bar">
                  <i className="trend-skill" style={{ height: `${(item.skill_changes / trendMaximum) * 100}%` }} />
                  <i className="trend-profile" style={{ height: `${(item.profile_changes / trendMaximum) * 100}%` }} />
                </div>
                <small>{item.date.slice(5)}</small>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section-heading"><div><p className="section-kicker">Milestones</p><h2>进化里程碑</h2></div><span>{milestones.length ? `${milestones.length} 条真实记录` : '待记录'}</span></div>
      <div className="archive-card milestone-card">
        {milestones.length === 0 ? <p className="archive-empty">暂无里程碑记录。</p> : milestones.map((milestone, index) => (
          <div className="milestone-event" key={`${milestone.type}-${milestone.date}-${milestone.title}`}>
            <div className="milestone-rail"><span><OfficeIcon name={milestoneIcons[milestone.type] ?? 'file'} size={15} /></span>{index < milestones.length - 1 && <i />}</div>
            <div><strong>{milestone.title}</strong><p>{milestone.description}</p><time>{formatTime(milestone.date)}</time></div>
          </div>
        ))}
      </div>

      <div className="section-heading"><div><p className="section-kicker">Skill Tree</p><h2>技能树</h2></div><span>按名称关键词归类</span></div>
      <div className="skill-tree-grid">
        {skillTree.map((group) => {
          const expanded = Boolean(expandedSkillGroups[group.key]);
          const hiddenSkillCount = Math.max(group.children.length - 6, 0);
          const visibleSkills = expanded ? group.children : group.children.slice(0, 6);
          const childrenId = `skill-tree-${group.key}`;

          return (
            <div className="skill-tree-card" key={group.key}>
              <div className="skill-tree-head">
                <span><OfficeIcon name={skillTreeIcons[group.key] ?? 'growth'} size={17} /></span>
                <div><strong>{group.title}</strong><small>{group.children.length ? `${group.children.length} 项能力` : '待记录'}</small></div>
              </div>
              <div className="skill-tree-children" id={childrenId}>
                {group.children.length === 0 ? <span className="skill-tree-empty">暂无匹配 Skill</span> : visibleSkills.map((skill) => <span key={skill.name} title={skill.name}>{skill.name}</span>)}
              </div>
              {hiddenSkillCount > 0 && (
                <button
                  aria-controls={childrenId}
                  aria-expanded={expanded}
                  className="skill-tree-toggle"
                  onClick={() => setExpandedSkillGroups((current) => ({ ...current, [group.key]: !expanded }))}
                  type="button"
                >
                  {expanded ? '收起' : `展开 ${hiddenSkillCount} 项`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="section-heading"><div><p className="section-kicker">Employee Profiles</p><h2>员工档案卡</h2></div><span>{profiles.length || 0} 份档案</span></div>
      <div className="profile-archive-list">
        {profiles.length === 0 ? <div className="empty-card">暂无员工档案。</div> : profiles.map((profile) => (
          <div className="profile-archive-card" key={profile.profile}>
            <div className="profile-archive-head">
              <div className="profile-avatar"><OfficeIcon name="user" size={20} /></div>
              <div><strong>{profile.name}</strong><small>{profile.profile}</small></div>
              <span className={profile.profile_available ? 'profile-state ready' : 'profile-state'}>{profile.profile_available ? '档案可用' : '档案暂无'}</span>
            </div>
            <div className="profile-file-grid">
              <div><OfficeIcon name="user" size={16} /><span><strong>SOUL.md</strong><small>{profile.soul?.present ? formatTime(profile.soul.modified_at) : '暂无'}</small></span></div>
              <div><OfficeIcon name="file" size={16} /><span><strong>AGENT.md</strong><small>{profile.agent?.present ? formatTime(profile.agent.modified_at) : '暂无'}</small></span></div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function KnowledgePage({ knowledge, resourceState, onRetry }: { knowledge: KnowledgeData; resourceState: ResourceState; onRetry: () => void }) {
  const counts = knowledge.counts ?? { 来源: 0, 概念: 0, 对比: 0, 实体: 0, 想法: 0 };
  const total = knowledge.total ?? 0;
  const trend = knowledge.trend ?? [];
  const trendMaximum = Math.max(...trend.map((item) => item.files_added), 1);
  const commits = knowledge.recent_commits ?? [];
  const countIcons: Record<string, OfficeIconName> = { 来源: 'file', 概念: 'search', 对比: 'activity', 实体: 'user', 想法: 'growth' };

  if (resourceState.status !== 'success') {
    return <section className="page-section knowledge-page"><ResourceStateCard state={resourceState} onRetry={onRetry} label="知识库统计" /></section>;
  }

  return (
    <section className="page-section knowledge-page">
      <div className="growth-hero">
        <div className="growth-hero-heading">
          <div className="overview-mark"><OfficeIcon name="search" size={24} /></div>
          <div><p className="eyebrow">Knowledge Base</p><h1>知识资产库</h1></div>
        </div>
        <p>wiki 知识库实时统计：来源摘要、概念沉淀、对比分析与灵感想法的规模与最近动态。</p>
        <div className="growth-summary">
          <div><strong>{knowledge.available ? total : '暂无'}</strong><span>知识总数</span></div>
          <div><strong>{counts['来源'] ?? 0}</strong><span>来源摘要</span></div>
          <div><strong>{counts['概念'] ?? 0}</strong><span>概念沉淀</span></div>
        </div>
      </div>

      <div className="section-heading"><div><p className="section-kicker">Library Size</p><h2>知识构成</h2></div><span>按目录归档</span></div>
      <div className="capability-grid">
        {Object.entries(counts).map(([key, value]) => (
          <div className="capability-card" key={key}>
            <div className="capability-icon"><OfficeIcon name={countIcons[key] ?? 'file'} size={18} /></div>
            <div><strong>{key}</strong><small>{value} 条</small></div>
            <span className="capability-state recorded">已有沉淀</span>
          </div>
        ))}
      </div>

      <div className="section-heading"><div><p className="section-kicker">Ingest Trend</p><h2>近 7 天入库</h2></div><span>按文件修改时间统计</span></div>
      <div className="archive-card trend-card">
        {trend.length === 0 ? <p className="archive-empty">暂无入库记录。</p> : (
          <div className="trend-chart" aria-label="近七天知识入库趋势">
            {trend.map((item) => (
              <div className="trend-column" key={item.date}>
                <span>{item.files_added}</span>
                <div className="trend-bar">
                  <i className="trend-skill" style={{ height: `${(item.files_added / trendMaximum) * 100}%` }} />
                </div>
                <small>{item.date.slice(5)}</small>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section-heading"><div><p className="section-kicker">Recent Commits</p><h2>最近提交</h2></div><span>{commits.length ? `${commits.length} 条真实记录` : '待记录'}</span></div>
      <div className="archive-card milestone-card">
        {commits.length === 0 ? <p className="archive-empty">暂无提交记录。</p> : commits.map((commit) => (
          <div className="milestone-event" key={commit.id}>
            <div className="milestone-rail"><span><OfficeIcon name="terminal" size={15} /></span><i /></div>
            <div><strong>{commit.title}</strong><time>{formatTime(commit.date)}</time></div>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

function CostPage({ usageTrend, tokenUsage, resourceState, onRetry }: { usageTrend: UsageTrendData; tokenUsage: TokenUsageData; resourceState: ResourceState; onRetry: () => void }) {
  const days = (usageTrend.days ?? []).map((day) => ({
    ...day,
    totalTokens: (day.input_tokens ?? 0) + (day.output_tokens ?? 0) + (day.cache_read_tokens ?? 0),
  }));
  const maxDailyTokens = Math.max(...days.map((day) => day.totalTokens), 1);
  const totalCalls = usageTrend.total_calls ?? 0;
  const todayInputTokens = tokenUsage.total?.input_tokens ?? 0;
  const todayOutputTokens = tokenUsage.total?.output_tokens ?? 0;
  const todayCacheTokens = tokenUsage.total?.cache_read_tokens ?? 0;
  const todayTotalTokens = (todayInputTokens + todayOutputTokens + todayCacheTokens) || (tokenUsage.total?.total_tokens ?? 0);
  const byModel = (tokenUsage.by_model ?? [])
    .map((item) => ({
      ...item,
      totalTokens: (item.input_tokens ?? 0) + (item.output_tokens ?? 0) + (item.cache_read_tokens ?? 0),
    }))
    .sort((left, right) => right.totalTokens - left.totalTokens);
  const modelTokenTotal = Math.max(todayInputTokens + todayOutputTokens + todayCacheTokens, 1);

  if (resourceState.status !== 'success') {
    return <section className="page-section cost-page"><ResourceStateCard state={resourceState} onRetry={onRetry} label="成本统计" /></section>;
  }

  return (
    <section className="page-section cost-page">
      <div className="growth-hero">
        <div className="growth-hero-heading">
          <div className="overview-mark"><OfficeIcon name="activity" size={24} /></div>
          <div><p className="eyebrow">Token Usage</p><h1>成本中心</h1></div>
        </div>
        <p>Token 消耗与节省统计，数据来自 Hermes state.db 真实记录 · 近 14 天 {totalCalls} 次调用。</p>
        <div className="growth-summary">
          <div><strong>{formatTokens(todayTotalTokens)}</strong><span>今日总消耗</span></div>
          <div><strong>{formatTokens(todayInputTokens)}</strong><span>今日输入</span></div>
          <div><strong>{formatTokens(todayOutputTokens)}</strong><span>今日输出</span></div>
          <div><strong>{formatTokens(todayCacheTokens)}</strong><span>今日缓存命中</span></div>
        </div>
      </div>

      <div className="section-heading"><div><p className="section-kicker">Usage Trend</p><h2>近 14 天 Token 趋势</h2></div><span>含缓存命中</span></div>
      <div className="archive-card trend-card">
        {days.length === 0 ? <p className="archive-empty">暂无用量记录。</p> : (
          <div className="trend-chart" aria-label="近十四天 Token 用量趋势">
            {days.map((day) => (
              <div className="trend-column" key={day.date}>
                <span>{formatTokens(day.totalTokens)}</span>
                <div className="trend-bar">
                  <i className="trend-skill" style={{ height: `${(day.totalTokens / maxDailyTokens) * 100}%` }} />
                </div>
                <small>{day.date.slice(5)}</small>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section-heading"><div><p className="section-kicker">By Model</p><h2>今日模型用量</h2></div><span>按模型拆分</span></div>
      <div className="archive-card model-usage-card">
        {byModel.length === 0 ? <p className="archive-empty">暂无模型用量。</p> : (
          <div className="model-usage-list">
            {byModel.map((item) => (
              <div className="model-usage-item" key={`${item.model}-${item.provider}`}>
                <div className="model-usage-head">
                  <div>
                    <strong>{item.model}</strong>
                    <small>{item.provider ?? 'unknown'} · {item.api_calls ?? 0} 次调用 · 缓存命中 {formatTokens(item.cache_read_tokens ?? 0)}</small>
                  </div>
                  <span><strong>{formatTokens(item.totalTokens)}</strong><small>Token</small></span>
                </div>
                <div className="model-usage-bar" aria-label={`${item.model} 占今日 Token ${Math.round((item.totalTokens / modelTokenTotal) * 100)}%`}>
                  <i style={{ width: `${Math.min((item.totalTokens / modelTokenTotal) * 100, 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view');
    return tabs.some((item) => item.key === view) ? view as Tab : 'office';
  });
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedId, setSelectedId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('id') || 'default';
  });
  const [evolution, setEvolution] = useState<EvolutionData>({});
  const [growth, setGrowth] = useState<GrowthData>(initialGrowth);
  const [knowledge, setKnowledge] = useState<KnowledgeData>(initialKnowledge);
  const [usageTrend, setUsageTrend] = useState<UsageTrendData>(initialUsageTrend);
  const [tokenUsage, setTokenUsage] = useState<TokenUsageData>(initialTokenUsage);
  const [growthState, setGrowthState] = useState<ResourceState>(initialResourceState);
  const [knowledgeState, setKnowledgeState] = useState<ResourceState>(initialResourceState);
  const [costState, setCostState] = useState<ResourceState>(initialResourceState);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [channels, setChannels] = useState<ChannelHealth[]>([]);
  const [offline, setOffline] = useState(false);
  const [session, setSession] = useState<SessionData | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [authError, setAuthError] = useState('');
  const [loading, setLoading] = useState(true);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
  const [cameFromOffice, setCameFromOffice] = useState(false);

  useEffect(() => {
    fetchSession()
      .then((value) => {
        setSession(value);
        setAuthError('');
      })
      .catch((error) => setAuthError(error instanceof Error ? error.message : '登录状态读取失败'))
      .finally(() => setSessionLoading(false));
  }, []);

  async function loadGrowth() {
    setGrowthState({ status: 'loading' });
    try {
      const result = await fetchGrowth();
      if (result.offline) {
        setGrowthState({ status: 'error', error: result.error });
        return;
      }
      setGrowth(result.data);
      setGrowthState({ status: 'success' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '网络请求失败';
      setGrowthState({ status: 'error', error: message });
      if (/登录|权限/.test(message)) setAuthError(message);
    }
  }

  async function loadKnowledge() {
    setKnowledgeState({ status: 'loading' });
    try {
      const result = await fetchKnowledge();
      if (result.offline) {
        setKnowledgeState({ status: 'error', error: result.error });
        return;
      }
      setKnowledge(result.data);
      setKnowledgeState({ status: 'success' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '网络请求失败';
      setKnowledgeState({ status: 'error', error: message });
      if (/登录|权限/.test(message)) setAuthError(message);
    }
  }

  async function loadCost() {
    setCostState({ status: 'loading' });
    try {
      const [usageResult, tokenResult] = await Promise.all([fetchUsageTrend(), fetchTokenUsage()]);
      if (usageResult.offline || tokenResult.offline) {
        setCostState({ status: 'error', error: usageResult.error || tokenResult.error });
        return;
      }
      setUsageTrend(usageResult.data);
      setTokenUsage(tokenResult.data);
      setCostState({ status: 'success' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '网络请求失败';
      setCostState({ status: 'error', error: message });
      if (/登录|权限/.test(message)) setAuthError(message);
    }
  }

  useEffect(() => {
    if (!session?.authenticated) {
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([fetchHealth(), fetchAgents(), fetchEvolution(), fetchTasks(), loadGrowth(), loadKnowledge(), loadCost()]).then(([healthRes, agentRes, evolutionRes, taskRes]) => {
      setAgents(agentRes.data.agents);
      setSelectedId((current) => (
        current && agentRes.data.agents.some((agent) => agent.id === current)
          ? current
          : agentRes.data.agents[0]?.id ?? 'default'
      ));
      setEvolution(evolutionRes.data);
      setTasks(taskRes.data.items ?? []);
      setOffline(healthRes.offline);
    }).catch((error) => {
      if (error instanceof Error && /登录|权限/.test(error.message)) setAuthError(error.message);
    }).finally(() => setLoading(false));
  }, [session?.authenticated]);

  // URL sync for agent view on load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view');
    const id = params.get('id');

    if (view === 'agent' && id) {
      if (agents.some(a => a.id === id)) {
        setSelectedId(id);
        setTab('agent');
        setCameFromOffice(true);
      }
    }
  }, [agents]);

  useEffect(() => {
    if (!session?.authenticated) {
      setChannels([]);
      return;
    }
    fetchChannelHealth().then(setChannels).catch(() => setChannels([]));
  }, [session?.authenticated]);

  useEffect(() => {
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const handleInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
    };
    window.addEventListener('beforeinstallprompt', handleInstallPrompt);
    window.addEventListener('appinstalled', handleInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, []);

  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === selectedId) ?? agents[0], [agents, selectedId]);






  async function handleInstall() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') setInstalled(true);
    setInstallPrompt(null);
  }

  async function handleLogin(password: string) {
    setLoginLoading(true);
    setLoginError('');
    try {
      const nextSession = await loginWithPassword(password);
      setSession(nextSession);
      setAuthError('');
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : '登录失败，请稍后重试。');
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleLogout() {
    try {
      const nextSession = await logoutSession();
      setSession(nextSession);
      setAgents([]);
      setTasks([]);
      setChannels([]);
      setGrowth(initialGrowth);
      setKnowledge(initialKnowledge);
      setUsageTrend(initialUsageTrend);
      setTokenUsage(initialTokenUsage);
      setGrowthState(initialResourceState);
      setKnowledgeState(initialResourceState);
      setCostState(initialResourceState);
      setOffline(false);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '退出失败，请稍后重试。');
    }
  }

  function handleTabChange(nextTab: Tab) {
    setTab(nextTab);
    const url = new URL(window.location.href);
    if (nextTab === 'office') url.searchParams.delete('view');
    else url.searchParams.set('view', nextTab);
    url.searchParams.delete('id');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }

  function handleSelectAgent(agentId: string) {
    setSelectedId(agentId);
    setTab('agent');
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'agent');
    url.searchParams.set('id', agentId);
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }

  function handleSelectAgentFromOffice(agentId: string) {
    setCameFromOffice(true);
    handleSelectAgent(agentId);
  }

  const pageTitle = tabs.find((item) => item.key === tab)?.label ?? '办公室';

  if (sessionLoading) {
    return <SessionLoadingPage />;
  }

  if (!session || (session.auth_enabled && !session.authenticated)) {
    return (
      <LoginPage
        loading={loginLoading}
        error={loginError || authError}
        onLogin={handleLogin}
      />
    );
  }

  const authLabel = authError
    ? '登录异常'
    : session?.auth_enabled
      ? `已登录 · ${session.role === 'admin' ? '管理员' : session.role === 'operator' ? '操作员' : '只读'}`
      : '鉴权待启用';

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <span>HERMES OFFICE</span>
          <strong>{pageTitle}</strong>
        </div>
        <div className="topbar-status">
          <div className="auth-row">
            <div className={`auth-state ${authError ? 'error' : session?.auth_enabled ? 'enabled' : 'pending'}`} title={session?.email ?? authError}><span />{authLabel}</div>
            {session.auth_enabled ? <button className="logout-button" type="button" onClick={() => void handleLogout()}>退出</button> : null}
          </div>
          <div className={`connection-state ${offline ? 'offline' : ''}`}><span />{offline ? '离线数据' : '已连接'}</div>
        </div>
      </header>
      {authError ? <div className="auth-banner" role="alert"><OfficeIcon name="alert" size={17} /><span><strong>登录状态异常。</strong> {authError}</span></div> : null}
      <OfflineBanner show={offline && !authError} />
      {tab === 'office' && <OfficePage agents={agents} tasks={tasks} selectedId={selectedId} onSelectAgent={handleSelectAgentFromOffice} onOpenTasks={() => handleTabChange('evolution')} backendOffline={offline} loading={loading} usageTrend={usageTrend} knowledge={knowledge} costState={costState} knowledgeState={knowledgeState} />}
      {tab === 'agent' && <AgentPage agents={agents} selectedId={selectedId} onSelectAgent={handleSelectAgent} agent={selectedAgent} tasks={tasks} evolution={evolution} cameFromOffice={cameFromOffice} onBack={() => { setTab('office'); setCameFromOffice(false); const url = new URL(window.location.href); url.searchParams.delete('view'); url.searchParams.delete('id'); window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`); }} loading={loading} />}
      {tab === 'evolution' && <EvolutionPage evolution={evolution} growth={growth} growthState={growthState} onRetryGrowth={() => void loadGrowth()} />}
      {tab === 'knowledge' && <KnowledgePage knowledge={knowledge} resourceState={knowledgeState} onRetry={() => void loadKnowledge()} />}
      {tab === 'cost' && <CostPage usageTrend={usageTrend} tokenUsage={tokenUsage} resourceState={costState} onRetry={() => void loadCost()} />}
      <nav className="tabbar" aria-label="主导航">
        {tabs.map(({ key, label, icon }) => (
          <button
            key={key}
            className={tab === key ? 'selected' : ''}
            type="button"
            aria-label={label}
            aria-current={tab === key ? 'page' : undefined}
            onClick={() => handleTabChange(key)}
          >
            <OfficeIcon name={icon} size={21} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </main>
  );
}

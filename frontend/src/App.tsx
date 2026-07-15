import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchAgents, fetchEvolution, fetchOutbox, fetchTasks, retryOutbox, sendMessage } from './api';
import { OfficeIcon, type OfficeIconName } from './components/OfficeIcon';
import type { AgentInfo, EvolutionData, OutboxData, TaskItem, TaskStatus } from './types';

type Tab = 'office' | 'workspace' | 'agent' | 'evolution' | 'activity';
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

type RoleMeta = { role: string; focus: string; tone: string; avatar: string; tags: string[] };
type AutoRetryReport = { completed: boolean; lastAttemptAt: string | null; delivered: number | null; remaining: number | null; error: string };
type ExpertAgentId = 'default' | 'media-ops' | 'investor';
type ExpertDeliveryStatus = 'delivered' | 'queued' | 'failed';
type ExpertDeliveryResult = { agentId: ExpertAgentId; status: ExpertDeliveryStatus; error?: string };
type WorkspaceLog = { id: string; createdAt: string; type: 'dispatch' | 'expert'; targetAgentId: ExpertAgentId; status: ExpertDeliveryStatus; title: string };
type Workspace = { id: string; name: string; goal: string; memberIds: ExpertAgentId[]; createdAt: string; logs: WorkspaceLog[] };

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

const workspaceStorageKey = 'hermes-office-workspaces';

const issueReasonMap: Record<string, string> = {
  api_request_failed: 'Hermes 通道请求失败',
  api_key_unavailable: '鉴权配置待恢复',
  api_server_offline: 'Hermes 服务未连接',
  profile_not_found: '员工档案未找到',
};

const roleMap: Record<string, RoleMeta> = {
  default: {
    role: '主控与知识系统',
    focus: '调度专家团、维护知识库、派发开发任务',
    tone: 'slate',
    avatar: '/avatars/default.png',
    tags: ['知识库维护', '专家团调度', 'Codex派发', '浏览器验收'],
  },
  'media-ops': {
    role: '内容与媒体运营',
    focus: '负责选题、内容改写与多平台分发',
    tone: 'blue',
    avatar: '/avatars/media-ops.png',
    tags: ['内容选题', '视频理解', '多平台分发', '文案改写'],
  },
  investor: {
    role: '商业与投资分析',
    focus: '负责定价、商业模式与收益风险判断',
    tone: 'sand',
    avatar: '/avatars/investor.png',
    tags: ['商业分析', 'ROI判断', '定价策略', '风险评估'],
  },
};

const tabs: Array<{ key: Tab; label: string; icon: OfficeIconName }> = [
  { key: 'office', label: '办公室', icon: 'office' },
  { key: 'workspace', label: '空间', icon: 'workspace' },
  { key: 'agent', label: '员工', icon: 'agent' },
  { key: 'evolution', label: '进化', icon: 'growth' },
  { key: 'activity', label: '任务', icon: 'activity' },
];

function createDefaultWorkspace(): Workspace {
  return {
    id: 'workspace-example',
    name: 'Hermes 移动工作空间',
    goal: '集中三位智能员工，协作推进移动办公室产品迭代。',
    memberIds: ['default', 'media-ops', 'investor'],
    createdAt: new Date().toISOString(),
    logs: [],
  };
}

function loadWorkspaces(): Workspace[] {
  try {
    const stored = window.localStorage.getItem(workspaceStorageKey);
    if (!stored) return [createDefaultWorkspace()];
    const parsed = JSON.parse(stored) as Array<Omit<Workspace, 'logs'> & { logs?: WorkspaceLog[] }>;
    const valid = parsed.filter((workspace) => (
      workspace
      && typeof workspace.id === 'string'
      && typeof workspace.name === 'string'
      && typeof workspace.goal === 'string'
      && Array.isArray(workspace.memberIds)
      && typeof workspace.createdAt === 'string'
    )).map((workspace) => ({
      ...workspace,
      logs: Array.isArray(workspace.logs) ? workspace.logs.slice(0, 20) : [],
    }));
    return valid.length > 0 ? valid : [createDefaultWorkspace()];
  } catch {
    return [createDefaultWorkspace()];
  }
}

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
      <span><strong>后端暂时离线。</strong> 当前显示离线缓存或模拟数据，仍可继续浏览；连接恢复后会自动切换真实状态。</span>
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
        <div className="monitor-shell">
          <OfficeIcon name="monitor" size={35} />
          <span className={`monitor-signal ${agent.status === 'online' ? 'online' : ''}`} />
        </div>
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
        <div className="office-world" aria-hidden="true">
          <div className="office-platform" />
          <div className="office-zone-surface kitchen-surface" />
          <div className="office-zone-surface fitness-surface" />
          <div className="office-zone-surface workstation-surface" />
          <div className="office-kitchenette">
            <div className="kitchen-cabinet cabinet-one"><span /><span /></div>
            <div className="kitchen-cabinet cabinet-two"><span /></div>
            <div className="kitchen-counter"><span className="kitchen-sink" /><span className="kitchen-machine" /></div>
            <div className="kitchen-island"><span /></div>
            <div className="kitchen-stool stool-one" />
            <div className="kitchen-stool stool-two" />
          </div>
          <div className="office-treadmill">
            <span className="treadmill-belt" />
            <span className="treadmill-post" />
            <span className="treadmill-console" />
          </div>
          {['one', 'two', 'three', 'four'].map((desk) => (
            <div className={`office-desk desk-${desk}`} key={desk}>
              <span className="desk-drawer" />
              <span className="desk-keyboard" />
              <span className="desk-cup" />
              <span className="office-monitor"><i /></span>
            </div>
          ))}
          {['one', 'two', 'three'].map((person) => (
            <div className={`office-seat seat-${person}`} key={person}>
              <span className="chair-back" />
              <span className="office-person"><i /><b /></span>
            </div>
          ))}
          <div className="office-plant plant-one"><i /><span /><span /></div>
          <div className="office-plant plant-two"><i /><span /><span /></div>
          <div className="office-plant plant-three"><i /><span /><span /></div>
        </div>
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

function ResourceTaskOverview({ tasks }: { tasks: TaskItem[] }) {
  const runningCount = tasks.filter((task) => task.status === 'running').length;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  const recentTasks = tasks.slice(0, 3);

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
          <strong>--</strong>
          <small>计量源待接入</small>
        </div>
        <div>
          <span>今日节省 Token</span>
          <strong>--</strong>
          <small>本地模型节省待统计</small>
        </div>
      </div>
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

function OfficePage({ agents, tasks, selectedId, setSelectedId, onSelectAgent, pending, backendOffline, installPrompt, installed, onInstall }: { agents: AgentInfo[]; tasks: TaskItem[]; selectedId: string; setSelectedId: (id: string) => void; onSelectAgent: (agentId: string) => void; pending: number; backendOffline: boolean; installPrompt: BeforeInstallPromptEvent | null; installed: boolean; onInstall: () => void }) {
  const online = agents.filter((agent) => agent.status === 'online').length;
  const offline = Math.max(agents.length - online, 0);
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
          <div><span className="metric-dot online" /><strong>{online}</strong><small>在线</small></div>
          <div><span className="metric-dot offline" /><strong>{offline}</strong><small>离线</small></div>
          <div><span className="metric-dot pending" /><strong>{pending}</strong><small>待补投</small></div>
        </div>
      </div>
      <VirtualOfficeCard onSelectAgent={onSelectAgent} />
      <ResourceTaskOverview tasks={tasks} />
      <MobileAccessCard installPrompt={installPrompt} installed={installed} onInstall={onInstall} />
      <div className="section-heading">
        <div>
          <p className="section-kicker">Office Floor</p>
          <h2>员工工位</h2>
        </div>
        <span>{agents.length} 位员工</span>
      </div>
      <div className="agent-list">
        {agents.length === 0 ? (
          <div className="empty-card offline-empty">
            <OfficeIcon name={backendOffline ? 'alert' : 'agent'} size={19} />
            <span>{backendOffline ? '后端离线且暂无缓存数据，其他页面仍可继续浏览。' : '暂无员工数据。'}</span>
          </div>
        ) : agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} active={agent.id === selectedId} onClick={() => setSelectedId(agent.id)} />
        ))}
      </div>
    </section>
  );
}

function AgentPage({ agent, tasks, evolution }: { agent?: AgentInfo; tasks: TaskItem[]; evolution: EvolutionData }) {
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
      setSendStatus({
        type: 'sent',
        text: `${result.delivered ? '已发送到 Hermes' : '已入队兜底'} · ${formatTime(result.stored_at)}`,
      });
    } catch (error) {
      setSendStatus({ type: 'error', text: error instanceof Error ? error.message : '发送失败，请稍后重试' });
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="page-section">
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

function EvolutionPage({ evolution }: { evolution: EvolutionData }) {
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
  const capabilityMatrix = capabilityGroups.map((group) => {
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

type TaskFilter = 'all' | 'running' | 'completed' | 'queued' | 'interrupted' | 'event';

const taskFilters: Array<{ key: TaskFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '进行中' },
  { key: 'completed', label: '已完成' },
  { key: 'queued', label: '待补投' },
  { key: 'interrupted', label: '中断/失败' },
  { key: 'event', label: '事件' },
];

const taskStatusMeta: Record<TaskStatus, { label: string; icon: OfficeIconName }> = {
  running: { label: '进行中', icon: 'clock' },
  completed: { label: '已完成', icon: 'check' },
  queued: { label: '待补投', icon: 'database' },
  failed: { label: '失败', icon: 'alert' },
  paused: { label: '已暂停', icon: 'alert' },
  event: { label: '事件', icon: 'activity' },
};

const taskSourceLabels: Record<string, string> = { cron: '定时任务', outbox: '兜底队列', sent: '已送达', gateway: '网关事件' };

function WorkspacePage({ tasks, onDispatch, onExpertSubmit }: { tasks: TaskItem[]; onDispatch: (agentId: ExpertAgentId, workspaceName: string, goal: string, task: string) => Promise<ExpertDeliveryResult>; onExpertSubmit: (memberIds: ExpertAgentId[], workspaceName: string, goal: string, question: string) => Promise<ExpertDeliveryResult[]> }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>(loadWorkspaces);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(() => loadWorkspaces()[0]?.id ?? '');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [memberIds, setMemberIds] = useState<ExpertAgentId[]>(['default']);
  const [question, setQuestion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [deliveryResults, setDeliveryResults] = useState<ExpertDeliveryResult[]>([]);
  const [dispatchAgentId, setDispatchAgentId] = useState<ExpertAgentId>('default');
  const [dispatchTask, setDispatchTask] = useState('');
  const [dispatching, setDispatching] = useState(false);
  const [dispatchResult, setDispatchResult] = useState<ExpertDeliveryResult | null>(null);
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0];
  const workspaceTasks = useMemo(() => {
    if (!selectedWorkspace) return [];
    return sortTasksByRecent(tasks.filter((task) => taskContainsText(task, selectedWorkspace.name)));
  }, [selectedWorkspace, tasks]);
  const recentWorkspaceTasks = workspaceTasks.slice(0, 5);
  const recentMemberTasks = useMemo(() => {
    if (!selectedWorkspace) return [];
    return sortTasksByRecent(tasks.filter((task) => (
      Boolean(task.agent_id) && selectedWorkspace.memberIds.includes(task.agent_id as ExpertAgentId)
    ))).slice(0, 5);
  }, [selectedWorkspace, tasks]);
  const workspaceQueuedTasks = workspaceTasks.filter((task) => task.status === 'queued');
  const unmatchedQueuedLogs = selectedWorkspace?.logs.filter((log) => (
    log.status === 'queued' && !workspaceQueuedTasks.some((task) => taskContainsText(task, log.title))
  )) ?? [];
  const workspacePendingCount = workspaceQueuedTasks.length + unmatchedQueuedLogs.length;

  useEffect(() => {
    window.localStorage.setItem(workspaceStorageKey, JSON.stringify(workspaces));
  }, [workspaces]);

  useEffect(() => {
    setQuestion('');
    setDeliveryResults([]);
    setDispatchTask('');
    setDispatchResult(null);
  }, [selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    if (selectedWorkspace.memberIds.length > 0 && !selectedWorkspace.memberIds.includes(dispatchAgentId)) {
      setDispatchAgentId(selectedWorkspace.memberIds[0]);
    }
  }, [dispatchAgentId, selectedWorkspace]);

  function toggleMember(agentId: ExpertAgentId) {
    setMemberIds((current) => current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId]);
  }

  function handleCreateWorkspace() {
    const workspaceName = name.trim();
    const workspaceGoal = goal.trim();
    if (!workspaceName || !workspaceGoal || memberIds.length === 0) return;
    const workspace: Workspace = {
      id: `workspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: workspaceName,
      goal: workspaceGoal,
      memberIds,
      createdAt: new Date().toISOString(),
      logs: [],
    };
    setWorkspaces((current) => [...current, workspace]);
    setSelectedWorkspaceId(workspace.id);
    setName('');
    setGoal('');
    setMemberIds(['default']);
    setCreating(false);
  }

  function appendLogs(workspaceId: string, logs: WorkspaceLog[]) {
    setWorkspaces((current) => current.map((workspace) => (
      workspace.id === workspaceId
        ? { ...workspace, logs: [...logs, ...workspace.logs].slice(0, 20) }
        : workspace
    )));
  }

  async function handleDispatch() {
    const task = dispatchTask.trim();
    if (!selectedWorkspace || !task || dispatching || !selectedWorkspace.memberIds.includes(dispatchAgentId)) return;
    setDispatching(true);
    setDispatchResult(null);
    try {
      const result = await onDispatch(dispatchAgentId, selectedWorkspace.name, selectedWorkspace.goal, task);
      setDispatchResult(result);
      appendLogs(selectedWorkspace.id, [{
        id: `workspace-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        type: 'dispatch',
        targetAgentId: dispatchAgentId,
        status: result.status,
        title: task,
      }]);
      setDispatchTask('');
    } finally {
      setDispatching(false);
    }
  }

  async function handleSubmit() {
    const trimmedQuestion = question.trim();
    if (!selectedWorkspace || !trimmedQuestion || submitting) return;
    setSubmitting(true);
    setDeliveryResults([]);
    try {
      const results = await onExpertSubmit(selectedWorkspace.memberIds, selectedWorkspace.name, selectedWorkspace.goal, trimmedQuestion);
      setDeliveryResults(results);
      const createdAt = new Date().toISOString();
      appendLogs(selectedWorkspace.id, results.map((result, index) => ({
        id: `workspace-log-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt,
        type: 'expert',
        targetAgentId: result.agentId,
        status: result.status,
        title: trimmedQuestion,
      })));
      setQuestion('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="page-section workspace-page">
      <div className="workspace-header">
        <div><p className="eyebrow">Workspace</p><h1>工作空间</h1><span>围绕项目目标组织成员与真实任务</span></div>
        <button className="workspace-create-button" type="button" onClick={() => setCreating((current) => !current)}>
          <OfficeIcon name={creating ? 'chevron' : 'workspace'} size={18} />
          {creating ? '收起' : '新建空间'}
        </button>
      </div>

      {creating ? (
        <div className="workspace-create-card">
          <label><span>空间名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：新品发布项目" /></label>
          <label><span>项目目标</span><textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="描述这个空间要共同完成的目标" /></label>
          <fieldset>
            <legend>选择成员</legend>
            <div className="workspace-member-options">
              {expertPanelAgents.map((expert) => (
                <button key={expert.id} type="button" className={memberIds.includes(expert.id) ? 'selected' : ''} onClick={() => toggleMember(expert.id)}>
                  <i className={expert.id} />
                  <span><strong>{expert.name}</strong><small>{expert.perspective}</small></span>
                  <OfficeIcon name={memberIds.includes(expert.id) ? 'check' : 'user'} size={15} />
                </button>
              ))}
            </div>
          </fieldset>
          <button className="workspace-primary-button" type="button" onClick={handleCreateWorkspace} disabled={!name.trim() || !goal.trim() || memberIds.length === 0}>创建并进入空间</button>
        </div>
      ) : null}

      <div className="workspace-switcher" aria-label="工作空间列表">
        {workspaces.map((workspace) => (
          <button key={workspace.id} className={workspace.id === selectedWorkspace?.id ? 'selected' : ''} type="button" onClick={() => setSelectedWorkspaceId(workspace.id)}>
            <OfficeIcon name="workspace" size={16} />
            <span>{workspace.name}</span>
          </button>
        ))}
      </div>

      {selectedWorkspace ? (
        <>
          <div className="workspace-detail-card">
            <div className="workspace-detail-heading">
              <div className="workspace-detail-icon"><OfficeIcon name="workspace" size={22} /></div>
              <div><p>当前空间</p><h2>{selectedWorkspace.name}</h2><small>创建于 {formatTime(selectedWorkspace.createdAt)}</small></div>
            </div>
            <div className="workspace-goal"><span>项目目标</span><p>{selectedWorkspace.goal}</p></div>
            <div className="workspace-member-chips" aria-label="空间成员">
              {selectedWorkspace.memberIds.map((agentId) => {
                const expert = expertPanelAgents.find((item) => item.id === agentId);
                return <span key={agentId} className={agentId}><i />{expert?.name ?? formatAgentName(agentId)}<small>{expert?.perspective}</small></span>;
              })}
            </div>
          </div>

          <div className="workspace-mini-stats" aria-label="空间状态概览">
            <div><span>成员数</span><strong>{selectedWorkspace.memberIds.length}</strong><small>当前空间成员</small></div>
            <div><span>空间日志数</span><strong>{selectedWorkspace.logs.length}</strong><small>最近最多 20 条</small></div>
            <div><span>相关任务数</span><strong>{workspaceTasks.length}</strong><small>真实任务名称命中</small></div>
            <div><span>待补投数</span><strong>{workspacePendingCount}</strong><small>任务 {workspaceQueuedTasks.length} · 日志 {unmatchedQueuedLogs.length}</small></div>
          </div>

          <div className="workspace-dispatch-card">
            <div className="workspace-section-heading"><div><span>Workspace Dispatch</span><h3>空间派活</h3></div><small>单独指派当前空间成员</small></div>
            <label className="workspace-dispatch-select">
              <span>目标成员</span>
              <select value={dispatchAgentId} onChange={(event) => setDispatchAgentId(event.target.value as ExpertAgentId)} aria-label="空间派活目标成员">
                {selectedWorkspace.memberIds.map((agentId) => {
                  const expert = expertPanelAgents.find((item) => item.id === agentId);
                  return <option key={agentId} value={agentId}>{expert?.name ?? formatAgentName(agentId)} · {expert?.perspective ?? '空间成员视角'}</option>;
                })}
              </select>
            </label>
            <textarea value={dispatchTask} onChange={(event) => setDispatchTask(event.target.value)} placeholder={`输入要交给“${formatAgentName(dispatchAgentId)}”的具体任务`} aria-label="空间派活任务" />
            <button className="workspace-primary-button" type="button" onClick={() => void handleDispatch()} disabled={dispatching || !dispatchTask.trim()}><OfficeIcon name="send" size={16} />{dispatching ? '正在派活…' : `派给 ${formatAgentName(dispatchAgentId)}`}</button>
            {dispatchResult ? (
              <div className={`workspace-dispatch-result ${dispatchResult.status}`} aria-live="polite">
                <OfficeIcon name={dispatchResult.status === 'delivered' ? 'check' : dispatchResult.status === 'queued' ? 'database' : 'alert'} size={15} />
                <span>{dispatchResult.status === 'delivered' ? '已发送到 Hermes' : dispatchResult.status === 'queued' ? '已入队兜底' : '派活失败'}</span>
              </div>
            ) : null}
          </div>

          <div className="workspace-task-card">
            <div className="workspace-section-heading"><div><span>Task Summary</span><h3>空间任务摘要</h3></div><small>{recentWorkspaceTasks.length > 0 ? `名称命中 · 最近 ${recentWorkspaceTasks.length} 条` : '暂无名称命中'}</small></div>
            {recentWorkspaceTasks.length > 0 ? (
              <div className="workspace-task-list">
                {recentWorkspaceTasks.map((task) => {
                  const taskMeta = taskStatusMeta[task.status];
                  return (
                    <div key={task.id}>
                      <span className={`task-check ${task.status}`}><OfficeIcon name={taskMeta.icon} size={14} /></span>
                      <div><strong>{task.title}</strong><p>{formatTaskDetail(task, '任务详情待补充')}</p><small>{formatAgentName(task.agent_id)} · {formatTime(task.time)}</small></div>
                      <em className={`task-status ${task.status}`}>{taskMeta.label}</em>
                    </div>
                  );
                })}
              </div>
            ) : <div className="workspace-empty"><OfficeIcon name="activity" size={18} /><span>真实任务中暂未找到包含“{selectedWorkspace.name}”的记录</span></div>}
          </div>

          <div className="workspace-member-task-card">
            <div className="workspace-section-heading"><div><span>Member Activity</span><h3>成员最近任务辅助区</h3></div><small>按成员粗略关联 · 最近 {recentMemberTasks.length} 条</small></div>
            {recentMemberTasks.length > 0 ? (
              <div className="workspace-task-list workspace-member-task-list">
                {recentMemberTasks.map((task) => {
                  const taskMeta = taskStatusMeta[task.status];
                  return (
                    <div key={task.id}>
                      <span className={`task-check ${task.status}`}><OfficeIcon name={taskMeta.icon} size={14} /></span>
                      <div><strong>{task.title}</strong><p>{formatTaskDetail(task, '任务详情待补充')}</p><small>{formatAgentName(task.agent_id)} · {formatTime(task.time)}</small></div>
                      <em className={`task-status ${task.status}`}>{taskMeta.label}</em>
                    </div>
                  );
                })}
              </div>
            ) : <div className="workspace-empty"><OfficeIcon name="agent" size={18} /><span>当前空间成员暂无可展示的真实任务</span></div>}
          </div>

          <div className="workspace-expert-card">
            <div className="workspace-section-heading"><div><span>Expert Team</span><h3>空间内专家团</h3></div><small>仅投递给当前空间成员</small></div>
            <textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={`向“${selectedWorkspace.name}”成员提问`} aria-label="空间内专家团问题" />
            <button className="workspace-primary-button" type="button" onClick={() => void handleSubmit()} disabled={submitting || !question.trim()}><OfficeIcon name="send" size={16} />{submitting ? '正在投递…' : `投递给 ${selectedWorkspace.memberIds.length} 位成员`}</button>
            {deliveryResults.length > 0 ? (
              <div className="expert-delivery-results" aria-live="polite">
                {deliveryResults.map((result) => (
                  <div key={result.agentId} className={result.status}>
                    <span><OfficeIcon name={result.status === 'delivered' ? 'check' : result.status === 'queued' ? 'database' : 'alert'} size={15} /></span>
                    <div><strong>{formatAgentName(result.agentId)}</strong><small>{result.status === 'delivered' ? '已发送到 Hermes' : result.status === 'queued' ? '已入队兜底' : '投递失败'}</small></div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="workspace-log-card">
            <div className="workspace-section-heading"><div><span>Workspace Log</span><h3>空间日志</h3></div><small>仅记录发起，不代表执行完成</small></div>
            {selectedWorkspace.logs.length > 0 ? (
              <div className="workspace-log-list">
                {selectedWorkspace.logs.map((log) => (
                  <div key={log.id}>
                    <span className={`workspace-log-icon ${log.status}`}><OfficeIcon name={log.type === 'dispatch' ? 'send' : 'agent'} size={14} /></span>
                    <div><strong>{log.title}</strong><p>{log.type === 'dispatch' ? '空间派活' : '专家团投递'} · {formatAgentName(log.targetAgentId)}</p><small>{formatTime(log.createdAt)}</small></div>
                    <em className={`workspace-log-status ${log.status}`}>{log.status === 'delivered' ? '已发送' : log.status === 'queued' ? '待补投' : '失败'}</em>
                  </div>
                ))}
              </div>
            ) : <div className="workspace-empty"><OfficeIcon name="activity" size={18} /><span>本空间还没有派活或专家团投递记录</span></div>}
          </div>
        </>
      ) : null}
    </section>
  );
}

function ActivityPage({ tasks, outbox, onExpertPanelSubmit, onRetryOutbox, retryStatus, retrying, autoRetryEnabled, autoRetryReport, onToggleAutoRetry }: { tasks: TaskItem[]; outbox: OutboxData; onExpertPanelSubmit: (question: string) => Promise<ExpertDeliveryResult[]>; onRetryOutbox: () => void; retryStatus: string; retrying: boolean; autoRetryEnabled: boolean; autoRetryReport: AutoRetryReport; onToggleAutoRetry: () => void }) {
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [selectedTask, setSelectedTask] = useState<TaskItem | null>(null);
  const [expertQuestion, setExpertQuestion] = useState('');
  const [expertSubmitting, setExpertSubmitting] = useState(false);
  const [expertResults, setExpertResults] = useState<ExpertDeliveryResult[]>([]);
  const runningCount = tasks.filter((task) => task.status === 'running').length;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  const queuedCount = tasks.filter((task) => task.status === 'queued').length;
  const filteredTasks = tasks.filter((task) => {
    if (filter === 'all') return true;
    if (filter === 'interrupted') return task.status === 'failed' || task.status === 'paused';
    return task.status === filter;
  });
  const selectedTaskMeta = selectedTask ? taskStatusMeta[selectedTask.status] : null;
  const selectedTaskCanRetry = selectedTask
    ? selectedTask.source === 'outbox' || selectedTask.status === 'queued' || selectedTask.status === 'failed' || selectedTask.status === 'paused'
    : false;

  async function handleExpertSubmit() {
    const question = expertQuestion.trim();
    if (!question || expertSubmitting) return;
    setExpertSubmitting(true);
    setExpertResults([]);
    try {
      setExpertResults(await onExpertPanelSubmit(question));
    } finally {
      setExpertSubmitting(false);
    }
  }

  return (
    <section className="page-section activity-page">
      <div className="task-header">
        <div><p className="eyebrow">Task Board</p><h1>任务动态</h1><span>移动任务清单与投递状态</span></div>
        <div className="task-header-icon"><OfficeIcon name="activity" size={23} /></div>
      </div>
      <div className="task-stats">
        <div><span className="task-stat-icon running"><OfficeIcon name="clock" size={16} /></span><strong>{runningCount}</strong><small>进行中</small></div>
        <div><span className="task-stat-icon completed"><OfficeIcon name="check" size={16} /></span><strong>{completedCount}</strong><small>已完成</small></div>
        <div><span className="task-stat-icon pending"><OfficeIcon name="database" size={16} /></span><strong>{queuedCount}</strong><small>待补投</small></div>
      </div>

      <div className="expert-panel">
        <div className="expert-panel-heading">
          <div className="expert-panel-icon"><OfficeIcon name="agent" size={20} /></div>
          <div><p>专家团</p><strong>默认召集三位专家共同执行</strong><small>本页仅展示投递结果，真实回答由 Hermes 通道或兜底队列承接</small></div>
        </div>
        <div className="expert-chips" aria-label="默认召集的专家">
          {expertPanelAgents.map((expert) => (
            <span key={expert.id} className={`expert-chip ${expert.id}`}>
              <i />
              <strong>{expert.name}</strong>
              <small>{expert.perspective}</small>
            </span>
          ))}
        </div>
        <textarea
          value={expertQuestion}
          onChange={(event) => setExpertQuestion(event.target.value)}
          placeholder="输入需要专家团共同判断或执行的问题"
          aria-label="专家团问题"
        />
        <button className="expert-submit" type="button" onClick={() => void handleExpertSubmit()} disabled={expertSubmitting || !expertQuestion.trim()}>
          <OfficeIcon name="send" size={16} />
          {expertSubmitting ? '正在召集…' : '召集专家团'}
        </button>
        {expertResults.length > 0 ? (
          <div className="expert-delivery-results" aria-live="polite">
            {expertResults.map((result) => (
              <div key={result.agentId} className={result.status}>
                <span><OfficeIcon name={result.status === 'delivered' ? 'check' : result.status === 'queued' ? 'database' : 'alert'} size={15} /></span>
                <div><strong>{formatAgentName(result.agentId)}</strong><small>{result.status === 'delivered' ? '已发送到 Hermes' : result.status === 'queued' ? '已入队兜底' : '失败'}</small></div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="outbox-card">
        <div className="outbox-main">
          <div className="outbox-icon"><OfficeIcon name="database" size={20} /></div>
          <div><p>兜底队列</p><strong>{outbox.count} 条任务待补投</strong><small>{retryStatus || 'Hermes 通道恢复后可逐条重试'}</small></div>
          <button className="mini-button" onClick={onRetryOutbox} disabled={retrying || outbox.count === 0}>
            <OfficeIcon name="refresh" size={15} />
            {retrying ? '重试中…' : '逐条重试'}
          </button>
        </div>
        <div className="outbox-auto">
          <div className="outbox-auto-heading">
            <div className={`outbox-auto-icon ${autoRetryEnabled ? 'running' : autoRetryReport.completed ? 'completed' : ''}`}>
              <OfficeIcon name={autoRetryEnabled ? 'refresh' : autoRetryReport.completed ? 'check' : 'clock'} size={17} />
            </div>
            <div className="outbox-auto-copy">
              <strong>自动补投</strong>
              <small>每 60 秒仅补投 1 条，默认关闭，仅当前任务页会话</small>
            </div>
            <button
              className={`safe-switch ${autoRetryEnabled ? 'enabled' : ''}`}
              type="button"
              role="switch"
              aria-checked={autoRetryEnabled}
              aria-label="自动补投"
              onClick={onToggleAutoRetry}
              disabled={outbox.count === 0 && !autoRetryEnabled}
            >
              <span />
            </button>
          </div>
          <div className="outbox-auto-status">
            <div><span>状态</span><strong>{autoRetryEnabled ? '运行中' : autoRetryReport.completed ? '已完成' : '关闭'}</strong></div>
            <div><span>最近一次尝试</span><strong>{formatAttemptTime(autoRetryReport.lastAttemptAt)}</strong></div>
          </div>
          {autoRetryReport.delivered !== null && autoRetryReport.remaining !== null ? (
            <div className="outbox-auto-result success"><OfficeIcon name="check" size={14} /><span>最近一次成功 {autoRetryReport.delivered} 条，剩余 {autoRetryReport.remaining} 条</span></div>
          ) : null}
          {autoRetryReport.error ? (
            <div className="outbox-auto-result error">
              <OfficeIcon name="alert" size={14} />
              <div><span>补投失败：{formatIssueReason(autoRetryReport.error)}</span>{isIssueCode(autoRetryReport.error) ? <small>{formatTechnicalMeta([`原始原因 ${autoRetryReport.error}`])}</small> : null}</div>
            </div>
          ) : null}
        </div>
        {outbox.items.length > 0 && <div className="outbox-preview">
          {outbox.items.slice(-3).reverse().map((item) => (
            <div key={item.id}>
              <strong>{formatAgentName(item.agent_id)}</strong>
              <span>{item.message_preview}</span>
              <small>{item.fallback_reason ? formatIssueReason(item.fallback_reason) : '等待投递'} · {formatTechnicalMeta([`员工标识 ${item.agent_id}`, item.fallback_reason ? `原始原因 ${item.fallback_reason}` : null])}</small>
            </div>
          ))}
        </div>}
      </div>

      <div className="task-filter-chips" aria-label="任务状态筛选">
        {taskFilters.map((item) => <button key={item.key} className={filter === item.key ? 'selected' : ''} onClick={() => setFilter(item.key)}>{item.label}</button>)}
      </div>

      <div className="section-heading"><div><p className="section-kicker">Unified History</p><h2>统一任务历史</h2></div><span>{filteredTasks.length} 项</span></div>
      {selectedTask && selectedTaskMeta ? (
        <aside className="task-detail-panel" id="task-detail-panel" aria-label="任务详情">
          <div className="task-detail-heading">
            <div className={`task-check ${selectedTask.status}`}><OfficeIcon name={selectedTaskMeta.icon} size={17} /></div>
            <div>
              <p>任务详情</p>
              <strong>{selectedTask.title}</strong>
            </div>
            <button className="task-detail-close" type="button" onClick={() => setSelectedTask(null)} aria-label="关闭任务详情">关闭</button>
          </div>
          <div className="task-detail-grid">
            <div><span>状态</span><strong className={`task-status ${selectedTask.status}`}>{selectedTaskMeta.label}</strong></div>
            <div><span>来源</span><strong>{taskSourceLabels[selectedTask.source] ?? selectedTask.source}</strong></div>
            <div><span>员工</span><strong>{selectedTask.agent_id ? formatAgentName(selectedTask.agent_id) : '未指定'}</strong></div>
            <div><span>时间</span><strong>{formatTime(selectedTask.time)}</strong></div>
          </div>
          <div className="task-detail-section">
            <span>任务详情</span>
            <p>{selectedTask.detail ? formatIssueReason(selectedTask.detail) : '暂无任务详情'}</p>
          </div>
          <div className="task-detail-section">
            <span>业务化失败原因</span>
            <p>{selectedTask.fallback_reason ? formatIssueReason(selectedTask.fallback_reason) : '未记录失败原因'}</p>
          </div>
          <div className="task-detail-section technical">
            <span>技术信息</span>
            <p>{formatTaskTechnicalMeta(selectedTask) || '暂无技术信息'}</p>
          </div>
          <div className="task-detail-id"><span>任务 ID</span><code>{selectedTask.id}</code></div>
          {selectedTaskCanRetry ? (
            <div className="task-detail-retry">
              <div><strong>可通过兜底队列逐条重试</strong><small>每次仅尝试补投 1 条现有队列任务</small></div>
              <button className="mini-button" type="button" onClick={onRetryOutbox} disabled={retrying || outbox.count === 0}>
                <OfficeIcon name="refresh" size={15} />
                {retrying ? '重试中…' : '逐条重试'}
              </button>
            </div>
          ) : null}
        </aside>
      ) : null}
      <div className="task-card-list">
        {filteredTasks.length === 0 ? <div className="empty-card">当前筛选下暂无任务。</div> : filteredTasks.map((task) => {
          const meta = taskStatusMeta[task.status];
          return <button
            className={`task-card ${selectedTask?.id === task.id ? 'selected' : ''}`}
            key={task.id}
            type="button"
            onClick={() => setSelectedTask(task)}
            aria-expanded={selectedTask?.id === task.id}
            aria-controls="task-detail-panel"
          >
            <div className={`task-check ${task.status}`}><OfficeIcon name={meta.icon} size={16} /></div>
            <div className="task-card-content">
              <div><strong>{task.title}</strong><span className={`task-status ${task.status}`}>{meta.label}</span></div>
              <p>{formatTaskDetail(task, '暂无任务详情')}</p>
              <small>{taskSourceLabels[task.source] ?? task.source}{task.agent_id ? ` · ${formatAgentName(task.agent_id)}` : ''} · {formatTime(task.time)}{formatTaskTechnicalMeta(task) ? ` · ${formatTaskTechnicalMeta(task)}` : ''}</small>
            </div>
            <OfficeIcon name="chevron" size={17} className="task-chevron" />
          </button>;
        })}
      </div>
    </section>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const view = new URLSearchParams(window.location.search).get('view');
    return tabs.some((item) => item.key === view) ? view as Tab : 'office';
  });
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedId, setSelectedId] = useState('default');
  const [evolution, setEvolution] = useState<EvolutionData>({});
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [outbox, setOutbox] = useState<OutboxData>({ count: 0, items: [] });
  const [retrying, setRetrying] = useState(false);
  const [retryStatus, setRetryStatus] = useState('');
  const [autoRetryEnabled, setAutoRetryEnabled] = useState(false);
  const [autoRetryReport, setAutoRetryReport] = useState<AutoRetryReport>({ completed: false, lastAttemptAt: null, delivered: null, remaining: null, error: '' });
  const [offline, setOffline] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
  const retryingRef = useRef(false);

  useEffect(() => {
    Promise.all([fetchAgents(), fetchEvolution(), fetchTasks(), fetchOutbox()]).then(([agentRes, evolutionRes, taskRes, outboxRes]) => {
      setAgents(agentRes.data.agents);
      setSelectedId((current) => (
        current && agentRes.data.agents.some((agent) => agent.id === current)
          ? current
          : agentRes.data.agents[0]?.id ?? 'default'
      ));
      setEvolution(evolutionRes.data);
      setTasks(taskRes.data.items ?? []);
      setOutbox(outboxRes.data);
      setOffline(agentRes.offline || evolutionRes.offline || taskRes.offline || outboxRes.offline);
    });
  }, []);

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

  async function handleExpertPanelSubmit(question: string) {
    const deliveryResults = await Promise.allSettled(expertPanelAgents.map(async (expert) => {
      const message = `你正在参与“专家团执行”协作。你的角色是${expert.name}，负责${expert.perspective}。${expert.prompt}\n\n用户问题：\n${question}`;
      return sendMessage(expert.id, message);
    }));
    const results = deliveryResults.map<ExpertDeliveryResult>((result, index) => {
      const agentId = expertPanelAgents[index].id;
      if (result.status === 'rejected') {
        return { agentId, status: 'failed', error: result.reason instanceof Error ? result.reason.message : '发送失败' };
      }
      if (result.value.delivered) return { agentId, status: 'delivered' };
      if (result.value.queued) return { agentId, status: 'queued' };
      return { agentId, status: 'failed', error: result.value.error || result.value.fallback_reason || '发送失败' };
    });
    const [refreshedOutbox, refreshedTasks] = await Promise.all([fetchOutbox(), fetchTasks()]);
    setOutbox(refreshedOutbox.data);
    setTasks(refreshedTasks.data.items ?? []);
    return results;
  }

  async function handleWorkspaceExpertSubmit(memberIds: ExpertAgentId[], workspaceName: string, goal: string, question: string) {
    const deliveryResults = await Promise.allSettled(memberIds.map(async (agentId) => {
      const expert = expertPanelAgents.find((item) => item.id === agentId);
      const message = `你正在参与工作空间“${workspaceName}”的专家协作。\n空间目标：${goal}\n成员角色视角：${expert?.name ?? formatAgentName(agentId)} · ${expert?.perspective ?? '空间成员视角'}。${expert?.prompt ?? ''}\n\n用户问题：\n${question}`;
      return sendMessage(agentId, message);
    }));
    const results = deliveryResults.map<ExpertDeliveryResult>((result, index) => {
      const agentId = memberIds[index];
      if (result.status === 'rejected') {
        return { agentId, status: 'failed', error: result.reason instanceof Error ? result.reason.message : '发送失败' };
      }
      if (result.value.delivered) return { agentId, status: 'delivered' };
      if (result.value.queued) return { agentId, status: 'queued' };
      return { agentId, status: 'failed', error: result.value.error || result.value.fallback_reason || '发送失败' };
    });
    const [refreshedOutbox, refreshedTasks] = await Promise.all([fetchOutbox(), fetchTasks()]);
    setOutbox(refreshedOutbox.data);
    setTasks(refreshedTasks.data.items ?? []);
    return results;
  }

  async function handleWorkspaceDispatch(agentId: ExpertAgentId, workspaceName: string, goal: string, task: string) {
    const expert = expertPanelAgents.find((item) => item.id === agentId);
    const message = `你收到来自工作空间“${workspaceName}”的单人派活。\n空间名称：${workspaceName}\n项目目标：${goal}\n目标成员角色视角：${expert?.name ?? formatAgentName(agentId)} · ${expert?.perspective ?? '空间成员视角'}。${expert?.prompt ?? ''}\n\n任务内容：\n${task}`;
    let result: ExpertDeliveryResult;
    try {
      const response = await sendMessage(agentId, message);
      if (response.delivered) result = { agentId, status: 'delivered' };
      else if (response.queued) result = { agentId, status: 'queued' };
      else result = { agentId, status: 'failed', error: response.error || response.fallback_reason || '发送失败' };
    } catch (error) {
      result = { agentId, status: 'failed', error: error instanceof Error ? error.message : '发送失败' };
    }
    const [refreshedOutbox, refreshedTasks] = await Promise.all([fetchOutbox(), fetchTasks()]);
    setOutbox(refreshedOutbox.data);
    setTasks(refreshedTasks.data.items ?? []);
    return result;
  }

  async function performOutboxRetry(mode: 'manual' | 'auto') {
    if (retryingRef.current || outbox.count === 0) return;
    retryingRef.current = true;
    setRetrying(true);
    if (mode === 'manual') setRetryStatus('');
    const attemptedAt = new Date().toISOString();
    if (mode === 'auto') setAutoRetryReport((current) => ({ ...current, completed: false, lastAttemptAt: attemptedAt, error: '' }));
    try {
      const result = await retryOutbox(1);
      const failure = result.failures?.[0]?.fallback_reason;
      if (mode === 'manual') {
        const summary = `已尝试 ${result.attempted} 条，成功 ${result.delivered} 条，剩余 ${result.remaining} 条`;
        const failureCopy = failure ? ` · ${formatIssueReason(failure)} · ${formatTechnicalMeta([`原始原因 ${failure}`])}` : '';
        setRetryStatus(`${summary}${failureCopy}`);
      }
      if (mode === 'auto') {
        setAutoRetryReport({
          completed: result.remaining === 0,
          lastAttemptAt: attemptedAt,
          delivered: result.delivered,
          remaining: result.remaining,
          error: failure ?? '',
        });
        if (result.remaining === 0) setAutoRetryEnabled(false);
      }
      const [refreshedOutbox, refreshedTasks] = await Promise.all([fetchOutbox(), fetchTasks()]);
      setOutbox(refreshedOutbox.data);
      setTasks(refreshedTasks.data.items ?? []);
    } catch (error) {
      const message = error instanceof Error ? error.message : '重试失败';
      if (mode === 'manual') setRetryStatus(`${formatIssueReason(message)}${isIssueCode(message) ? ` · ${formatTechnicalMeta([`原始原因 ${message}`])}` : ''}`);
      else setAutoRetryReport((current) => ({ ...current, lastAttemptAt: attemptedAt, error: message }));
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  }

  function handleRetryOutbox() {
    void performOutboxRetry('manual');
  }

  function handleToggleAutoRetry() {
    if (autoRetryEnabled) {
      setAutoRetryEnabled(false);
      setAutoRetryReport((current) => ({ ...current, completed: false }));
      return;
    }
    if (outbox.count === 0) {
      setAutoRetryReport((current) => ({ ...current, completed: true, remaining: 0, error: '' }));
      return;
    }
    setAutoRetryEnabled(true);
    setAutoRetryReport((current) => ({ ...current, completed: false, error: '' }));
  }

  useEffect(() => {
    if (!autoRetryEnabled || tab !== 'activity' || outbox.count === 0) return;
    const timer = window.setInterval(() => {
      void performOutboxRetry('auto');
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [autoRetryEnabled, tab, outbox.count]);

  useEffect(() => {
    if (!autoRetryEnabled || outbox.count !== 0) return;
    setAutoRetryEnabled(false);
    setAutoRetryReport((current) => ({ ...current, completed: true, remaining: 0, error: '' }));
  }, [autoRetryEnabled, outbox.count]);

  async function handleInstall() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') setInstalled(true);
    setInstallPrompt(null);
  }

  function handleTabChange(nextTab: Tab) {
    if (nextTab !== 'activity' && autoRetryEnabled) {
      setAutoRetryEnabled(false);
      setAutoRetryReport((current) => ({ ...current, completed: false }));
    }
    setTab(nextTab);
    const url = new URL(window.location.href);
    if (nextTab === 'office') url.searchParams.delete('view');
    else url.searchParams.set('view', nextTab);
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }

  function handleSelectAgentFromOffice(agentId: string) {
    setSelectedId(agentId);
    setTab('agent');
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'agent');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }

  const pageTitle = tabs.find((item) => item.key === tab)?.label ?? '办公室';

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <span>HERMES OFFICE</span>
          <strong>{pageTitle}</strong>
        </div>
        <div className={`connection-state ${offline ? 'offline' : ''}`}><span />{offline ? '离线数据' : '已连接'}</div>
      </header>
      <OfflineBanner show={offline} />
      {tab === 'office' && <OfficePage agents={agents} tasks={tasks} selectedId={selectedId} setSelectedId={setSelectedId} onSelectAgent={handleSelectAgentFromOffice} pending={outbox.count} backendOffline={offline} installPrompt={installPrompt} installed={installed} onInstall={handleInstall} />}
      {tab === 'workspace' && <WorkspacePage tasks={tasks} onDispatch={handleWorkspaceDispatch} onExpertSubmit={handleWorkspaceExpertSubmit} />}
      {tab === 'agent' && <AgentPage agent={selectedAgent} tasks={tasks} evolution={evolution} />}
      {tab === 'evolution' && <EvolutionPage evolution={evolution} />}
      {tab === 'activity' && <ActivityPage tasks={tasks} outbox={outbox} onExpertPanelSubmit={handleExpertPanelSubmit} onRetryOutbox={handleRetryOutbox} retryStatus={retryStatus} retrying={retrying} autoRetryEnabled={autoRetryEnabled} autoRetryReport={autoRetryReport} onToggleAutoRetry={handleToggleAutoRetry} />}
      <nav className="tabbar" aria-label="主导航">
        {tabs.map(({ key, label, icon }) => (
          <button key={key} className={tab === key ? 'selected' : ''} onClick={() => handleTabChange(key)}>
            <OfficeIcon name={icon} size={21} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </main>
  );
}

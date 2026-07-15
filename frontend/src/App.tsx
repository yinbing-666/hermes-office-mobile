import { useEffect, useMemo, useState } from 'react';
import { fetchActivity, fetchAgents, fetchCron, fetchEvolution, fetchOutbox, retryOutbox, sendMessage } from './api';
import { OfficeIcon, type OfficeIconName } from './components/OfficeIcon';
import type { ActivityItem, AgentInfo, CronJob, EvolutionData, OutboxData } from './types';

type Tab = 'office' | 'agent' | 'evolution' | 'activity';

const roleMap: Record<string, { role: string; focus: string; tone: string }> = {
  default: { role: '主控与知识系统', focus: '调度专家团、维护知识库、派发开发任务', tone: 'slate' },
  'media-ops': { role: '内容与媒体运营', focus: '负责选题、内容改写与多平台分发', tone: 'blue' },
  investor: { role: '商业与投资分析', focus: '负责定价、商业模式与收益风险判断', tone: 'sand' },
};

const tabs: Array<{ key: Tab; label: string; icon: OfficeIconName }> = [
  { key: 'office', label: '办公室', icon: 'office' },
  { key: 'agent', label: '员工', icon: 'agent' },
  { key: 'evolution', label: '进化', icon: 'growth' },
  { key: 'activity', label: '任务', icon: 'activity' },
];

function formatTime(value?: string | null) {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
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
      <span>当前显示离线模拟数据，后端连接后会自动切换真实状态。</span>
    </div>
  );
}

function AgentPortrait({ tone, large = false }: { tone: string; large?: boolean }) {
  return (
    <div className={`agent-portrait tone-${tone} ${large ? 'large' : ''}`} aria-hidden="true">
      <span className="portrait-head">
        <span />
        <span />
      </span>
      <span className="portrait-body" />
    </div>
  );
}

function AgentCard({ agent, active, onClick }: { agent: AgentInfo; active: boolean; onClick: () => void }) {
  const meta = roleMap[agent.id] ?? { role: 'Hermes Agent', focus: '自定义智能员工', tone: 'blue' };
  return (
    <button className={`workstation-card ${active ? 'active' : ''}`} onClick={onClick}>
      <div className="desk-scene">
        <div className="monitor-shell">
          <OfficeIcon name="monitor" size={35} />
          <span className={`monitor-signal ${agent.status === 'online' ? 'online' : ''}`} />
        </div>
        <AgentPortrait tone={meta.tone} />
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

function OfficePage({ agents, selectedId, setSelectedId, pending }: { agents: AgentInfo[]; selectedId: string; setSelectedId: (id: string) => void; pending: number }) {
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
      <div className="section-heading">
        <div>
          <p className="section-kicker">Office Floor</p>
          <h2>员工工位</h2>
        </div>
        <span>{agents.length} 位员工</span>
      </div>
      <div className="agent-list">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} active={agent.id === selectedId} onClick={() => setSelectedId(agent.id)} />
        ))}
      </div>
    </section>
  );
}

function AgentPage({ agent }: { agent?: AgentInfo }) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState<{ type: 'sent' | 'error'; text: string } | null>(null);

  useEffect(() => {
    setMessage('');
    setSendStatus(null);
  }, [agent?.id]);

  if (!agent) return <div className="empty-card">暂无 Agent 数据。</div>;
  const meta = roleMap[agent.id] ?? { role: 'Hermes Agent', focus: '自定义智能员工', tone: 'blue' };

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
      <div className="detail-card">
        <AgentPortrait tone={meta.tone} large />
        <div className="detail-name">
          <h2>{agent.name}</h2>
          <StatusPill status={agent.status} />
        </div>
        <p>{meta.role}</p>
        <small>{meta.focus}</small>
      </div>
      <div className="info-grid">
        <div className="info-card"><span>Profile</span><strong>{agent.id}</strong></div>
        <div className="info-card"><span>端口</span><strong>{agent.port ?? '未配置'}</strong></div>
        <div className="info-card"><span>SOUL.md</span><strong>{agent.soul?.present ? '存在' : '暂无'}</strong><small>{formatTime(agent.soul?.modified_at)}</small></div>
        <div className="info-card"><span>AGENT.md</span><strong>{agent.agent?.present ? '存在' : '暂无'}</strong><small>{formatTime(agent.agent?.modified_at)}</small></div>
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
  const recentSkills = evolution.skills?.recent ?? [];
  const profiles = evolution.profiles ?? [];
  return (
    <section className="page-section">
      <div className="section-heading"><div><p className="section-kicker">Growth Log</p><h2>进化档案</h2></div></div>
      <div className="timeline-card">
        <div className="card-title-row"><OfficeIcon name="growth" size={19} /><h3>最近 Skills</h3></div>
        {recentSkills.length === 0 ? <p>暂无可展示 Skill 变化。</p> : recentSkills.slice(0, 8).map((skill) => (
          <div className="timeline-item" key={skill.name}>
            <span />
            <div><strong>{skill.name}</strong><small>{formatTime(skill.modified_at)}</small></div>
          </div>
        ))}
      </div>
      <div className="timeline-card">
        <div className="card-title-row"><OfficeIcon name="file" size={19} /><h3>人格文件</h3></div>
        {profiles.map((profile) => (
          <div className="timeline-item" key={profile.profile}>
            <span />
            <div><strong>{profile.name} / {profile.profile}</strong><small>SOUL：{formatTime(profile.soul?.modified_at)}</small></div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ActivityPage({ activity, cronJobs, outbox, onRetryOutbox, retryStatus, retrying }: { activity: ActivityItem[]; cronJobs: CronJob[]; outbox: OutboxData; onRetryOutbox: () => void; retryStatus: string; retrying: boolean }) {
  return (
    <section className="page-section">
      <div className="section-heading"><div><p className="section-kicker">Task Board</p><h2>任务动态</h2></div></div>
      <div className="timeline-card">
        <div className="card-title-row"><OfficeIcon name="clock" size={19} /><h3>Cron</h3></div>
        {cronJobs.slice(0, 8).map((job) => (
          <div className="job-row" key={job.id}>
            <div><strong>{job.name}</strong><small>{job.schedule ?? '未设置 schedule'}</small></div>
            <span className={job.enabled ? 'job-enabled' : 'job-disabled'}>{job.enabled ? 'enabled' : 'paused'}</span>
          </div>
        ))}
      </div>
      <div className="timeline-card">
        <div className="card-title-row"><OfficeIcon name="database" size={19} /><h3>兜底队列</h3></div>
        <div className="job-row">
          <div><strong>{outbox.count} 条待补投</strong><small>{retryStatus || '端口恢复后可手动重试投递'}</small></div>
          <button className="mini-button" onClick={onRetryOutbox} disabled={retrying || outbox.count === 0}>
            <OfficeIcon name="refresh" size={15} />
            {retrying ? '重试中…' : '重试 1 条'}
          </button>
        </div>
        {outbox.items.slice(-5).reverse().map((item) => (
          <div className="log-line" key={item.id}>{item.agent_id} · {item.message_preview} · {item.fallback_reason ?? 'queued'}</div>
        ))}
      </div>
      <div className="timeline-card">
        <div className="card-title-row"><OfficeIcon name="activity" size={19} /><h3>Gateway 活动</h3></div>
        {activity.slice(0, 12).map((item) => <div className="log-line" key={item.id}>{item.message}</div>)}
      </div>
    </section>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>('office');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedId, setSelectedId] = useState('default');
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [evolution, setEvolution] = useState<EvolutionData>({});
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [outbox, setOutbox] = useState<OutboxData>({ count: 0, items: [] });
  const [retrying, setRetrying] = useState(false);
  const [retryStatus, setRetryStatus] = useState('');
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    Promise.all([fetchAgents(), fetchActivity(), fetchEvolution(), fetchCron(), fetchOutbox()]).then(([agentRes, activityRes, evolutionRes, cronRes, outboxRes]) => {
      setAgents(agentRes.data.agents);
      setSelectedId(agentRes.data.agents[0]?.id ?? 'default');
      setActivity(activityRes.data.items ?? activityRes.data.events ?? []);
      setEvolution(evolutionRes.data);
      setCronJobs(cronRes.data.jobs ?? []);
      setOutbox(outboxRes.data);
      setOffline(agentRes.offline || activityRes.offline || evolutionRes.offline || cronRes.offline || outboxRes.offline);
    });
  }, []);

  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === selectedId) ?? agents[0], [agents, selectedId]);

  async function handleRetryOutbox() {
    if (retrying || outbox.count === 0) return;
    setRetrying(true);
    setRetryStatus('');
    try {
      const result = await retryOutbox(1);
      setRetryStatus(`已尝试 ${result.attempted} 条，成功 ${result.delivered} 条，剩余 ${result.remaining} 条`);
      const refreshed = await fetchOutbox();
      setOutbox(refreshed.data);
    } catch (error) {
      setRetryStatus(error instanceof Error ? error.message : '重试失败');
    } finally {
      setRetrying(false);
    }
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
      {tab === 'office' && <OfficePage agents={agents} selectedId={selectedId} setSelectedId={setSelectedId} pending={outbox.count} />}
      {tab === 'agent' && <AgentPage agent={selectedAgent} />}
      {tab === 'evolution' && <EvolutionPage evolution={evolution} />}
      {tab === 'activity' && <ActivityPage activity={activity} cronJobs={cronJobs} outbox={outbox} onRetryOutbox={handleRetryOutbox} retryStatus={retryStatus} retrying={retrying} />}
      <nav className="tabbar" aria-label="主导航">
        {tabs.map(({ key, label, icon }) => (
          <button key={key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>
            <OfficeIcon name={icon} size={21} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </main>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { fetchActivity, fetchAgents, fetchCron, fetchEvolution, fetchOutbox, retryOutbox, sendMessage } from './api';
import type { ActivityItem, AgentInfo, CronJob, EvolutionData, OutboxData } from './types';

type Tab = 'office' | 'agent' | 'evolution' | 'activity';

const roleMap: Record<string, { role: string; focus: string; emoji: string }> = {
  default: { role: '主控 / 知识系统 / 开发', focus: '调度专家团、维护 wiki、派发 Codex', emoji: '🖤' },
  'media-ops': { role: '内容 / 自媒体 / 分发', focus: '公众号、小红书、选题和改写', emoji: '🍊' },
  investor: { role: '商业 / 投资 / ROI', focus: '定价、商业模式、收益风险判断', emoji: '💰' },
};

function formatTime(value?: string | null) {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function StatusPill({ status }: { status: string }) {
  const online = status === 'online';
  return <span className={`pill ${online ? 'online' : 'offline'}`}>{online ? '在线' : '离线'}</span>;
}

function OfflineBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return <div className="offline-banner">当前显示离线模拟数据，后端连接后会自动切换真实状态。</div>;
}

function AgentCard({ agent, active, onClick }: { agent: AgentInfo; active: boolean; onClick: () => void }) {
  const meta = roleMap[agent.id] ?? { role: 'Hermes Agent', focus: '自定义分身', emoji: '🤖' };
  return (
    <button className={`agent-card ${active ? 'active' : ''}`} onClick={onClick}>
      <div className="avatar">{meta.emoji}</div>
      <div className="agent-main">
        <div className="agent-row">
          <strong>{agent.name}</strong>
          <StatusPill status={agent.status} />
        </div>
        <p>{meta.role}</p>
        <small>{meta.focus}</small>
      </div>
    </button>
  );
}

function OfficePage({ agents, selectedId, setSelectedId }: { agents: AgentInfo[]; selectedId: string; setSelectedId: (id: string) => void }) {
  const online = agents.filter((agent) => agent.status === 'online').length;
  return (
    <section className="page-section">
      <div className="hero-card">
        <p className="eyebrow">Hermes Office</p>
        <h1>饮冰 Agent 办公室</h1>
        <p>把小黑、小橙、小金当作 AI 员工管理：看状态、看进化、看任务，再随手派活。</p>
        <div className="stat-grid">
          <div><strong>{agents.length}</strong><span>员工</span></div>
          <div><strong>{online}</strong><span>在线</span></div>
          <div><strong>4</strong><span>工作区</span></div>
        </div>
      </div>
      <div className="section-title">员工工位</div>
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
  const meta = roleMap[agent.id] ?? { role: 'Hermes Agent', focus: '自定义分身', emoji: '🤖' };

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
        <div className="big-avatar">{meta.emoji}</div>
        <h2>{agent.name}</h2>
        <StatusPill status={agent.status} />
        <p>{meta.role}</p>
      </div>
      <div className="info-grid">
        <div className="info-card"><span>Profile</span><strong>{agent.id}</strong></div>
        <div className="info-card"><span>端口</span><strong>{agent.port ?? '未配置'}</strong></div>
        <div className="info-card"><span>SOUL.md</span><strong>{agent.soul?.present ? '存在' : '暂无'}</strong><small>{formatTime(agent.soul?.modified_at)}</small></div>
        <div className="info-card"><span>AGENT.md</span><strong>{agent.agent?.present ? '存在' : '暂无'}</strong><small>{formatTime(agent.agent?.modified_at)}</small></div>
      </div>
      <div className="compose-card">
        <label htmlFor="agent-task">派活入口</label>
        <textarea
          id="agent-task"
          value={message}
          maxLength={4000}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={`给${agent.name}发一条任务`}
        />
        <button disabled={sending || !message.trim()} onClick={handleSend}>
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
      <div className="section-title">进化档案</div>
      <div className="timeline-card">
        <h2>最近 Skills</h2>
        {recentSkills.length === 0 ? <p>暂无可展示 Skill 变化。</p> : recentSkills.slice(0, 8).map((skill) => (
          <div className="timeline-item" key={skill.name}>
            <span />
            <div><strong>{skill.name}</strong><small>{formatTime(skill.modified_at)}</small></div>
          </div>
        ))}
      </div>
      <div className="timeline-card">
        <h2>人格文件</h2>
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
      <div className="section-title">任务动态</div>
      <div className="timeline-card">
        <h2>Cron</h2>
        {cronJobs.slice(0, 8).map((job) => (
          <div className="job-row" key={job.id}>
            <div><strong>{job.name}</strong><small>{job.schedule ?? '未设置 schedule'}</small></div>
            <span className={job.enabled ? 'job-enabled' : 'job-disabled'}>{job.enabled ? 'enabled' : 'paused'}</span>
          </div>
        ))}
      </div>
      <div className="timeline-card">
        <h2>兜底队列</h2>
        <div className="job-row">
          <div><strong>{outbox.count} 条待补投</strong><small>{retryStatus || '端口恢复后可手动重试投递'}</small></div>
          <button className="mini-button" onClick={onRetryOutbox} disabled={retrying || outbox.count === 0}>
            {retrying ? '重试中…' : '重试 1 条'}
          </button>
        </div>
        {outbox.items.slice(-5).reverse().map((item) => (
          <div className="log-line" key={item.id}>
            {item.agent_id} · {item.message_preview} · {item.fallback_reason ?? 'queued'}
          </div>
        ))}
      </div>
      <div className="timeline-card">
        <h2>Gateway 活动</h2>
        {activity.slice(0, 12).map((item) => (
          <div className="log-line" key={item.id}>{item.message}</div>
        ))}
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div><span>虾马办公室</span><strong>{tab === 'office' ? '办公室' : tab === 'agent' ? 'Agent 详情' : tab === 'evolution' ? '进化档案' : '任务动态'}</strong></div>
        <span className="sync-dot">●</span>
      </header>
      <OfflineBanner show={offline} />
      {tab === 'office' && <OfficePage agents={agents} selectedId={selectedId} setSelectedId={setSelectedId} />}
      {tab === 'agent' && <AgentPage agent={selectedAgent} />}
      {tab === 'evolution' && <EvolutionPage evolution={evolution} />}
      {tab === 'activity' && <ActivityPage activity={activity} cronJobs={cronJobs} outbox={outbox} onRetryOutbox={handleRetryOutbox} retryStatus={retryStatus} retrying={retrying} />}
      <nav className="tabbar" aria-label="主导航">
        {[
          ['office', '办公室', '🏢'],
          ['agent', 'Agent', '🤖'],
          ['evolution', '进化', '🌱'],
          ['activity', '动态', '📋'],
        ].map(([key, label, icon]) => (
          <button key={key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key as Tab)}>
            <span>{icon}</span>{label}
          </button>
        ))}
      </nav>
    </main>
  );
}

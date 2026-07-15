import { useEffect, useMemo, useState } from 'react';
import { fetchActivity, fetchAgents, fetchCron, fetchEvolution, fetchOutbox, retryOutbox, sendMessage } from './api';
import { OfficeIcon, type OfficeIconName } from './components/OfficeIcon';
import type { ActivityItem, AgentInfo, CronJob, EvolutionData, OutboxData } from './types';

type Tab = 'office' | 'agent' | 'evolution' | 'activity';

const roleMap: Record<string, { role: string; focus: string; tone: string; avatar: string }> = {
  default: { role: '主控与知识系统', focus: '调度专家团、维护知识库、派发开发任务', tone: 'slate', avatar: '/avatars/default.png' },
  'media-ops': { role: '内容与媒体运营', focus: '负责选题、内容改写与多平台分发', tone: 'blue', avatar: '/avatars/media-ops.png' },
  investor: { role: '商业与投资分析', focus: '负责定价、商业模式与收益风险判断', tone: 'sand', avatar: '/avatars/investor.png' },
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

function AgentPortrait({ tone, avatar, name, large = false }: { tone: string; avatar?: string; name: string; large?: boolean }) {
  return (
    <div className={`agent-portrait tone-${tone} ${large ? 'large' : ''}`}>
      {avatar ? <img src={avatar} alt={`${name}头像`} loading="lazy" /> : <OfficeIcon name="agent" size={large ? 36 : 26} />}
    </div>
  );
}

function AgentCard({ agent, active, onClick }: { agent: AgentInfo; active: boolean; onClick: () => void }) {
  const meta = roleMap[agent.id] ?? { role: 'Hermes Agent', focus: '自定义智能员工', tone: 'blue', avatar: '' };
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
  const meta = roleMap[agent.id] ?? { role: 'Hermes Agent', focus: '自定义智能员工', tone: 'blue', avatar: '' };

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
        <AgentPortrait tone={meta.tone} avatar={meta.avatar} name={agent.name} large />
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
        {skillTree.map((group) => (
          <div className="skill-tree-card" key={group.key}>
            <div className="skill-tree-head">
              <span><OfficeIcon name={skillTreeIcons[group.key] ?? 'growth'} size={17} /></span>
              <div><strong>{group.title}</strong><small>{group.children.length ? `${group.children.length} 项能力` : '待记录'}</small></div>
            </div>
            <div className="skill-tree-children">
              {group.children.length === 0 ? <span className="skill-tree-empty">暂无匹配 Skill</span> : group.children.map((skill) => <span key={skill.name}>{skill.name}</span>)}
            </div>
          </div>
        ))}
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

function ActivityPage({ activity, cronJobs, outbox, onRetryOutbox, retryStatus, retrying }: { activity: ActivityItem[]; cronJobs: CronJob[]; outbox: OutboxData; onRetryOutbox: () => void; retryStatus: string; retrying: boolean }) {
  const completedStatuses = ['completed', 'complete', 'success', 'succeeded', 'done'];
  const completedJobs = cronJobs.filter((job) => completedStatuses.includes(job.status.toLowerCase())).length;
  const activeJobs = cronJobs.filter((job) => job.enabled).length;

  return (
    <section className="page-section activity-page">
      <div className="task-header">
        <div><p className="eyebrow">Task Board</p><h1>任务动态</h1><span>移动任务清单与投递状态</span></div>
        <div className="task-header-icon"><OfficeIcon name="activity" size={23} /></div>
      </div>
      <div className="task-stats">
        <div><span className="task-stat-icon running"><OfficeIcon name="clock" size={16} /></span><strong>{activeJobs}</strong><small>进行中</small></div>
        <div><span className="task-stat-icon completed"><OfficeIcon name="check" size={16} /></span><strong>{completedJobs}</strong><small>已完成</small></div>
        <div><span className="task-stat-icon pending"><OfficeIcon name="database" size={16} /></span><strong>{outbox.count}</strong><small>待补投</small></div>
      </div>

      <div className="outbox-card">
        <div className="outbox-main">
          <div className="outbox-icon"><OfficeIcon name="database" size={20} /></div>
          <div><p>兜底队列</p><strong>{outbox.count} 条任务等待补投</strong><small>{retryStatus || 'Hermes 通道恢复后可逐条重试'}</small></div>
          <button className="mini-button" onClick={onRetryOutbox} disabled={retrying || outbox.count === 0}>
            <OfficeIcon name="refresh" size={15} />
            {retrying ? '重试中…' : '重试 1 条'}
          </button>
        </div>
        {outbox.items.length > 0 && <div className="outbox-preview">
          {outbox.items.slice(-3).reverse().map((item) => (
            <div key={item.id}><strong>{item.agent_id}</strong><span>{item.message_preview}</span><small>{item.fallback_reason ?? '等待投递'}</small></div>
          ))}
        </div>}
      </div>

      <div className="section-heading"><div><p className="section-kicker">Scheduled Tasks</p><h2>Cron 任务</h2></div><span>{cronJobs.length} 项</span></div>
      <div className="task-card-list">
        {cronJobs.length === 0 ? <div className="empty-card">暂无 Cron 任务。</div> : cronJobs.slice(0, 8).map((job) => (
          <div className="task-card" key={job.id}>
            <div className={`task-check ${job.enabled ? 'active' : ''}`}><OfficeIcon name={job.enabled ? 'clock' : 'check'} size={16} /></div>
            <div className="task-card-content">
              <div><strong>{job.name}</strong><span className={job.enabled ? 'task-status active' : 'task-status'}>{job.enabled ? '进行中' : '已停用'}</span></div>
              <p>{job.schedule ?? '暂无执行计划'}</p>
              <small>下次：{formatTime(job.next_run_at)} · 最近：{formatTime(job.last_run_at)}</small>
            </div>
            <OfficeIcon name="chevron" size={17} className="task-chevron" />
          </div>
        ))}
      </div>

      <div className="recent-events">
        <div className="recent-events-head"><span><OfficeIcon name="activity" size={18} /><strong>最近事件</strong></span><small>{activity.length ? `${Math.min(activity.length, 12)} 条 Gateway 记录` : '暂无记录'}</small></div>
        <div className="recent-event-list">
          {activity.length === 0 ? <p>暂无 Gateway 活动。</p> : activity.slice(0, 6).map((item) => <div key={item.id}>{item.message}</div>)}
        </div>
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

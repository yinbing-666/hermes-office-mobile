import { useState } from 'react';
import { OfficeIcon, OfficeIconName } from '../OfficeIcon';
import { EvolutionData } from '../../types';
// 

function formatTime(value?: string | null) {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function EvolutionPage({ evolution }: { evolution: EvolutionData }) {
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
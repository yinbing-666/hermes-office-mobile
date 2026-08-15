import { useEffect, useState } from 'react';
import { OfficeIcon } from '../OfficeIcon';
import { fetchTopics } from '../../api';

export function TopicsPage() {
    const [topics, setTopics] = useState<Array<{title: string; platform: string; reason: string; value: string}>>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [reloadToken, setReloadToken] = useState(0);

    useEffect(() => {
        fetchTopics().then((res) => {
            const data = res.data;
            if (data?.ok && data?.topics?.length) {
                setTopics(data.topics);
            } else {
                setError(res.offline ? '选题服务暂时不可用，请稍后重试' : data?.source === 'expired' ? '最近 48 小时没有有效选题数据' : data?.source === 'none' ? '今日尚未生成选题数据' : '暂无可展示的选题数据');
            }
            setLoading(false);
        }).catch(() => { setError('加载失败'); setLoading(false); });
    }, [reloadToken]);

    if (loading) return <section className="page-section"><p className="section-kicker">选题</p><p className="topics-loading" role="status">加载中…</p></section>;
    if (error) return (
        <section className="page-section">
            <p className="section-kicker">选题</p>
            <div className="empty-card topics-empty" role="status">
                <OfficeIcon name="file" size={19} />
                <p>{error}</p>
                <button className="mini-button" type="button" onClick={() => { setError(''); setLoading(true); setReloadToken((current) => current + 1); }}>重新读取</button>
            </div>
        </section>
    );

    return (
        <section className="page-section topics-page">
            <p className="section-kicker">Content选题</p>
            <h2>今日备选</h2>
            {topics.map((t, i) => (
                <div key={i} className="topics-card">
                    <div className="topics-header">
                        <span className="topics-title">{t.title}</span>
                        <span className={`topics-platform ${t.platform === '小红书' ? 'red' : 'blue'}`}>{t.platform}</span>
                    </div>
                    <p className="topics-reason">推荐理由：{t.reason}</p>
                    <p className="topics-value">价值：{t.value}</p>
                </div>
            ))}
        </section>
    );
}

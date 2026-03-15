'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '@/components/sidebar';
import { dashboard, agents, getToken, type DashboardStats, type Activity, type Agent } from '@/lib/api-client';

export default function DashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [agentList, setAgentList] = useState<Agent[]>([]);

  useEffect(() => {
    if (!getToken()) { router.replace('/login'); return; }
    dashboard.stats().then(setStats).catch(console.error);
    dashboard.activity(20).then(setActivities).catch(console.error);
    agents.list().then(setAgentList).catch(console.error);
  }, [router]);

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <h1 className="page-title">Dashboard</h1>
        </div>

        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-label">Total Agents</div>
            <div className="stat-value">{stats?.total_agents ?? '-'}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Active Agents</div>
            <div className="stat-value" style={{ color: 'var(--success)' }}>
              {stats?.active_agents ?? '-'}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Teams</div>
            <div className="stat-value">{stats?.total_teams ?? '-'}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Knowledge Bases</div>
            <div className="stat-value">{stats?.total_kb ?? '-'}</div>
          </div>
        </div>

        <div className="grid-2">
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Agent Status</h2>
            </div>
            {agentList.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No agents configured yet</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {agentList.map((agent) => (
                  <div
                    key={agent.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '8px 12px',
                      borderRadius: 8,
                      background: 'var(--bg)',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 500, fontSize: 14 }}>{agent.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {agent.client_name || agent.role}
                      </div>
                    </div>
                    <span className={`badge ${agent.status === 'active' ? 'badge-success' : 'badge-warning'}`}>
                      {agent.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Recent Activity</h2>
            </div>
            {activities.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No activity yet</p>
            ) : (
              <div className="activity-feed">
                {activities.map((a) => (
                  <div key={a.id} className="activity-item">
                    <span className="activity-time">
                      {new Date(a.created_at).toLocaleTimeString()}
                    </span>
                    <span className="activity-text">
                      <strong>{a.agent_name || a.agent_id}</strong>{' '}
                      {a.action_type.replace(/_/g, ' ')}
                      {a.ticket_display_id && ` — ${a.ticket_display_id}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Sidebar from '@/components/sidebar';
import { agents, getToken, type Agent } from '@/lib/api-client';

export default function AgentsPage() {
  const router = useRouter();
  const [agentList, setAgentList] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) { router.replace('/login'); return; }
    agents.list().then((data) => { setAgentList(data); setLoading(false); }).catch(console.error);
  }, [router]);

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this agent?')) return;
    await agents.delete(id);
    setAgentList((prev) => prev.filter((a) => a.id !== id));
  };

  const handleToggle = async (agent: Agent) => {
    if (agent.status === 'active') {
      const updated = await agents.pause(agent.id);
      setAgentList((prev) => prev.map((a) => (a.id === agent.id ? updated : a)));
    } else {
      const updated = await agents.start(agent.id);
      setAgentList((prev) => prev.map((a) => (a.id === agent.id ? updated : a)));
    }
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <h1 className="page-title">Agents</h1>
          <Link href="/agents/new" className="btn btn-primary">+ Create Agent</Link>
        </div>

        <div className="card">
          {loading ? (
            <p style={{ color: 'var(--text-muted)' }}>Loading...</p>
          ) : agentList.length === 0 ? (
            <div className="empty-state">
              <h3>No agents yet</h3>
              <p>Create your first agent to get started.</p>
            </div>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Client</th>
                    <th>Role</th>
                    <th>Specializations</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {agentList.map((agent) => {
                    const specs: string[] = JSON.parse(agent.specializations || '[]');
                    return (
                      <tr key={agent.id}>
                        <td>
                          <Link href={`/agents/${agent.id}`} style={{ color: 'var(--primary)', textDecoration: 'none' }}>
                            {agent.display_name || agent.name}
                          </Link>
                        </td>
                        <td>{agent.client_name || '(Pool)'}</td>
                        <td><span className="badge badge-info">{agent.role}</span></td>
                        <td>{specs.length > 0 ? specs.join(', ') : '-'}</td>
                        <td>
                          <span className={`badge ${agent.status === 'active' ? 'badge-success' : 'badge-warning'}`}>
                            {agent.status}
                          </span>
                        </td>
                        <td>
                          <div className="btn-group">
                            <button className="btn btn-sm" onClick={() => handleToggle(agent)}>
                              {agent.status === 'active' ? 'Pause' : 'Start'}
                            </button>
                            <Link href={`/agents/${agent.id}`} className="btn btn-sm">Edit</Link>
                            <button className="btn btn-sm btn-danger" onClick={() => handleDelete(agent.id)}>
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

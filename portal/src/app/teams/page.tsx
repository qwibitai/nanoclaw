'use client';
import { useEffect, useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Sidebar from '@/components/sidebar';
import { teams, agents, getToken, type TeamWithMembers, type Agent } from '@/lib/api-client';

export default function TeamsPage() {
  const router = useRouter();
  const [teamList, setTeamList] = useState<TeamWithMembers[]>([]);
  const [agentList, setAgentList] = useState<Agent[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [teamType, setTeamType] = useState('client');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!getToken()) { router.replace('/login'); return; }
    teams.list().then(setTeamList).catch(console.error);
    agents.list().then(setAgentList).catch(console.error);
  }, [router]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    await teams.create({ name, team_type: teamType, description: description || null });
    const updated = await teams.list();
    setTeamList(updated);
    setShowCreate(false);
    setName('');
    setDescription('');
    setLoading(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this team?')) return;
    await teams.delete(id);
    setTeamList((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <h1 className="page-title">Teams</h1>
          <button className="btn btn-primary" onClick={() => setShowCreate(!showCreate)}>
            {showCreate ? 'Cancel' : '+ Create Team'}
          </button>
        </div>

        {showCreate && (
          <div className="card" style={{ marginBottom: 24, maxWidth: 500 }}>
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label className="form-label">Team Name</label>
                <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g., ABC Corp Response Team" />
              </div>
              <div className="form-group">
                <label className="form-label">Team Type</label>
                <select className="form-select" value={teamType} onChange={(e) => setTeamType(e.target.value)}>
                  <option value="client">Client Team</option>
                  <option value="specialist">Specialist Pool</option>
                  <option value="cyber">Cybersecurity Response</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Description</label>
                <textarea className="form-textarea" value={description} onChange={(e) => setDescription(e.target.value)} style={{ minHeight: 60 }} />
              </div>
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? 'Creating...' : 'Create Team'}
              </button>
            </form>
          </div>
        )}

        {teamList.length === 0 ? (
          <div className="card">
            <div className="empty-state">
              <h3>No teams yet</h3>
              <p>Create a team to organize agents and set escalation rules.</p>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {teamList.map((team) => (
              <div key={team.id} className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">{team.name}</h2>
                    <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                      {team.team_type} team {team.description && `— ${team.description}`}
                    </p>
                  </div>
                  <div className="btn-group">
                    <Link href={`/teams/${team.id}`} className="btn btn-sm">Manage</Link>
                    <button className="btn btn-sm btn-danger" onClick={() => handleDelete(team.id)}>Delete</button>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 24 }}>
                  <div style={{ flex: 1 }}>
                    <h4 style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>MEMBERS</h4>
                    {team.members.length === 0 ? (
                      <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>No members</p>
                    ) : (
                      team.members.map((m) => (
                        <div key={m.agent_id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 14 }}>
                          <span>{m.agent_name || m.agent_id}</span>
                          <span className="badge badge-info">{m.role}</span>
                        </div>
                      ))
                    )}
                  </div>
                  <div style={{ flex: 1 }}>
                    <h4 style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>ESCALATION RULES</h4>
                    {team.escalation_rules.length === 0 ? (
                      <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>No rules configured</p>
                    ) : (
                      team.escalation_rules.map((r) => (
                        <div key={r.id} style={{ padding: '6px 0', fontSize: 14 }}>
                          {r.condition_type}: &quot;{r.condition_value}&quot; → {r.action}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

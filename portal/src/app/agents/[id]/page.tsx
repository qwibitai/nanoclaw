'use client';
import { useEffect, useState, FormEvent } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Sidebar from '@/components/sidebar';
import { agents, getToken, type Agent, type Activity } from '@/lib/api-client';

const SPECIALIZATIONS = [
  { value: 'general', label: 'General IT Support' },
  { value: 'cisco', label: 'Cisco Networking' },
  { value: 'fortinet', label: 'Fortinet Security' },
  { value: 'microsoft', label: 'Microsoft 365 / Azure' },
  { value: 'cybersecurity', label: 'Cybersecurity / SOC' },
];

export default function AgentDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [agent, setAgent] = useState<Agent | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [editing, setEditing] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState('dedicated');
  const [clientName, setClientName] = useState('');
  const [specs, setSpecs] = useState<string[]>([]);
  const [customInstructions, setCustomInstructions] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getToken()) { router.replace('/login'); return; }
    agents.get(id).then((data) => {
      setAgent(data);
      setName(data.name);
      setDisplayName(data.display_name || '');
      setRole(data.role);
      setClientName(data.client_name || '');
      setSpecs(JSON.parse(data.specializations || '[]'));
      setCustomInstructions(data.custom_instructions || '');
    }).catch(console.error);
    agents.activity(id).then(setActivity).catch(console.error);
  }, [id, router]);

  const toggleSpec = (v: string) => {
    setSpecs((prev) =>
      prev.includes(v) ? prev.filter((s) => s !== v) : [...prev, v],
    );
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const updated = await agents.update(id, {
        name,
        display_name: displayName || name,
        role: role as Agent['role'],
        client_name: clientName || null,
        specializations: JSON.stringify(specs),
        custom_instructions: customInstructions || null,
      });
      setAgent(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setLoading(false);
    }
  };

  if (!agent) return <div className="app-layout"><Sidebar /><main className="main-content"><p>Loading...</p></main></div>;

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1 className="page-title">{agent.display_name || agent.name}</h1>
            <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
              {agent.role} {agent.client_name ? `— ${agent.client_name}` : ''} | Folder: {agent.group_folder}
            </p>
          </div>
          <div className="btn-group">
            <button className="btn" onClick={() => setEditing(!editing)}>
              {editing ? 'Cancel' : 'Edit'}
            </button>
            <button
              className={`btn ${agent.status === 'active' ? 'btn-danger' : 'btn-primary'}`}
              onClick={async () => {
                const updated = agent.status === 'active'
                  ? await agents.pause(id)
                  : await agents.start(id);
                setAgent(updated);
              }}
            >
              {agent.status === 'active' ? 'Pause' : 'Start'}
            </button>
          </div>
        </div>

        <div className="grid-2">
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Configuration</h2>
            </div>

            {editing ? (
              <form onSubmit={handleSave}>
                <div className="form-group">
                  <label className="form-label">Name</label>
                  <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Display Name</label>
                  <input className="form-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Role</label>
                  <select className="form-select" value={role} onChange={(e) => setRole(e.target.value)}>
                    <option value="dedicated">Dedicated Client Agent</option>
                    <option value="specialist">Specialist</option>
                    <option value="cyber">Cybersecurity Response</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Client Name</label>
                  <input className="form-input" value={clientName} onChange={(e) => setClientName(e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Specializations</label>
                  {SPECIALIZATIONS.map((s) => (
                    <label key={s.value} className="form-checkbox">
                      <input type="checkbox" checked={specs.includes(s.value)} onChange={() => toggleSpec(s.value)} />
                      {s.label}
                    </label>
                  ))}
                </div>
                <div className="form-group">
                  <label className="form-label">Custom Instructions</label>
                  <textarea className="form-textarea" value={customInstructions} onChange={(e) => setCustomInstructions(e.target.value)} />
                </div>
                {error && <p className="error-text">{error}</p>}
                <div className="btn-group">
                  <button type="submit" className="btn btn-primary" disabled={loading}>
                    {loading ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </form>
            ) : (
              <div style={{ fontSize: 14 }}>
                <p><strong>Status:</strong> <span className={`badge ${agent.status === 'active' ? 'badge-success' : 'badge-warning'}`}>{agent.status}</span></p>
                <p style={{ marginTop: 12 }}><strong>Role:</strong> {agent.role}</p>
                <p><strong>Client:</strong> {agent.client_name || 'None (pool agent)'}</p>
                <p><strong>Specializations:</strong> {specs.length > 0 ? specs.join(', ') : 'None'}</p>
                {agent.custom_instructions && (
                  <div style={{ marginTop: 12 }}>
                    <strong>Custom Instructions:</strong>
                    <pre style={{ marginTop: 4, padding: 12, borderRadius: 8, background: 'var(--bg)', fontSize: 13, whiteSpace: 'pre-wrap' }}>
                      {agent.custom_instructions}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Recent Activity</h2>
            </div>
            {activity.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No activity yet</p>
            ) : (
              <div className="activity-feed">
                {activity.slice(0, 20).map((a) => (
                  <div key={a.id} className="activity-item">
                    <span className="activity-time">{new Date(a.created_at).toLocaleTimeString()}</span>
                    <span className="activity-text">
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

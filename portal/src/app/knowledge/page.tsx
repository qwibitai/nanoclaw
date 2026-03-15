'use client';
import { useEffect, useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Sidebar from '@/components/sidebar';
import { kb, agents, getToken, type KBWithDocs, type Agent } from '@/lib/api-client';

export default function KnowledgePage() {
  const router = useRouter();
  const [kbList, setKbList] = useState<KBWithDocs[]>([]);
  const [agentList, setAgentList] = useState<Agent[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState('global');
  const [assignedAgent, setAssignedAgent] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!getToken()) { router.replace('/login'); return; }
    kb.list().then(setKbList).catch(console.error);
    agents.list().then(setAgentList).catch(console.error);
  }, [router]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    await kb.create({
      name,
      scope,
      assigned_agent_id: assignedAgent || null,
      description: description || null,
    });
    const updated = await kb.list();
    setKbList(updated);
    setShowCreate(false);
    setName('');
    setDescription('');
    setLoading(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this knowledge base?')) return;
    await kb.delete(id);
    setKbList((prev) => prev.filter((k) => k.id !== id));
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <h1 className="page-title">Knowledge Bases</h1>
          <button className="btn btn-primary" onClick={() => setShowCreate(!showCreate)}>
            {showCreate ? 'Cancel' : '+ Create KB'}
          </button>
        </div>

        {showCreate && (
          <div className="card" style={{ marginBottom: 24, maxWidth: 500 }}>
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label className="form-label">KB Name</label>
                <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g., Cisco Runbooks" />
              </div>
              <div className="form-group">
                <label className="form-label">Scope</label>
                <select className="form-select" value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="global">Global — All agents</option>
                  <option value="specialist">Specialist — Specific agent</option>
                  <option value="client">Client — Client agent only</option>
                </select>
              </div>
              {scope !== 'global' && (
                <div className="form-group">
                  <label className="form-label">Assigned Agent</label>
                  <select className="form-select" value={assignedAgent} onChange={(e) => setAssignedAgent(e.target.value)}>
                    <option value="">Select agent...</option>
                    {agentList.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="form-group">
                <label className="form-label">Description</label>
                <textarea className="form-textarea" value={description} onChange={(e) => setDescription(e.target.value)} style={{ minHeight: 60 }} />
              </div>
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? 'Creating...' : 'Create KB'}
              </button>
            </form>
          </div>
        )}

        <div className="card">
          {kbList.length === 0 ? (
            <div className="empty-state">
              <h3>No knowledge bases</h3>
              <p>Create a knowledge base to give your agents reference material.</p>
            </div>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Scope</th>
                    <th>Documents</th>
                    <th>Description</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {kbList.map((k) => (
                    <tr key={k.id}>
                      <td>
                        <Link href={`/knowledge/${k.id}`} style={{ color: 'var(--primary)', textDecoration: 'none' }}>
                          {k.name}
                        </Link>
                      </td>
                      <td><span className="badge badge-info">{k.scope}</span></td>
                      <td>{k.documents.length}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{k.description || '-'}</td>
                      <td>
                        <div className="btn-group">
                          <Link href={`/knowledge/${k.id}`} className="btn btn-sm">Manage</Link>
                          <button className="btn btn-sm btn-danger" onClick={() => handleDelete(k.id)}>Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

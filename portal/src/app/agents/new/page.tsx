'use client';
import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '@/components/sidebar';
import { agents, getToken } from '@/lib/api-client';

const SPECIALIZATIONS = [
  { value: 'general', label: 'General IT Support' },
  { value: 'cisco', label: 'Cisco Networking' },
  { value: 'fortinet', label: 'Fortinet Security' },
  { value: 'microsoft', label: 'Microsoft 365 / Azure' },
  { value: 'cybersecurity', label: 'Cybersecurity / SOC' },
];

export default function NewAgentPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState('dedicated');
  const [clientName, setClientName] = useState('');
  const [clientId, setClientId] = useState('');
  const [specs, setSpecs] = useState<string[]>(['general']);
  const [customInstructions, setCustomInstructions] = useState('');
  const [autoAccept, setAutoAccept] = useState(true);
  const [searchKb, setSearchKb] = useState(true);
  const [checkHistory, setCheckHistory] = useState(true);
  const [autoResolve, setAutoResolve] = useState(false);
  const [escalateTimeout, setEscalateTimeout] = useState('15');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (typeof window !== 'undefined' && !getToken()) {
    router.replace('/login');
    return null;
  }

  const toggleSpec = (v: string) => {
    setSpecs((prev) =>
      prev.includes(v) ? prev.filter((s) => s !== v) : [...prev, v],
    );
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await agents.create({
        name,
        display_name: displayName || name,
        role: role as 'dedicated' | 'specialist' | 'cyber' | 'custom',
        client_name: role === 'dedicated' ? clientName : null,
        client_id: clientId ? parseInt(clientId, 10) : null,
        specializations: JSON.stringify(specs),
        triage_config: JSON.stringify({
          autoAccept,
          searchKb,
          checkHistory,
          autoResolve,
          escalateTimeout: parseInt(escalateTimeout, 10) || 15,
        }),
        custom_instructions: customInstructions || null,
      });
      router.push('/agents');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create agent');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <h1 className="page-title">Create Agent</h1>
        </div>

        <div className="card" style={{ maxWidth: 700 }}>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">Agent Name</label>
              <input
                className="form-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., ABC-Support"
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">Display Name</label>
              <input
                className="form-input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g., ABC Corp Support Agent"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Agent Role</label>
              <select className="form-select" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="dedicated">Dedicated Client Agent</option>
                <option value="specialist">Specialist (Cisco/Fortinet/MS)</option>
                <option value="cyber">Cybersecurity Response</option>
                <option value="custom">Custom</option>
              </select>
            </div>

            {role === 'dedicated' && (
              <>
                <div className="form-group">
                  <label className="form-label">Client Name</label>
                  <input
                    className="form-input"
                    value={clientName}
                    onChange={(e) => setClientName(e.target.value)}
                    placeholder="e.g., ABC Corporation"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Vivantio Client ID (optional)</label>
                  <input
                    className="form-input"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="e.g., 12345"
                    type="number"
                  />
                </div>
              </>
            )}

            <div className="form-group">
              <label className="form-label">Specializations</label>
              {SPECIALIZATIONS.map((s) => (
                <label key={s.value} className="form-checkbox">
                  <input
                    type="checkbox"
                    checked={specs.includes(s.value)}
                    onChange={() => toggleSpec(s.value)}
                  />
                  {s.label}
                </label>
              ))}
            </div>

            <div className="form-group">
              <label className="form-label">Triage Behavior</label>
              <label className="form-checkbox">
                <input type="checkbox" checked={autoAccept} onChange={(e) => setAutoAccept(e.target.checked)} />
                Auto-accept assigned tickets
              </label>
              <label className="form-checkbox">
                <input type="checkbox" checked={searchKb} onChange={(e) => setSearchKb(e.target.checked)} />
                Search knowledge base before responding
              </label>
              <label className="form-checkbox">
                <input type="checkbox" checked={checkHistory} onChange={(e) => setCheckHistory(e.target.checked)} />
                Check client ticket history
              </label>
              <label className="form-checkbox">
                <input type="checkbox" checked={autoResolve} onChange={(e) => setAutoResolve(e.target.checked)} />
                Auto-resolve with KB match
              </label>
            </div>

            <div className="form-group">
              <label className="form-label">Escalation Timeout (minutes)</label>
              <input
                className="form-input"
                type="number"
                value={escalateTimeout}
                onChange={(e) => setEscalateTimeout(e.target.value)}
                style={{ width: 120 }}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Custom Instructions</label>
              <textarea
                className="form-textarea"
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                placeholder="Additional instructions for this agent..."
              />
            </div>

            {error && <p className="error-text">{error}</p>}

            <div className="btn-group" style={{ marginTop: 24 }}>
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? 'Creating...' : 'Create Agent'}
              </button>
              <button type="button" className="btn" onClick={() => router.push('/agents')}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}

'use client';
import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Sidebar from '@/components/sidebar';
import { teams, agents, getToken, type TeamWithMembers, type Agent } from '@/lib/api-client';

export default function TeamDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [team, setTeam] = useState<TeamWithMembers | null>(null);
  const [agentList, setAgentList] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [memberRole, setMemberRole] = useState('member');
  const [ruleType, setRuleType] = useState('category');
  const [ruleValue, setRuleValue] = useState('');
  const [ruleTarget, setRuleTarget] = useState('');
  const [ruleAction, setRuleAction] = useState('escalate');

  useEffect(() => {
    if (!getToken()) { router.replace('/login'); return; }
    teams.get(id).then(setTeam).catch(console.error);
    agents.list().then(setAgentList).catch(console.error);
  }, [id, router]);

  const refreshTeam = async () => {
    const updated = await teams.get(id);
    setTeam(updated);
  };

  const handleAddMember = async () => {
    if (!selectedAgent) return;
    await teams.addMember(id, { agent_id: selectedAgent, role: memberRole });
    await refreshTeam();
    setSelectedAgent('');
  };

  const handleRemoveMember = async (agentId: string) => {
    await teams.removeMember(id, agentId);
    await refreshTeam();
  };

  const handleAddRule = async () => {
    if (!ruleValue || !ruleTarget) return;
    await teams.addRule(id, {
      condition_type: ruleType,
      condition_value: ruleValue,
      target_agent_id: ruleTarget,
      action: ruleAction,
    });
    await refreshTeam();
    setRuleValue('');
  };

  const handleDeleteRule = async (ruleId: string) => {
    await teams.deleteRule(id, ruleId);
    await refreshTeam();
  };

  if (!team) return <div className="app-layout"><Sidebar /><main className="main-content"><p>Loading...</p></main></div>;

  const memberIds = new Set(team.members.map((m) => m.agent_id));
  const availableAgents = agentList.filter((a) => !memberIds.has(a.id));

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1 className="page-title">{team.name}</h1>
            <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>{team.team_type} team</p>
          </div>
        </div>

        <div className="grid-2">
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Members</h2>
            </div>

            {team.members.map((m) => (
              <div key={m.agent_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <div style={{ fontWeight: 500, fontSize: 14 }}>{m.agent_name}</div>
                  <span className="badge badge-info" style={{ marginTop: 4 }}>{m.role}</span>
                </div>
                <button className="btn btn-sm btn-danger" onClick={() => handleRemoveMember(m.agent_id)}>Remove</button>
              </div>
            ))}

            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <select className="form-select" value={selectedAgent} onChange={(e) => setSelectedAgent(e.target.value)} style={{ flex: 1 }}>
                <option value="">Select agent...</option>
                {availableAgents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <select className="form-select" value={memberRole} onChange={(e) => setMemberRole(e.target.value)} style={{ width: 120 }}>
                <option value="primary">Primary</option>
                <option value="specialist">Specialist</option>
                <option value="member">Member</option>
              </select>
              <button className="btn btn-primary btn-sm" onClick={handleAddMember}>Add</button>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Escalation Rules</h2>
            </div>

            {team.escalation_rules.map((r) => (
              <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border)', fontSize: 14 }}>
                <div>
                  <span className="badge badge-info">{r.condition_type}</span>{' '}
                  &quot;{r.condition_value}&quot; → <strong>{r.action}</strong>
                </div>
                <button className="btn btn-sm btn-danger" onClick={() => handleDeleteRule(r.id)}>Delete</button>
              </div>
            ))}

            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <select className="form-select" value={ruleType} onChange={(e) => setRuleType(e.target.value)} style={{ width: 120 }}>
                  <option value="category">Category</option>
                  <option value="priority">Priority</option>
                  <option value="keyword">Keyword</option>
                  <option value="timeout">Timeout</option>
                </select>
                <input className="form-input" value={ruleValue} onChange={(e) => setRuleValue(e.target.value)} placeholder="Value (e.g., Network)" style={{ flex: 1 }} />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <select className="form-select" value={ruleTarget} onChange={(e) => setRuleTarget(e.target.value)} style={{ flex: 1 }}>
                  <option value="">Target agent...</option>
                  {agentList.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                <select className="form-select" value={ruleAction} onChange={(e) => setRuleAction(e.target.value)} style={{ width: 120 }}>
                  <option value="escalate">Escalate</option>
                  <option value="notify">Notify</option>
                  <option value="co-triage">Co-triage</option>
                </select>
                <button className="btn btn-primary btn-sm" onClick={handleAddRule}>Add Rule</button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

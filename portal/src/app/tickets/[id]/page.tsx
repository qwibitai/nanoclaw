'use client';
import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Sidebar from '@/components/sidebar';
import { tickets, getToken, type TicketDetail } from '@/lib/api-client';

export default function TicketDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [ticket, setTicket] = useState<TicketDetail | null>(null);

  useEffect(() => {
    if (!getToken()) { router.replace('/login'); return; }
    tickets.get(id).then(setTicket).catch(console.error);
  }, [id, router]);

  if (!ticket) return <div className="app-layout"><Sidebar /><main className="main-content"><p>Loading...</p></main></div>;

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <h1 className="page-title">Ticket #{ticket.ticket_id}</h1>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Agent Activity Timeline</h2>
          </div>
          <div className="activity-feed">
            {ticket.activities.map((a) => (
              <div key={a.id} className="activity-item">
                <span className="activity-time">{new Date(a.created_at).toLocaleString()}</span>
                <span className="activity-text">
                  <strong>{a.agent_name || a.agent_id}</strong>{' '}
                  {a.action_type.replace(/_/g, ' ')}
                  {a.detail && (
                    <pre style={{ marginTop: 4, fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>
                      {a.detail}
                    </pre>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}

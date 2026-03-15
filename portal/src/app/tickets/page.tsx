'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '@/components/sidebar';
import { tickets, getToken, type TicketSummary } from '@/lib/api-client';

export default function TicketsPage() {
  const router = useRouter();
  const [ticketList, setTicketList] = useState<TicketSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) { router.replace('/login'); return; }
    tickets.list().then((data) => { setTicketList(data); setLoading(false); }).catch(console.error);
  }, [router]);

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <h1 className="page-title">Tickets</h1>
        </div>

        <div className="card">
          {loading ? (
            <p style={{ color: 'var(--text-muted)' }}>Loading...</p>
          ) : ticketList.length === 0 ? (
            <div className="empty-state">
              <h3>No ticket activity yet</h3>
              <p>Ticket activity will appear here once agents start processing tickets from Vivantio.</p>
            </div>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Ticket ID</th>
                    <th>Agent</th>
                    <th>Actions</th>
                    <th>Last Activity</th>
                  </tr>
                </thead>
                <tbody>
                  {ticketList.map((t, idx) => (
                    <tr key={idx}>
                      <td>{t.ticket_display_id || `#${t.ticket_id}`}</td>
                      <td>{t.agent_id}</td>
                      <td>{t.actions.length} action{t.actions.length !== 1 ? 's' : ''}</td>
                      <td>{new Date(t.last_action).toLocaleString()}</td>
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

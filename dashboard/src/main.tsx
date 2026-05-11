import { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './auth/AuthGate.js';
import { KanbanBoard } from './views/KanbanBoard.js';
import { TaskDetail } from './views/TaskDetail.js';
import { SessionList } from './views/SessionList.js';
import { authMe as fetchAuthMe } from './lib/api.js';
import { startSSE } from './lib/sse.ts';
import type { AuthMe } from './lib/api.js';

function parseHash(): { route: string; taskId?: string } {
  const hash = location.hash.slice(1) || '/board';
  if (hash.startsWith('/task/')) return { route: 'task', taskId: hash.slice(6) };
  if (hash === '/sessions') return { route: 'sessions' };
  return { route: 'board' };
}

function App() {
  const [authState, setAuthState] = useState<'loading' | 'unauthenticated' | 'authenticated'>('loading');
  const [me, setMe] = useState<AuthMe | null>(null);
  const [hashState, setHashState] = useState(parseHash);

  useEffect(() => {
    // Wipe ?token= from URL before any network call (cycle-1 fix M33)
    if (location.search.includes('token')) {
      history.replaceState(null, '', location.pathname + location.hash);
    }

    fetchAuthMe()
      .then((m) => {
        setMe(m);
        setAuthState('authenticated');
        startSSE();
      })
      .catch((err: { status?: number }) => {
        if (err.status === 401) {
          setAuthState('unauthenticated');
        } else {
          setAuthState('unauthenticated');
        }
      });
  }, []);

  useEffect(() => {
    const handler = () => setHashState(parseHash());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const handleAuthenticated = useCallback((m: AuthMe) => {
    setMe(m);
    setAuthState('authenticated');
    startSSE();
  }, []);

  if (authState === 'loading') {
    return <div style={{ padding: 32, color: '#666' }}>Loading…</div>;
  }

  if (authState === 'unauthenticated') {
    return <AuthGate onAuthenticated={handleAuthenticated} />;
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <nav style={{ padding: '8px 16px', borderBottom: '1px solid #e0e0e0', display: 'flex', gap: 16 }}>
        <a href="#/board" style={{ fontSize: 14, textDecoration: hashState.route === 'board' ? 'underline' : 'none' }}>Board</a>
        <a href="#/sessions" style={{ fontSize: 14, textDecoration: hashState.route === 'sessions' ? 'underline' : 'none' }}>Sessions</a>
      </nav>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {hashState.route === 'board' && me && <KanbanBoard authMe={me} />}
        {hashState.route === 'task' && hashState.taskId && me && (
          <TaskDetail authMe={me} taskId={hashState.taskId} />
        )}
        {hashState.route === 'sessions' && me && <SessionList authMe={me} />}
      </div>
    </div>
  );
}

const root = document.getElementById('root')!;
createRoot(root).render(<App />);

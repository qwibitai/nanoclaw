import { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './auth/AuthGate.js';
import { KanbanBoard } from './views/KanbanBoard.js';
import { TaskDetail } from './views/TaskDetail.js';
import { SessionList } from './views/SessionList.js';
import { authMe as fetchAuthMe } from './lib/api.js';
import { startSSE } from './lib/sse.ts';
import type { AuthMe } from './lib/api.js';
import './styles.css';

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
    return <div style={{ padding: 32, color: 'var(--text-secondary)' }}>Loading…</div>;
  }

  if (authState === 'unauthenticated') {
    return <AuthGate onAuthenticated={handleAuthenticated} />;
  }

  // Mobile-first: the app's root is a natural document. Body scrolls; no
  // `height: 100vh` lock, no nested `overflow: hidden` chain (those clipped
  // content past the fold on phone viewports — only the inner divs could
  // scroll, and only the desktop split-pane layout exposed those scroll
  // boundaries with visible chrome). Nav uses `position: sticky` so it
  // stays accessible while the page scrolls. Views opt into desktop-style
  // fixed-pane layouts themselves via media queries.
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <nav
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          gap: 16,
          background: 'var(--bg-card)',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <a href="#/board" style={{ fontSize: 14, fontWeight: hashState.route === 'board' ? 600 : 400 }}>Board</a>
        <a href="#/sessions" style={{ fontSize: 14, fontWeight: hashState.route === 'sessions' ? 600 : 400 }}>Sessions</a>
      </nav>
      <div style={{ flex: 1 }}>
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

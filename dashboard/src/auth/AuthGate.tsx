import React, { useState } from 'react';
import { authMe, exchangeToken } from '../lib/api.js';
import type { AuthMe } from '../lib/api.js';

interface AuthGateProps {
  onAuthenticated: (me: AuthMe) => void;
}

export const AuthGate: React.FC<AuthGateProps> = ({ onAuthenticated }) => {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await exchangeToken(token);
      const me = await authMe();
      onAuthenticated(me);
    } catch (err: unknown) {
      const apiErr = err as { status?: number; error?: string };
      if (apiErr.status === 400) {
        setError('Invalid or expired token. DM `/dashboard-token` to an agent for a new one.');
      } else {
        setError('An unexpected error occurred. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div role="main" style={{ maxWidth: 400, margin: '80px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Spawn Board</h1>
      <p style={{ marginBottom: 16, color: '#666' }}>
        Paste your one-time access token to continue.
      </p>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="token-input" style={{ display: 'block', marginBottom: 4 }}>
            Token
          </label>
          <input
            id="token-input"
            type="text"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste token here"
            style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
            autoComplete="off"
            autoFocus
          />
        </div>
        {error && (
          <p role="alert" style={{ color: '#c00', marginBottom: 12 }}>
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={loading || !token.trim()}
          style={{ padding: '8px 16px' }}
        >
          {loading ? 'Verifying…' : 'Submit'}
        </button>
      </form>
    </div>
  );
};

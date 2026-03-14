'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
};

export default function NanoClawChat() {
  const [authenticated, setAuthenticated] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [isTyping, setIsTyping] = useState(false);

  const lastIdRef = useRef('$');
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    sourceRef.current?.close();

    const source = new EventSource(
      `/api/stream?lastId=${encodeURIComponent(lastIdRef.current)}`,
    );
    sourceRef.current = source;

    source.onopen = () => setConnected(true);

    source.onmessage = (event) => {
      let data: {
        type?: string;
        text?: string;
        isTyping?: string;
        timestamp?: number;
      };
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      if (event.lastEventId) {
        lastIdRef.current = event.lastEventId;
      }

      if (data.type === 'typing') {
        setIsTyping(data.isTyping === 'true');
        return;
      }

      if (data.type === 'message') {
        setIsTyping(false);
        setMessages((prev) => [
          ...prev,
          {
            id: `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            role: 'assistant',
            content: data.text || '',
            timestamp: data.timestamp || Date.now(),
          },
        ]);
      }
    };

    source.onerror = () => {
      setConnected(false);
      source.close();
      reconnectTimerRef.current = setTimeout(() => connect(), 3000);
    };
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    connect();
    return () => {
      sourceRef.current?.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, [authenticated, connect]);

  const authenticate = useCallback(async () => {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase }),
    });
    if (res.ok) {
      setAuthenticated(true);
      return;
    }
    alert('Authentication failed.');
  }, [passphrase]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text) return;

    setInput('');
    setMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        role: 'user',
        content: text,
        timestamp: Date.now(),
      },
    ]);
    setIsTyping(true);

    const messageId = crypto.randomUUID();
    await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, messageId }),
    });
  }, [input]);

  if (!authenticated) {
    return (
      <main style={{ maxWidth: 420, margin: '100px auto', padding: 16 }}>
        <h1>NanoClaw Web</h1>
        <p>Enter your shared passphrase.</p>
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void authenticate();
          }}
          style={{ width: '100%', padding: 10, marginBottom: 10 }}
        />
        <button onClick={() => void authenticate()} style={{ padding: '10px 14px' }}>
          Connect
        </button>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 860, margin: '40px auto', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>NanoClaw Web</h1>
        <span>{connected ? 'Connected' : 'Reconnecting...'}</span>
      </div>

      <div
        style={{
          border: '1px solid #ddd',
          borderRadius: 8,
          padding: 12,
          minHeight: 420,
          maxHeight: 420,
          overflowY: 'auto',
          background: '#fafafa',
        }}
      >
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              marginBottom: 10,
              padding: 10,
              borderRadius: 8,
              background: msg.role === 'user' ? '#d8ecff' : '#ececec',
              marginLeft: msg.role === 'user' ? 80 : 0,
              marginRight: msg.role === 'assistant' ? 80 : 0,
            }}
          >
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
              {msg.role === 'user' ? 'You' : 'NanoClaw'}
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
          </div>
        ))}
        {isTyping ? (
          <div style={{ fontStyle: 'italic', opacity: 0.8 }}>NanoClaw is typing...</div>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void sendMessage();
          }}
          placeholder="Type a message..."
          style={{ flex: 1, padding: 10 }}
        />
        <button onClick={() => void sendMessage()} style={{ padding: '10px 14px' }}>
          Send
        </button>
      </div>
    </main>
  );
}

'use client';
import { useEffect, useState, useRef, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '@/components/sidebar';
import {
  agents,
  chat,
  getToken,
  type Agent,
  type ChatMessage,
} from '@/lib/api-client';
import { useWebSocket } from '@/lib/websocket';

export default function ChatPage() {
  const router = useRouter();
  const [agentList, setAgentList] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { messages: wsMessages } = useWebSocket(selectedAgent);

  useEffect(() => {
    if (!getToken()) { router.replace('/login'); return; }
    agents.list().then(setAgentList).catch(console.error);
  }, [router]);

  useEffect(() => {
    if (selectedAgent) {
      chat.history(selectedAgent).then(setMessages).catch(console.error);
    } else {
      setMessages([]);
    }
  }, [selectedAgent]);

  // Append WebSocket messages
  useEffect(() => {
    if (wsMessages.length === 0) return;
    const latest = wsMessages[wsMessages.length - 1];
    if (latest.type === 'message' && latest.agent_id === selectedAgent) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          agent_id: selectedAgent,
          user_id: null,
          direction: latest.direction || 'outbound',
          content: latest.content || '',
          created_at: latest.timestamp || new Date().toISOString(),
        },
      ]);
    }
  }, [wsMessages, selectedAgent]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !selectedAgent) return;

    setSending(true);
    const content = input.trim();
    setInput('');

    // Optimistic update
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        agent_id: selectedAgent,
        user_id: 'me',
        direction: 'inbound',
        content,
        created_at: new Date().toISOString(),
      },
    ]);

    try {
      await chat.send(selectedAgent, content);
    } catch (err) {
      console.error('Send failed:', err);
    } finally {
      setSending(false);
    }
  };

  const selectedAgentData = agentList.find((a) => a.id === selectedAgent);

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 16 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600 }}>Chat with Agent</h1>
          <select
            className="form-select"
            value={selectedAgent}
            onChange={(e) => setSelectedAgent(e.target.value)}
            style={{ width: 250 }}
          >
            <option value="">Select an agent...</option>
            {agentList.map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_name || a.name} ({a.status})
              </option>
            ))}
          </select>
          {selectedAgentData && (
            <span className={`badge ${selectedAgentData.status === 'active' ? 'badge-success' : 'badge-warning'}`}>
              {selectedAgentData.status}
            </span>
          )}
        </div>

        {!selectedAgent ? (
          <div className="empty-state" style={{ flex: 1 }}>
            <h3>Select an agent to start chatting</h3>
            <p>Use chat to program agent behavior, request status updates, or test triage.</p>
          </div>
        ) : (
          <>
            {/* Messages */}
            <div className="chat-messages" style={{ flex: 1 }}>
              {messages.length === 0 && (
                <div className="empty-state">
                  <p>No messages yet. Send a message to start.</p>
                </div>
              )}
              {messages.map((msg) => (
                <div key={msg.id} className={`chat-message ${msg.direction}`}>
                  <div>{msg.content}</div>
                  <div className="chat-message-meta">
                    {msg.direction === 'inbound' ? 'You' : selectedAgentData?.name || 'Agent'}{' '}
                    — {new Date(msg.created_at).toLocaleTimeString()}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <form onSubmit={handleSend} className="chat-input-bar">
              <input
                className="form-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type a message..."
                disabled={sending}
              />
              <button type="submit" className="btn btn-primary" disabled={sending || !input.trim()}>
                Send
              </button>
            </form>
          </>
        )}
      </main>
    </div>
  );
}

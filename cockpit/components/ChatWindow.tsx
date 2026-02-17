'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSse, type SseEvent } from '@/lib/use-sse';
import { ErrorCallout } from './ErrorCallout';

interface Message {
  id: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_bot_message: boolean;
}

interface ChatWindowProps {
  topicId: string | null;
  group: string;
}

async function writeAction(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const csrf = sessionStorage.getItem('csrf') || '';
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

export function ChatWindow({ topicId, group }: ChatWindowProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [currentTopicId, setCurrentTopicId] = useState(topicId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMsgCountRef = useRef(0);

  // Track whether user is scrolled near the bottom
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const threshold = 80; // px from bottom
    isAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Update messages only when content actually changed
  const applyMessages = useCallback((incoming: Message[]) => {
    setMessages((prev) => {
      if (
        prev.length === incoming.length &&
        prev.length > 0 &&
        prev[prev.length - 1].id === incoming[incoming.length - 1].id
      ) {
        return prev; // same data — keep reference stable
      }
      return incoming;
    });
  }, []);

  // Load messages when topic changes
  useEffect(() => {
    setCurrentTopicId(topicId);
    isAtBottomRef.current = true; // reset on topic switch
    if (!topicId) {
      setMessages([]);
      return;
    }

    fetch(`/api/ops/messages?topic_id=${topicId}&limit=100`)
      .then((r) => r.json())
      .then((data: { messages?: Message[] }) => {
        if (data.messages) applyMessages(data.messages);
      })
      .catch(() => {});
  }, [topicId, applyMessages]);

  // Auto-scroll only when new messages arrive AND user is at bottom
  useEffect(() => {
    const newCount = messages.length;
    const hadNew = newCount > prevMsgCountRef.current;
    prevMsgCountRef.current = newCount;

    if (hadNew && isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Poll for new messages every 3s
  useEffect(() => {
    if (!currentTopicId) return;
    const poll = setInterval(() => {
      fetch(`/api/ops/messages?topic_id=${currentTopicId}&limit=100`)
        .then((r) => r.json())
        .then((data: { messages?: Message[] }) => {
          if (data.messages) applyMessages(data.messages);
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(poll);
  }, [currentTopicId, applyMessages]);

  // SSE for real-time bot responses (filter by topicId)
  const handleSseEvent = useCallback(
    (event: SseEvent) => {
      if (
        event.type === 'chat:message' &&
        event.data.text &&
        event.data.topicId === currentTopicId
      ) {
        const sseMsg: Message = {
          id: `sse-${Date.now()}`,
          sender_name: (event.data.sender as string) || 'Agent',
          content: event.data.text as string,
          timestamp: (event.data.timestamp as string) || new Date().toISOString(),
          is_bot_message: true,
        };
        setMessages((prev) => {
          const exists = prev.some(
            (m) => m.content === sseMsg.content && m.timestamp === sseMsg.timestamp,
          );
          return exists ? prev : [...prev, sseMsg];
        });
      }
    },
    [currentTopicId],
  );

  useSse(handleSseEvent);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || sending) return;

    const text = input.trim();
    setInput('');
    setError('');
    setSending(true);

    // Optimistic: add user message immediately
    const optimisticMsg: Message = {
      id: `local-${Date.now()}`,
      sender_name: 'Owner',
      content: text,
      timestamp: new Date().toISOString(),
      is_bot_message: false,
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    try {
      const result = await writeAction('/api/write/chat/send', {
        message: text,
        topic_id: currentTopicId || undefined,
        group,
      });
      if (!result.ok) {
        setError((result.error as string) || 'Failed to send message');
      } else if (!currentTopicId && result.topic_id) {
        // First message created a new topic — update state
        setCurrentTopicId(result.topic_id as string);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  }

  if (!topicId && !currentTopicId) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        Select a topic or create a new one to start chatting.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Messages */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto space-y-3 p-4"
      >
        {messages.length === 0 && (
          <div className="text-center text-zinc-500 py-8">
            No messages yet. Send a message to start chatting.
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.is_bot_message ? 'justify-start' : 'justify-end'}`}
          >
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                msg.is_bot_message
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'bg-blue-700/20 text-blue-100 border border-blue-700/30'
              }`}
            >
              <div className="mb-1 text-xs text-zinc-500">
                {msg.sender_name}
                <span className="ml-2">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <div className="whitespace-pre-wrap break-words">{msg.content}</div>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Error */}
      {error && (
        <div className="px-4">
          <ErrorCallout message={error} />
        </div>
      )}

      {/* Input */}
      <form onSubmit={handleSend} className="border-t border-zinc-800 p-4">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            maxLength={4000}
            disabled={sending}
            className="flex-1 rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm placeholder-zinc-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            className="rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
          >
            {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}

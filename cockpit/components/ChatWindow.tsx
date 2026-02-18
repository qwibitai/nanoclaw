'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSse, type SseEvent } from '@/lib/use-sse';
import { ErrorCallout } from './ErrorCallout';

interface Message {
  id: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_bot_message: boolean;
  media_data?: string | null;
}

interface PendingImage {
  name: string;
  data: string;      // base64
  mime_type: string;
  preview: string;   // object URL for display
}

interface PendingTxt {
  name: string;
  content: string;
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
  const [isAgentTyping, setIsAgentTyping] = useState(false);
  const [error, setError] = useState('');
  const [currentTopicId, setCurrentTopicId] = useState(topicId);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [pendingTxt, setPendingTxt] = useState<PendingTxt | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  // Revoke preview object URL when pendingImage changes (memory cleanup)
  useEffect(() => {
    return () => {
      if (pendingImage?.preview) URL.revokeObjectURL(pendingImage.preview);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingImage?.preview]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!fileInputRef.current) return;
    fileInputRef.current.value = '';
    if (!file) return;

    const isImage = file.type.startsWith('image/');
    const isTxt = file.type === 'text/plain' || file.name.endsWith('.txt');

    if (isImage) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // result is "data:image/jpeg;base64,XXXX" — extract just the base64 part
        const base64 = result.split(',')[1];
        if (!base64) return;
        const preview = URL.createObjectURL(file);
        setPendingImage({ name: file.name, data: base64, mime_type: file.type, preview });
      };
      reader.readAsDataURL(file);
    } else if (isTxt) {
      const reader = new FileReader();
      reader.onload = () => {
        setPendingTxt({ name: file.name, content: reader.result as string });
      };
      reader.readAsText(file);
    } else {
      setError('Only images (JPEG, PNG, GIF, WebP) and .txt files are supported.');
    }
  }, []);

  // Load messages when topic changes
  useEffect(() => {
    setCurrentTopicId(topicId);
    setIsAgentTyping(false);
    setPendingImage(null);
    setPendingTxt(null);
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

  // Clear typing indicator when bot responds (works for both SSE and polling)
  useEffect(() => {
    if (isAgentTyping && messages.length > 0 && messages[messages.length - 1].is_bot_message) {
      setIsAgentTyping(false);
    }
  }, [messages, isAgentTyping]);

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

    const imageToSend = pendingImage;
    const txtToSend = pendingTxt;
    // Append TXT content as an XML attachment block (invisible in the textarea)
    const rawText = input.trim();
    const text = txtToSend
      ? `${rawText}\n\n<attachment filename="${txtToSend.name}">\n${txtToSend.content}\n</attachment>`
      : rawText;
    setInput('');
    setError('');
    setSending(true);
    setPendingImage(null);
    setPendingTxt(null);

    // Optimistic: add user message immediately
    const optimisticMsg: Message = {
      id: `local-${Date.now()}`,
      sender_name: 'Owner',
      content: text,
      timestamp: new Date().toISOString(),
      is_bot_message: false,
      media_data: imageToSend
        ? JSON.stringify([{ type: 'image', name: imageToSend.name, data: imageToSend.data, mime_type: imageToSend.mime_type }])
        : null,
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    try {
      const body: Record<string, unknown> = {
        message: text,
        topic_id: currentTopicId || undefined,
        group,
      };
      if (imageToSend) {
        body.attachment = { type: 'image', name: imageToSend.name, data: imageToSend.data, mime_type: imageToSend.mime_type };
      }
      const result = await writeAction('/api/write/chat/send', body);
      if (!result.ok) {
        setError((result.error as string) || 'Failed to send message');
      } else {
        setIsAgentTyping(true);
        if (!currentTopicId && result.topic_id) {
          // First message created a new topic — update state
          setCurrentTopicId(result.topic_id as string);
        }
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
        {messages.map((msg) => {
          let images: Array<{ name: string; data: string; mime_type: string }> = [];
          if (msg.media_data) {
            try {
              const parsed = JSON.parse(msg.media_data);
              if (Array.isArray(parsed)) {
                images = parsed.filter((a) => a.type === 'image');
              }
            } catch { /* ignore */ }
          }
          return (
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
                {images.map((img, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={`data:${img.mime_type};base64,${img.data}`}
                    alt={img.name}
                    className="mb-2 max-w-full rounded max-h-64 object-contain"
                  />
                ))}
                <div className="whitespace-pre-wrap break-words">{msg.content}</div>
              </div>
            </div>
          );
        })}
        {isAgentTyping && (
          <div className="flex justify-start">
            <div className="rounded-lg bg-zinc-800 px-3 py-3">
              <div className="flex gap-1 items-center">
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce" />
              </div>
            </div>
          </div>
        )}
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
        {/* Pending attachment previews */}
        {(pendingImage || pendingTxt) && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingImage && (
              <div className="flex items-center gap-2 rounded border border-zinc-600 bg-zinc-900 p-1 pr-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={pendingImage.preview}
                  alt={pendingImage.name}
                  className="h-10 w-10 rounded object-cover"
                />
                <span className="max-w-[120px] truncate text-xs text-zinc-400">{pendingImage.name}</span>
                <button
                  type="button"
                  onClick={() => setPendingImage(null)}
                  className="text-xs text-zinc-500 hover:text-zinc-200"
                >
                  ✕
                </button>
              </div>
            )}
            {pendingTxt && (
              <div className="flex items-center gap-2 rounded border border-zinc-600 bg-zinc-900 px-2 py-1">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span className="max-w-[140px] truncate text-xs text-zinc-400">{pendingTxt.name}</span>
                <button
                  type="button"
                  onClick={() => setPendingTxt(null)}
                  className="text-xs text-zinc-500 hover:text-zinc-200"
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        )}
        <div className="flex gap-2">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp,.txt,text/plain"
            className="hidden"
            onChange={handleFileChange}
          />
          {/* Attach button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            title="Attach image or TXT file"
            className="rounded border border-zinc-700 bg-zinc-800 px-2 py-2 text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
          </button>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            maxLength={50000}
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

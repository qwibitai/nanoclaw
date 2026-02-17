'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { TopicSidebar, type Topic } from '@/components/TopicSidebar';
import { ChatWindow } from '@/components/ChatWindow';

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

function ChatPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);

  const activeTopicId = searchParams.get('topic');
  const activeGroup = searchParams.get('agent') || 'main';

  // Load topics
  useEffect(() => {
    fetch('/api/ops/topics')
      .then((r) => r.json())
      .then((data: { topics?: Topic[] }) => {
        if (data.topics) setTopics(data.topics);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSelectTopic = useCallback(
    (topicId: string) => {
      const topic = topics.find((t) => t.id === topicId);
      const agent = topic?.group_folder || 'main';
      router.push(`/chat?agent=${agent}&topic=${topicId}`);
    },
    [router, topics],
  );

  const handleNewTopic = useCallback(
    async (group: string) => {
      try {
        const result = await writeAction('/api/write/chat/topic', {
          group,
          title: 'New Topic',
        });
        if (result.ok) {
          const topic = result.topic as { id: string; group_folder: string; title: string };
          setTopics((prev) => [
            {
              ...topic,
              created_at: new Date().toISOString(),
              last_activity: new Date().toISOString(),
              status: 'active',
            },
            ...prev,
          ]);
          router.push(`/chat?agent=${group}&topic=${topic.id}`);
        }
      } catch {
        // silently fail
      }
    },
    [router],
  );

  const handleDeleteTopic = useCallback(
    async (topicId: string) => {
      try {
        const result = await writeAction('/api/write/chat/topic/delete', {
          topic_id: topicId,
        });
        if (result.ok) {
          setTopics((prev) => prev.filter((t) => t.id !== topicId));
          if (activeTopicId === topicId) {
            router.push('/chat');
          }
        }
      } catch {
        // silently fail
      }
    },
    [router, activeTopicId],
  );

  if (loading) {
    return (
      <div className="flex h-[calc(100vh-6rem)] items-center justify-center text-zinc-500">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-6rem)] -m-6">
      <TopicSidebar
        initialTopics={topics}
        activeTopicId={activeTopicId}
        onSelectTopic={handleSelectTopic}
        onNewTopic={handleNewTopic}
        onDeleteTopic={handleDeleteTopic}
      />
      <div className="flex-1 min-h-0">
        <ChatWindow topicId={activeTopicId} group={activeGroup} />
      </div>
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-[calc(100vh-6rem)] items-center justify-center text-zinc-500">
          Loading...
        </div>
      }
    >
      <ChatPageInner />
    </Suspense>
  );
}

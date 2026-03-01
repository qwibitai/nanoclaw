import Link from 'next/link';
import {
  getGroups,
  getMessageCountSince,
  getRecentMessages,
  getTasks,
  getSessions,
} from '@/lib/db';
import { readStatus } from '@/lib/status';
import { formatUptime, timeAgo, formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
      <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide">
        {label}
      </div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      {sub && (
        <div className="text-xs text-[var(--text-muted)] mt-1">{sub}</div>
      )}
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-[var(--success)]' : 'bg-[var(--error)]'}`}
    />
  );
}

export default function OverviewPage() {
  const status = readStatus();
  const groups = getGroups();
  const tasks = getTasks();
  const sessions = getSessions();
  const recentMessages = getRecentMessages(20);

  const now = new Date();
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).toISOString();
  const weekStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 7,
  ).toISOString();
  const messagesToday = getMessageCountSince(todayStart);
  const messagesThisWeek = getMessageCountSince(weekStart);

  const activeTasks = tasks.filter((t) => t.status === 'active');
  const nextTasks = activeTasks
    .filter((t) => t.next_run)
    .sort((a, b) => (a.next_run! > b.next_run! ? 1 : -1))
    .slice(0, 5);

  const sessionFolders = new Set(sessions.map((s) => s.group_folder));

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Overview</h1>

      {/* Status banner */}
      {status ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <StatusDot ok />
          <span>
            Running for {formatUptime(status.uptime)} &middot; Last update{' '}
            {timeAgo(status.timestamp)}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-[var(--error)]">
          <StatusDot ok={false} />
          <span>
            Orchestrator status unavailable (no data/status.json)
          </span>
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Messages Today"
          value={messagesToday}
          sub={`${messagesThisWeek} this week`}
        />
        <StatCard label="Groups" value={groups.length} />
        <StatCard
          label="Containers"
          value={status ? `${status.queue.activeCount}/${status.queue.maxConcurrent}` : '-'}
          sub={status ? `${status.queue.waitingCount} waiting` : undefined}
        />
        <StatCard
          label="Active Tasks"
          value={activeTasks.length}
          sub={`${tasks.length} total`}
        />
      </div>

      {/* Channels */}
      {status && status.channels.length > 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-2">Channels</h2>
          <div className="flex gap-4">
            {status.channels.map((ch) => (
              <div key={ch.name} className="flex items-center gap-2 text-sm">
                <StatusDot ok={ch.connected} />
                <span>{ch.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Groups */}
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">Groups</h2>
            <Link
              href="/groups"
              className="text-xs text-[var(--accent)] hover:underline"
            >
              View all
            </Link>
          </div>
          <div className="space-y-2">
            {groups.map((g) => {
              const queueState = status?.queue.groups;
              const jid = Object.entries(status?.groups || {}).find(
                ([, v]) => v.folder === g.folder,
              )?.[0];
              const containerState = jid && queueState ? queueState[jid] : null;

              return (
                <Link
                  key={g.jid}
                  href={`/groups/${g.folder}`}
                  className="flex items-center justify-between p-2 rounded hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <StatusDot ok={containerState?.active ?? false} />
                    <span className="text-sm">{g.name}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                    {sessionFolders.has(g.folder) && (
                      <span className="bg-[var(--bg)] px-1.5 py-0.5 rounded">
                        session
                      </span>
                    )}
                    <span>{g.folder}</span>
                  </div>
                </Link>
              );
            })}
            {groups.length === 0 && (
              <div className="text-sm text-[var(--text-muted)]">
                No groups registered
              </div>
            )}
          </div>
        </div>

        {/* Next scheduled tasks */}
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">Upcoming Tasks</h2>
            <Link
              href="/tasks"
              className="text-xs text-[var(--accent)] hover:underline"
            >
              View all
            </Link>
          </div>
          <div className="space-y-2">
            {nextTasks.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between p-2 text-sm"
              >
                <div className="truncate max-w-[60%]">
                  {t.prompt.slice(0, 60)}
                  {t.prompt.length > 60 ? '...' : ''}
                </div>
                <div className="text-xs text-[var(--text-muted)]">
                  {t.next_run ? formatDateTime(t.next_run) : '-'}
                </div>
              </div>
            ))}
            {nextTasks.length === 0 && (
              <div className="text-sm text-[var(--text-muted)]">
                No upcoming tasks
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recent activity */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
        <h2 className="text-sm font-semibold mb-3">Recent Activity</h2>
        <div className="space-y-1">
          {recentMessages.map((m) => (
            <div
              key={`${m.id}-${m.chat_jid}`}
              className="flex items-baseline gap-3 py-1 text-sm"
            >
              <span className="text-xs text-[var(--text-muted)] w-16 shrink-0">
                {timeAgo(m.timestamp)}
              </span>
              <span className="font-medium w-24 shrink-0 truncate">
                {m.sender_name}
              </span>
              <span className="text-[var(--text-muted)] truncate">
                {m.content.slice(0, 120)}
              </span>
            </div>
          ))}
          {recentMessages.length === 0 && (
            <div className="text-sm text-[var(--text-muted)]">
              No messages yet
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

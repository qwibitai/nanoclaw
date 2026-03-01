import fs from 'fs';
import path from 'path';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getGroupByFolder, getMessages, getTasks } from '@/lib/db';
import { readStatus } from '@/lib/status';
import { formatDateTime, timeAgo } from '@/lib/format';

export const dynamic = 'force-dynamic';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');

export default async function GroupDetailPage({
  params,
}: {
  params: Promise<{ folder: string }>;
}) {
  const { folder } = await params;
  const group = getGroupByFolder(folder);
  if (!group) notFound();

  const status = readStatus();

  // Find JID for this group
  const jid = Object.entries(status?.groups || {}).find(
    ([, g]) => g.folder === folder,
  )?.[0];

  const containerState =
    jid && status?.queue.groups ? status.queue.groups[jid] : null;

  // Get messages for this group
  const { messages } = jid
    ? getMessages({ chatJid: jid, limit: 30 })
    : { messages: [] };

  // Get tasks
  const allTasks = getTasks();
  const groupTasks = allTasks.filter((t) => t.group_folder === folder);

  // Read CLAUDE.md
  const claudeMdPath = path.join(PROJECT_ROOT, 'groups', folder, 'CLAUDE.md');
  let claudeMd = '';
  try {
    claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
  } catch {
    // no CLAUDE.md
  }

  // Read container logs (most recent)
  const logsDir = path.join(PROJECT_ROOT, 'groups', folder, 'logs');
  let recentLog = '';
  try {
    const logFiles = fs
      .readdirSync(logsDir)
      .filter((f) => f.endsWith('.log'))
      .sort()
      .reverse();
    if (logFiles[0]) {
      const content = fs.readFileSync(path.join(logsDir, logFiles[0]), 'utf-8');
      recentLog = content.slice(0, 3000);
    }
  } catch {
    // no logs
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/groups"
          className="text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          Groups
        </Link>
        <span className="text-[var(--text-muted)]">/</span>
        <h1 className="text-xl font-bold">{group.name}</h1>
      </div>

      {/* Metadata */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-3">
          <div className="text-xs text-[var(--text-muted)]">Folder</div>
          <div className="text-sm mt-1">{group.folder}</div>
        </div>
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-3">
          <div className="text-xs text-[var(--text-muted)]">Trigger</div>
          <div className="text-sm mt-1">
            {group.trigger_pattern}
            {group.requires_trigger === 0 && ' (auto)'}
          </div>
        </div>
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-3">
          <div className="text-xs text-[var(--text-muted)]">Container</div>
          <div className="text-sm mt-1">
            {containerState?.active
              ? containerState.idleWaiting
                ? 'Idle'
                : 'Active'
              : 'Off'}
          </div>
        </div>
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-3">
          <div className="text-xs text-[var(--text-muted)]">Registered</div>
          <div className="text-sm mt-1">{formatDateTime(group.added_at)}</div>
        </div>
      </div>

      {/* CLAUDE.md */}
      {claudeMd && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-3">CLAUDE.md</h2>
          <pre className="text-xs text-[var(--text-muted)] whitespace-pre-wrap max-h-96 overflow-auto">
            {claudeMd}
          </pre>
        </div>
      )}

      {/* Recent messages */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
        <h2 className="text-sm font-semibold mb-3">Recent Messages</h2>
        <div className="space-y-1 max-h-96 overflow-auto">
          {messages.map((m) => (
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
                {m.content.slice(0, 200)}
              </span>
            </div>
          ))}
          {messages.length === 0 && (
            <div className="text-sm text-[var(--text-muted)]">
              No messages yet
            </div>
          )}
        </div>
      </div>

      {/* Tasks */}
      {groupTasks.length > 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-3">Scheduled Tasks</h2>
          <div className="space-y-2">
            {groupTasks.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between py-1 text-sm"
              >
                <div className="truncate max-w-[50%]">{t.prompt}</div>
                <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                  <span>{t.schedule_type}: {t.schedule_value}</span>
                  <span
                    className={`px-1.5 py-0.5 rounded ${
                      t.status === 'active'
                        ? 'bg-green-900/30 text-[var(--success)]'
                        : t.status === 'paused'
                          ? 'bg-yellow-900/30 text-[var(--warning)]'
                          : 'bg-[var(--bg)] text-[var(--text-muted)]'
                    }`}
                  >
                    {t.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent log */}
      {recentLog && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-3">Latest Container Log</h2>
          <pre className="text-xs text-[var(--text-muted)] whitespace-pre-wrap max-h-64 overflow-auto">
            {recentLog}
          </pre>
        </div>
      )}
    </div>
  );
}

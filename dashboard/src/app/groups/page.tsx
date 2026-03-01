import Link from 'next/link';
import { getGroups, getChats } from '@/lib/db';
import { readStatus } from '@/lib/status';
import { timeAgo } from '@/lib/format';

export const dynamic = 'force-dynamic';

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]'}`}
    />
  );
}

export default function GroupsPage() {
  const groups = getGroups();
  const chats = getChats();
  const status = readStatus();

  const chatMap = new Map(chats.map((c) => [c.jid, c]));

  // Build JID -> folder lookup from status
  const jidByFolder = new Map<string, string>();
  if (status?.groups) {
    for (const [jid, g] of Object.entries(status.groups)) {
      jidByFolder.set(g.folder, jid);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Groups</h1>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--text-muted)] uppercase tracking-wide">
              <th className="p-3">Name</th>
              <th className="p-3">Folder</th>
              <th className="p-3">Trigger</th>
              <th className="p-3">Last Activity</th>
              <th className="p-3">Container</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const jid = jidByFolder.get(g.folder);
              const chat = jid ? chatMap.get(jid) : undefined;
              const containerState =
                jid && status?.queue.groups
                  ? status.queue.groups[jid]
                  : null;
              const isActive = containerState?.active ?? false;

              return (
                <tr
                  key={g.jid}
                  className="border-b border-[var(--border)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <td className="p-3">
                    <Link
                      href={`/groups/${g.folder}`}
                      className="text-[var(--accent)] hover:underline"
                    >
                      {g.name}
                    </Link>
                  </td>
                  <td className="p-3 text-[var(--text-muted)]">{g.folder}</td>
                  <td className="p-3 text-[var(--text-muted)]">
                    {g.trigger_pattern}
                    {g.requires_trigger === 0 && (
                      <span className="ml-1 text-xs bg-[var(--bg)] px-1 py-0.5 rounded">
                        auto
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-[var(--text-muted)]">
                    {chat?.last_message_time
                      ? timeAgo(chat.last_message_time)
                      : '-'}
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <StatusDot ok={isActive} />
                      <span>
                        {isActive
                          ? containerState?.isTaskContainer
                            ? 'task'
                            : containerState?.idleWaiting
                              ? 'idle'
                              : 'active'
                          : 'off'}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {groups.length === 0 && (
          <div className="p-6 text-center text-[var(--text-muted)]">
            No groups registered
          </div>
        )}
      </div>
    </div>
  );
}

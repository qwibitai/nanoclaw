import Link from 'next/link';
import { getMessages, getGroups } from '@/lib/db';
import { timeAgo } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    group?: string;
    page?: string;
  }>;
}) {
  const sp = await searchParams;
  const search = sp.q || '';
  const groupFilter = sp.group || '';
  const page = parseInt(sp.page || '1', 10);
  const perPage = 50;

  const groups = getGroups();

  // registered_groups has jid as PK and folder as column
  const chatJid = groupFilter
    ? groups.find((g) => g.folder === groupFilter)?.jid
    : undefined;

  const { messages, total } = getMessages({
    chatJid,
    search: search || undefined,
    limit: perPage,
    offset: (page - 1) * perPage,
  });

  const totalPages = Math.ceil(total / perPage);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Messages</h1>

      {/* Filters */}
      <form className="flex gap-3 items-center" method="GET">
        <input
          type="text"
          name="q"
          placeholder="Search messages..."
          defaultValue={search}
          className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm flex-1 max-w-md placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
        />
        <select
          name="group"
          defaultValue={groupFilter}
          className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-muted)]"
        >
          <option value="">All groups</option>
          {groups.map((g) => (
            <option key={g.jid} value={g.folder}>
              {g.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-3 py-1.5 rounded-lg text-sm transition-colors"
        >
          Search
        </button>
      </form>

      {/* Results */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
        <div className="p-3 border-b border-[var(--border)] text-xs text-[var(--text-muted)]">
          {total.toLocaleString()} messages
          {search && ` matching "${search}"`}
          {totalPages > 1 && ` — Page ${page} of ${totalPages}`}
        </div>
        <div className="divide-y divide-[var(--border)]">
          {messages.map((m) => (
            <div
              key={`${m.id}-${m.chat_jid}`}
              className="p-3 hover:bg-[var(--bg-hover)] transition-colors"
            >
              <div className="flex items-baseline gap-3 text-sm">
                <span className="text-xs text-[var(--text-muted)] w-20 shrink-0">
                  {timeAgo(m.timestamp)}
                </span>
                <span className="font-medium w-28 shrink-0 truncate">
                  {m.sender_name}
                </span>
                <span className="text-[var(--text-muted)] break-words min-w-0">
                  {m.content.slice(0, 300)}
                  {m.content.length > 300 ? '...' : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
        {messages.length === 0 && (
          <div className="p-6 text-center text-[var(--text-muted)]">
            No messages found
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-2">
          {page > 1 && (
            <Link
              href={`/messages?q=${encodeURIComponent(search)}&group=${groupFilter}&page=${page - 1}`}
              className="bg-[var(--bg-card)] border border-[var(--border)] px-3 py-1 rounded text-sm hover:bg-[var(--bg-hover)]"
            >
              Previous
            </Link>
          )}
          <span className="px-3 py-1 text-sm text-[var(--text-muted)]">
            {page} / {totalPages}
          </span>
          {page < totalPages && (
            <Link
              href={`/messages?q=${encodeURIComponent(search)}&group=${groupFilter}&page=${page + 1}`}
              className="bg-[var(--bg-card)] border border-[var(--border)] px-3 py-1 rounded text-sm hover:bg-[var(--bg-hover)]"
            >
              Next
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

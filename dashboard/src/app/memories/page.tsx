import {
  getTotalMemories,
  getCategoryStats,
  getRecentMemories,
  searchMemories,
  getMemoriesByCategory,
  getAllTags,
} from '@/lib/memory-db';
import { formatDateTime } from '@/lib/format';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const CATEGORY_COLORS: Record<string, string> = {
  people: 'bg-blue-500/20 text-blue-400',
  preferences: 'bg-purple-500/20 text-purple-400',
  places: 'bg-green-500/20 text-green-400',
  projects: 'bg-yellow-500/20 text-yellow-400',
  facts: 'bg-gray-500/20 text-gray-400',
  events: 'bg-orange-500/20 text-orange-400',
  health: 'bg-red-500/20 text-red-400',
  finance: 'bg-emerald-500/20 text-emerald-400',
};

const CATEGORY_ICONS: Record<string, string> = {
  people: '\ud83d\udc64',
  preferences: '\u2764\ufe0f',
  places: '\ud83d\udccd',
  projects: '\ud83d\udcbc',
  facts: '\ud83d\udcdd',
  events: '\ud83d\udcc5',
  health: '\ud83c\udfe5',
  finance: '\ud83d\udcb0',
};

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

function MemoryCard({ memory }: { memory: { id: number; content: string; context: string | null; category: string; tags: string | null; source: string | null; created_at: string } }) {
  const colorClass = CATEGORY_COLORS[memory.category] || 'bg-gray-500/20 text-gray-400';
  const icon = CATEGORY_ICONS[memory.category] || '\ud83d\udccc';

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${colorClass}`}
          >
            {icon} {memory.category}
          </span>
          <span className="text-xs text-[var(--text-muted)]">#{memory.id}</span>
        </div>
        <span className="text-xs text-[var(--text-muted)] shrink-0">
          {formatDateTime(memory.created_at)}
        </span>
      </div>
      <p className="text-sm mb-2">{memory.content}</p>
      {memory.context && (
        <p className="text-xs text-[var(--text-muted)] mb-2 pl-3 border-l-2 border-[var(--border)]">
          {memory.context}
        </p>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {memory.tags &&
          memory.tags.split(',').map((tag) => (
            <Link
              key={tag.trim()}
              href={`/memories?q=${encodeURIComponent(tag.trim())}`}
              className="text-xs bg-[var(--bg)] px-1.5 py-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
            >
              #{tag.trim()}
            </Link>
          ))}
        {memory.source && (
          <span className="text-xs text-[var(--text-muted)] ml-auto">
            via {memory.source}
          </span>
        )}
      </div>
    </div>
  );
}

export default async function MemoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string }>;
}) {
  const { q, category } = await searchParams;
  const totalMemories = getTotalMemories();
  const categoryStats = getCategoryStats();
  const allTags = getAllTags();

  let memories;
  if (q) {
    memories = searchMemories(q, category);
  } else if (category) {
    memories = getMemoriesByCategory(category);
  } else {
    memories = getRecentMemories(50);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Memories</h1>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Memories" value={totalMemories} />
        <StatCard label="Categories" value={categoryStats.length} />
        <StatCard label="Tags" value={allTags.length} />
        <StatCard
          label="Most Recent"
          value={
            memories.length > 0
              ? formatDateTime(memories[0].created_at)
              : '-'
          }
        />
      </div>

      {/* Search & Filter */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
        <form method="GET" className="flex gap-2 mb-3">
          <input
            type="text"
            name="q"
            defaultValue={q || ''}
            placeholder="Search memories..."
            className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded px-3 py-1.5 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
          />
          {category && <input type="hidden" name="category" value={category} />}
          <button
            type="submit"
            className="px-4 py-1.5 bg-[var(--accent)] text-[var(--bg)] rounded text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Search
          </button>
        </form>

        {/* Category filters */}
        <div className="flex gap-2 flex-wrap">
          <Link
            href="/memories"
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
              !category
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            All
          </Link>
          {categoryStats.map((cat) => {
            const icon = CATEGORY_ICONS[cat.category] || '\ud83d\udccc';
            const isActive = category === cat.category;
            return (
              <Link
                key={cat.category}
                href={`/memories?category=${cat.category}${q ? `&q=${encodeURIComponent(q)}` : ''}`}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  isActive
                    ? 'border-[var(--accent)] text-[var(--accent)]'
                    : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                {icon} {cat.category} ({cat.count})
              </Link>
            );
          })}
        </div>
      </div>

      {/* Results info */}
      {(q || category) && (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <span>
            {memories.length} result{memories.length !== 1 ? 's' : ''}
            {q && <> for &ldquo;{q}&rdquo;</>}
            {category && <> in {category}</>}
          </span>
          <Link href="/memories" className="text-[var(--accent)] hover:underline">
            Clear
          </Link>
        </div>
      )}

      {/* Tag cloud */}
      {!q && !category && allTags.length > 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-3">Tags</h2>
          <div className="flex gap-2 flex-wrap">
            {allTags.slice(0, 30).map(({ tag, count }) => (
              <Link
                key={tag}
                href={`/memories?q=${encodeURIComponent(tag)}`}
                className="text-xs bg-[var(--bg)] px-2 py-1 rounded text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
              >
                #{tag}
                <span className="ml-1 opacity-50">{count}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Memory cards */}
      <div className="space-y-3">
        {memories.map((memory) => (
          <MemoryCard key={memory.id} memory={memory} />
        ))}
        {memories.length === 0 && (
          <div className="text-sm text-[var(--text-muted)] text-center py-8">
            {q || category ? 'No memories found' : 'No memories yet'}
          </div>
        )}
      </div>
    </div>
  );
}

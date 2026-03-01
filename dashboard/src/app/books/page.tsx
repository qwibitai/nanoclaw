import {
  getTotalBooks,
  getTopAuthors,
  getBooksByType,
  getBooksByYear,
  getRecentBooks,
  searchBooks,
  getTotalSpent,
} from '@/lib/books-db';
import { formatDateTime } from '@/lib/format';

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

function BarChart({
  data,
  labelKey,
  valueKey,
  maxBars = 10,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any[];
  labelKey: string;
  valueKey: string;
  maxBars?: number;
}) {
  const sliced = data.slice(0, maxBars);
  const maxVal = Math.max(...sliced.map((d: Record<string, unknown>) => Number(d[valueKey]) || 0), 1);

  return (
    <div className="space-y-1.5">
      {sliced.map((d: Record<string, unknown>, i: number) => {
        const val = Number(d[valueKey]) || 0;
        const pct = (val / maxVal) * 100;
        return (
          <div key={i} className="flex items-center gap-2 text-sm">
            <span className="w-36 truncate text-right text-[var(--text-muted)]">
              {String(d[labelKey])}
            </span>
            <div className="flex-1 h-5 bg-[var(--bg)] rounded overflow-hidden">
              <div
                className="h-full bg-[var(--accent)] rounded transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-8 text-right text-xs font-medium">{val}</span>
          </div>
        );
      })}
    </div>
  );
}

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const totalBooks = getTotalBooks();
  const totalSpent = getTotalSpent();
  const topAuthors = getTopAuthors(15);
  const byType = getBooksByType();
  const byYear = getBooksByYear();
  const recentBooks = getRecentBooks(20);
  const searchResults = q ? searchBooks(q) : null;

  const uniqueAuthors = topAuthors.length;
  const kindleCount =
    byType.find((t) => t.type.includes('Kindle'))?.count || 0;
  const physicalCount = totalBooks - kindleCount;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Books</h1>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Books" value={totalBooks} />
        <StatCard
          label="Total Spent"
          value={`$${totalSpent.toLocaleString()}`}
        />
        <StatCard label="Authors" value={uniqueAuthors} />
        <StatCard
          label="Kindle / Physical"
          value={`${kindleCount} / ${physicalCount}`}
        />
      </div>

      {/* Search */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
        <h2 className="text-sm font-semibold mb-3">Search</h2>
        <form method="GET" className="flex gap-2">
          <input
            type="text"
            name="q"
            defaultValue={q || ''}
            placeholder="Search by title, author, or publisher..."
            className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded px-3 py-1.5 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
          />
          <button
            type="submit"
            className="px-4 py-1.5 bg-[var(--accent)] text-[var(--bg)] rounded text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Search
          </button>
        </form>

        {searchResults && (
          <div className="mt-4">
            <div className="text-xs text-[var(--text-muted)] mb-2">
              {searchResults.length} result{searchResults.length !== 1 ? 's' : ''} for &ldquo;{q}&rdquo;
            </div>
            <div className="overflow-auto border border-[var(--border)] rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-xs text-[var(--text-muted)]">
                    <th className="p-2 text-left">Title</th>
                    <th className="p-2 text-left">Author</th>
                    <th className="p-2 text-left">Type</th>
                    <th className="p-2 text-left">Price</th>
                    <th className="p-2 text-left">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {searchResults.map((book, i) => (
                    <tr key={i} className="border-b border-[var(--border)]">
                      <td className="p-2 max-w-xs truncate">{book.title}</td>
                      <td className="p-2">{book.author || '-'}</td>
                      <td className="p-2 text-xs">{book.type || '-'}</td>
                      <td className="p-2">
                        {book.price ? `$${book.price}` : '-'}
                      </td>
                      <td className="p-2 text-xs">
                        {book.order_date
                          ? formatDateTime(book.order_date)
                          : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Authors */}
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-3">Top Authors</h2>
          <BarChart
            data={topAuthors}
            labelKey="author"
            valueKey="book_count"
            maxBars={12}
          />
        </div>

        {/* By Year */}
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-3">Purchases by Year</h2>
          <BarChart data={byYear} labelKey="year" valueKey="count" />
        </div>
      </div>

      {/* By Type */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
        <h2 className="text-sm font-semibold mb-3">By Format</h2>
        <div className="overflow-auto border border-[var(--border)] rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-xs text-[var(--text-muted)]">
                <th className="p-2 text-left">Format</th>
                <th className="p-2 text-right">Count</th>
                <th className="p-2 text-right">Total Spent</th>
              </tr>
            </thead>
            <tbody>
              {byType.map((t, i) => (
                <tr key={i} className="border-b border-[var(--border)]">
                  <td className="p-2">{t.type}</td>
                  <td className="p-2 text-right">{t.count}</td>
                  <td className="p-2 text-right">${t.total_spent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent Purchases */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
        <h2 className="text-sm font-semibold mb-3">Recent Purchases</h2>
        <div className="overflow-auto border border-[var(--border)] rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-xs text-[var(--text-muted)]">
                <th className="p-2 text-left">Title</th>
                <th className="p-2 text-left">Author</th>
                <th className="p-2 text-left">Type</th>
                <th className="p-2 text-right">Price</th>
                <th className="p-2 text-left">Date</th>
              </tr>
            </thead>
            <tbody>
              {recentBooks.map((book, i) => (
                <tr key={i} className="border-b border-[var(--border)]">
                  <td className="p-2 max-w-xs truncate">{book.title}</td>
                  <td className="p-2">{book.author || '-'}</td>
                  <td className="p-2 text-xs">{book.type || '-'}</td>
                  <td className="p-2 text-right">
                    {book.price ? `$${book.price}` : '-'}
                  </td>
                  <td className="p-2 text-xs">
                    {book.order_date
                      ? formatDateTime(book.order_date)
                      : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

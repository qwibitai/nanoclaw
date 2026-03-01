import fs from 'fs';
import path from 'path';
import { notFound } from 'next/navigation';
import { runReadOnlyQuery } from '@/lib/db';

export const dynamic = 'force-dynamic';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const CUSTOM_DIR = path.join(PROJECT_ROOT, 'groups', 'main', 'dashboard');

interface Widget {
  type: 'markdown' | 'query' | 'table';
  content?: string;
  sql?: string;
  params?: unknown[];
  data?: unknown[][];
  columns?: string[];
}

interface PageConfig {
  title: string;
  layout?: string;
  widgets: Widget[];
}

function renderWidget(widget: Widget, index: number) {
  if (widget.type === 'markdown' && widget.content) {
    return (
      <div key={index} className="prose prose-invert max-w-none">
        <pre className="whitespace-pre-wrap text-sm text-[var(--text)]">
          {widget.content}
        </pre>
      </div>
    );
  }

  if (widget.type === 'query' && widget.sql) {
    try {
      const rows = runReadOnlyQuery(widget.sql, widget.params || []) as Record<
        string,
        unknown
      >[];
      if (rows.length === 0) {
        return (
          <div key={index} className="text-sm text-[var(--text-muted)]">
            No results
          </div>
        );
      }
      const columns = Object.keys(rows[0]);
      return (
        <div
          key={index}
          className="overflow-auto border border-[var(--border)] rounded-lg"
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-xs text-[var(--text-muted)]">
                {columns.map((col) => (
                  <th key={col} className="p-2 text-left">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-[var(--border)]">
                  {columns.map((col) => (
                    <td key={col} className="p-2">
                      {String(row[col] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    } catch (err) {
      return (
        <div key={index} className="text-sm text-[var(--error)]">
          Query error: {err instanceof Error ? err.message : String(err)}
        </div>
      );
    }
  }

  if (widget.type === 'table' && widget.data) {
    const columns = widget.columns || [];
    return (
      <div
        key={index}
        className="overflow-auto border border-[var(--border)] rounded-lg"
      >
        <table className="w-full text-sm">
          {columns.length > 0 && (
            <thead>
              <tr className="border-b border-[var(--border)] text-xs text-[var(--text-muted)]">
                {columns.map((col) => (
                  <th key={col} className="p-2 text-left">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {widget.data.map((row, i) => (
              <tr key={i} className="border-b border-[var(--border)]">
                {(row as unknown[]).map((cell, j) => (
                  <td key={j} className="p-2">
                    {String(cell ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return null;
}

export default async function CustomPage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const slugPath = slug.join('/');

  // Try JSON first, then markdown
  const jsonPath = path.join(CUSTOM_DIR, `${slugPath}.json`);
  const mdPath = path.join(CUSTOM_DIR, `${slugPath}.md`);

  // Prevent path traversal
  const resolvedJson = path.resolve(jsonPath);
  const resolvedMd = path.resolve(mdPath);
  if (
    !resolvedJson.startsWith(CUSTOM_DIR) ||
    !resolvedMd.startsWith(CUSTOM_DIR)
  ) {
    notFound();
  }

  if (fs.existsSync(resolvedJson)) {
    try {
      const config: PageConfig = JSON.parse(
        fs.readFileSync(resolvedJson, 'utf-8'),
      );
      return (
        <div className="space-y-6">
          <h1 className="text-xl font-bold">{config.title}</h1>
          <div className="space-y-4">
            {config.widgets.map((widget, i) => renderWidget(widget, i))}
          </div>
        </div>
      );
    } catch {
      return (
        <div className="text-[var(--error)]">
          Error parsing {slugPath}.json
        </div>
      );
    }
  }

  if (fs.existsSync(resolvedMd)) {
    const content = fs.readFileSync(resolvedMd, 'utf-8');
    return (
      <div className="space-y-6">
        <pre className="whitespace-pre-wrap text-sm text-[var(--text)]">
          {content}
        </pre>
      </div>
    );
  }

  notFound();
}

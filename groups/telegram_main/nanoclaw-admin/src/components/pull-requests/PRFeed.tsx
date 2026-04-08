"use client";
import { useState, useMemo } from "react";
import Image from "next/image";
import { ExternalLink, Search, X } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { PRSizeBadge } from "./PRSizeBadge";
import type { PullRequest } from "@/lib/github";

interface Props {
  prs: PullRequest[];
}

export function PRFeed({ prs }: Props) {
  const [search, setSearch] = useState("");
  const [authorFilter, setAuthorFilter] = useState<string | null>(null);

  const authors = useMemo(
    () => Array.from(new Set(prs.map((p) => p.user.login))).sort(),
    [prs]
  );

  const filtered = useMemo(() => {
    return prs.filter((pr) => {
      const matchesSearch =
        !search ||
        pr.title.toLowerCase().includes(search.toLowerCase()) ||
        `#${pr.number}`.includes(search);
      const matchesAuthor = !authorFilter || pr.user.login === authorFilter;
      return matchesSearch && matchesAuthor;
    });
  }, [prs, search, authorFilter]);

  return (
    <div className="space-y-4">
      {/* Search + filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search PRs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-border bg-card pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {/* Author filter chips */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {authors.map((author) => (
            <button
              key={author}
              onClick={() => setAuthorFilter(authorFilter === author ? null : author)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors border ${
                authorFilter === author
                  ? "bg-primary/20 border-primary/40 text-primary"
                  : "border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent"
              }`}
            >
              @{author}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {filtered.length} of {prs.length} merged PRs
      </p>

      {/* PR list */}
      <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            No PRs match your search
          </div>
        ) : (
          filtered.map((pr) => (
            <div key={pr.number} className="flex items-start gap-3 px-4 py-4 hover:bg-accent/20 transition-colors">
              <Image
                src={pr.user.avatar_url}
                alt={pr.user.login}
                width={28}
                height={28}
                className="rounded-full ring-1 ring-border shrink-0 mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <Badge variant="outline" className="border-violet-500/30 text-violet-400 bg-violet-500/10 text-xs font-mono shrink-0">
                    #{pr.number}
                  </Badge>
                  {pr.additions !== undefined && pr.deletions !== undefined && (
                    <PRSizeBadge additions={pr.additions} deletions={pr.deletions} />
                  )}
                  {pr.labels.map((label) => (
                    <Badge
                      key={label.name}
                      variant="outline"
                      className="text-xs"
                      style={{
                        borderColor: `#${label.color}40`,
                        color: `#${label.color}`,
                        backgroundColor: `#${label.color}15`,
                      }}
                    >
                      {label.name}
                    </Badge>
                  ))}
                </div>
                <a
                  href={pr.html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium text-foreground hover:text-primary transition-colors line-clamp-2"
                >
                  {pr.title}
                </a>
                <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                  <span>@{pr.user.login}</span>
                  <span>·</span>
                  <span>merged {formatDistanceToNow(new Date(pr.merged_at), { addSuffix: true })}</span>
                  {pr.additions !== undefined && (
                    <>
                      <span>·</span>
                      <span className="text-emerald-400">+{pr.additions.toLocaleString()}</span>
                      <span className="text-red-400">-{pr.deletions?.toLocaleString()}</span>
                    </>
                  )}
                </div>
              </div>
              <a
                href={pr.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors mt-0.5"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

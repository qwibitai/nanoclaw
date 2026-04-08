import Image from "next/image";
import { GitMerge, Plus, Minus } from "lucide-react";
import type { Contributor } from "@/lib/github";

function prettify(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function ContributorLeaderboard({ contributors }: { contributors: Contributor[] }) {
  if (contributors.length === 0) {
    return <p className="text-sm text-muted-foreground py-4 text-center">No contributor data available</p>;
  }

  return (
    <div className="divide-y divide-border">
      {contributors.map((c, i) => (
        <div key={c.login} className="flex items-center gap-3 py-3 px-1">
          <span className="text-xs font-mono text-muted-foreground w-5 text-center">
            {i + 1}
          </span>
          <Image
            src={c.avatar_url}
            alt={c.login}
            width={28}
            height={28}
            className="rounded-full ring-1 ring-border shrink-0"
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">@{c.login}</p>
          </div>
          <div className="flex items-center gap-3 text-xs shrink-0">
            <span className="flex items-center gap-1 text-violet-400 font-medium">
              <GitMerge className="h-3 w-3" />
              {c.count}
            </span>
            {(c.additions > 0 || c.deletions > 0) && (
              <>
                <span className="flex items-center gap-0.5 text-emerald-400">
                  <Plus className="h-3 w-3" />
                  {prettify(c.additions)}
                </span>
                <span className="flex items-center gap-0.5 text-red-400">
                  <Minus className="h-3 w-3" />
                  {prettify(c.deletions)}
                </span>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

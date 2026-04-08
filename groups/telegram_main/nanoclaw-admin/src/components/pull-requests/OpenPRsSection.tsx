import Image from "next/image";
import { ExternalLink, AlertCircle, Clock } from "lucide-react";
import { formatDistanceToNow, differenceInDays } from "date-fns";
import { Badge } from "@/components/ui/badge";
import type { PullRequest } from "@/lib/github";

function StaleBadge({ createdAt }: { createdAt: string }) {
  const days = differenceInDays(new Date(), new Date(createdAt));
  if (days < 3) return null;
  if (days < 7) return (
    <span className="text-xs text-amber-400 flex items-center gap-1">
      <Clock className="h-3 w-3" /> {days}d old
    </span>
  );
  return (
    <span className="text-xs text-red-400 flex items-center gap-1">
      <AlertCircle className="h-3 w-3" /> {days}d stale
    </span>
  );
}

export function OpenPRsSection({ prs }: { prs: PullRequest[] }) {
  if (prs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <p className="text-sm">No open pull requests 🎉</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {prs.map((pr) => (
        <div key={pr.number} className="flex items-start gap-3 py-4 px-1 hover:bg-accent/10 transition-colors rounded-lg">
          <Image
            src={pr.user.avatar_url}
            alt={pr.user.login}
            width={28}
            height={28}
            className="rounded-full ring-1 ring-border shrink-0 mt-0.5"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <Badge variant="outline" className="border-amber-500/30 text-amber-400 bg-amber-500/10 text-xs font-mono shrink-0">
                #{pr.number}
              </Badge>
              {pr.draft && (
                <Badge variant="outline" className="text-xs text-muted-foreground">
                  Draft
                </Badge>
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
              className="text-sm font-medium text-foreground hover:text-primary transition-colors"
            >
              {pr.title}
            </a>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-xs text-muted-foreground">@{pr.user.login}</span>
              <span className="text-xs text-muted-foreground">·</span>
              <span className="text-xs text-muted-foreground">
                opened {formatDistanceToNow(new Date(pr.created_at), { addSuffix: true })}
              </span>
              <span className="text-xs text-muted-foreground">·</span>
              <StaleBadge createdAt={pr.created_at} />
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
      ))}
    </div>
  );
}

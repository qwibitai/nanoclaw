import { GitMerge, ExternalLink, GitPullRequest } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { PullRequest } from "@/lib/github";
import { formatDistanceToNow } from "date-fns";
import Image from "next/image";

interface Props {
  prs: PullRequest[];
}

export function PullRequestsCard({ prs }: Props) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitMerge className="h-4 w-4 text-violet-400" />
            <CardTitle className="text-base">Recent Merges</CardTitle>
          </div>
          <a
            href="https://github.com/jszynal/longbow/pulls?q=is%3Apr+is%3Amerged"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
          >
            jszynal/longbow
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <CardDescription>Last {prs.length} merged pull requests</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {prs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
            <GitPullRequest className="h-8 w-8 mb-2 opacity-40" />
            <p className="text-sm">No merged PRs found</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {prs.map((pr) => (
              <div
                key={pr.number}
                className="flex items-start gap-4 px-6 py-4 hover:bg-accent/30 transition-colors"
              >
                {/* Avatar */}
                <div className="shrink-0 mt-0.5">
                  <Image
                    src={pr.user.avatar_url}
                    alt={pr.user.login}
                    width={28}
                    height={28}
                    className="rounded-full ring-1 ring-border"
                  />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <Badge
                      variant="outline"
                      className="border-violet-500/30 text-violet-400 bg-violet-500/10 text-xs font-mono shrink-0"
                    >
                      #{pr.number}
                    </Badge>
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
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-muted-foreground">
                      @{pr.user.login}
                    </span>
                    <span className="text-xs text-muted-foreground">·</span>
                    <span className="text-xs text-muted-foreground">
                      merged{" "}
                      {formatDistanceToNow(new Date(pr.merged_at), {
                        addSuffix: true,
                      })}
                    </span>
                  </div>
                </div>

                {/* Link icon */}
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
        )}
      </CardContent>
    </Card>
  );
}

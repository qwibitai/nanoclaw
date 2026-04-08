"use client";
import { useState } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, XCircle } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import type { TaskRunLog } from "@/lib/nanoclaw";

interface Props {
  runs: TaskRunLog[];
}

function RunRow({ run }: { run: TaskRunLog }) {
  const [expanded, setExpanded] = useState(false);
  const isSuccess = run.status === "success";
  const content = run.result || run.error || "";

  return (
    <>
      <tr
        className="border-b border-border hover:bg-accent/20 cursor-pointer transition-colors"
        onClick={() => content && setExpanded((e) => !e)}
      >
        <td className="px-4 py-3 w-6">
          {content ? (
            expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )
          ) : null}
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5">
            {isSuccess ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
            ) : (
              <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />
            )}
            <span className={`text-xs font-medium ${isSuccess ? "text-emerald-400" : "text-red-400"}`}>
              {isSuccess ? "Success" : "Error"}
            </span>
          </div>
        </td>
        <td className="px-4 py-3 text-xs text-foreground font-mono">
          {format(new Date(run.run_at), "MMM d, yyyy · HH:mm:ss")}
        </td>
        <td className="px-4 py-3 text-xs text-muted-foreground">
          {formatDistanceToNow(new Date(run.run_at), { addSuffix: true })}
        </td>
        <td className="px-4 py-3 text-xs text-right text-muted-foreground font-mono">
          {(run.duration_ms / 1000).toFixed(1)}s
        </td>
      </tr>
      {expanded && content && (
        <tr className="border-b border-border bg-accent/10">
          <td colSpan={5} className="px-4 pb-3 pt-0">
            <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono rounded-lg bg-black/30 p-3 max-h-64 overflow-y-auto border border-border mt-1">
              {content}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

export function RunHistoryTable({ runs }: Props) {
  if (runs.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        No run history yet — this job hasn&apos;t fired yet.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            <th className="w-6 px-4 py-2.5" />
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Run At</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Relative</th>
            <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Duration</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

"use client";
import { useState } from "react";
import { Play, Loader2, CheckCircle2, XCircle } from "lucide-react";

interface Props {
  taskId: string;
}

type RunState = "idle" | "running" | "success" | "error";

export function RunNowButton({ taskId }: Props) {
  const [state, setState] = useState<RunState>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleRun() {
    setState("running");
    setMessage(null);
    try {
      const res = await fetch(`/api/cron-jobs/${taskId}/run`, { method: "POST" });
      const data = await res.json();
      if (res.ok && data.ok) {
        setState("success");
        setMessage(data.message || "Job completed successfully");
      } else {
        setState("error");
        setMessage(data.message || data.error || "Job failed");
      }
    } catch (e) {
      setState("error");
      setMessage(String(e));
    }
    setTimeout(() => setState("idle"), 8000);
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <button
        onClick={handleRun}
        disabled={state === "running"}
        className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {state === "running" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Play className="h-4 w-4" />
        )}
        {state === "running" ? "Running…" : "Run Now"}
      </button>

      {message && (
        <div className={`flex items-center gap-1.5 text-sm ${state === "success" ? "text-emerald-400" : "text-red-400"}`}>
          {state === "success" ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <XCircle className="h-4 w-4 shrink-0" />
          )}
          <span className="text-xs">{message}</span>
        </div>
      )}
    </div>
  );
}

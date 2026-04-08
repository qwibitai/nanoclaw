/**
 * Small status badge used by Dev Tasks and Scheduled Tasks.
 * Single component, single set of tokens — no per-view drift.
 */

import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  children: React.ReactNode;
  variant?: "neutral" | "active" | "attention" | "muted";
  className?: string;
}

const VARIANT_CLASSES: Record<NonNullable<StatusBadgeProps["variant"]>, string> = {
  neutral: "bg-muted text-foreground",
  active: "bg-accent/15 text-accent",
  attention: "bg-accent text-accent-foreground",
  muted: "bg-muted/60 text-muted-foreground",
};

export function StatusBadge({
  children,
  variant = "neutral",
  className,
}: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[0.25rem] px-1.5 py-0.5 text-[0.6875rem] font-medium uppercase tracking-wider",
        VARIANT_CLASSES[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}

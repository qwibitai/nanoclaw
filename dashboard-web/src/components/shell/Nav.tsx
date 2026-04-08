/**
 * Shared nav item rendering for the sidebar (desktop) and tab bar
 * (mobile). One component, two modes, zero duplication.
 *
 * Icons inlined from the previous hand-rolled dashboard (see
 * nanoclaw/src/channels/dashboard-page.ts:31-42 for the source SVGs).
 * Kept as inline SVG rather than pulled from lucide-react so the tab
 * bar doesn't need to load the lucide tree just to render five icons.
 */

import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";

export const NAV_ITEMS = [
  { id: "vault", label: "Vault", path: "/vault" },
  { id: "meals", label: "Meals", path: "/meals" },
  { id: "tasks", label: "Tasks", path: "/tasks" },
  { id: "devtasks", label: "Dev", path: "/devtasks" },
  { id: "reports", label: "Reports", path: "/reports" },
] as const;

type NavItemId = (typeof NAV_ITEMS)[number]["id"];

const ICONS: Record<NavItemId, ReactNode> = {
  vault: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  ),
  meals: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8h1a4 4 0 0 1 0 8h-1" />
      <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z" />
      <line x1="6" y1="1" x2="6" y2="4" />
      <line x1="10" y1="1" x2="10" y2="4" />
      <line x1="14" y1="1" x2="14" y2="4" />
    </svg>
  ),
  tasks: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  devtasks: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  ),
  reports: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      <line x1="8" y1="7" x2="16" y2="7" />
      <line x1="8" y1="11" x2="16" y2="11" />
      <line x1="8" y1="15" x2="13" y2="15" />
    </svg>
  ),
};

interface NavItemProps {
  id: NavItemId;
  label: string;
  path: string;
  active: boolean;
  mode: "sidebar" | "tab";
}

function NavItem({ id, label, path, active, mode }: NavItemProps) {
  if (mode === "sidebar") {
    return (
      <Link
        to={path}
        className={cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          active
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        )}
      >
        <span className="h-4 w-4 shrink-0">{ICONS[id]}</span>
        <span>{label}</span>
      </Link>
    );
  }

  // tab mode — bottom tab bar on mobile
  return (
    <Link
      to={path}
      data-testid={`tab-${id}`}
      className={cn(
        "relative flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors",
        // Minimum tap target: ≥44px tall via the parent's height.
        active ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {/* Active indicator: 2px top border, not a pill. Survives URL
       *  bar reflow on Mobile Safari. */}
      {active && (
        <span
          className="absolute left-0 right-0 top-0 h-[2px] bg-primary"
          aria-hidden="true"
        />
      )}
      <span className="h-5 w-5">{ICONS[id]}</span>
      <span>{label}</span>
    </Link>
  );
}

export function Sidebar() {
  const location = useLocation();
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card md:flex">
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-foreground">
          <div className="h-2 w-2 rounded-full bg-background" />
        </div>
        <span className="text-sm font-semibold tracking-tight">FamBot</span>
      </div>
      <nav className="flex flex-col gap-0.5 px-3 pb-3">
        {NAV_ITEMS.map((item) => (
          <NavItem
            key={item.id}
            id={item.id}
            label={item.label}
            path={item.path}
            active={location.pathname === item.path || location.pathname.startsWith(item.path + "/")}
            mode="sidebar"
          />
        ))}
      </nav>
    </aside>
  );
}

export function TabBar() {
  const location = useLocation();
  return (
    <nav
      className={cn(
        "fixed bottom-0 left-0 right-0 z-10 flex border-t border-border bg-card/95 backdrop-blur",
        // height 56px + safe-area-inset-bottom so the tab bar hugs
        // the bottom on iPhone without overlapping the home indicator
        "h-14 pb-[env(safe-area-inset-bottom)]",
        "md:hidden",
      )}
    >
      {NAV_ITEMS.map((item) => (
        <NavItem
          key={item.id}
          id={item.id}
          label={item.label}
          path={item.path}
          active={location.pathname === item.path || location.pathname.startsWith(item.path + "/")}
          mode="tab"
        />
      ))}
    </nav>
  );
}

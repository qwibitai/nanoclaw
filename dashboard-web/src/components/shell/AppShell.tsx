/**
 * Top-level layout for the FamBot dashboard.
 *
 * Mobile: bottom tab bar (fixed), content scrolls in the area above.
 * Desktop (md+): left sidebar (sticky), content takes the remaining
 * width.
 *
 * min-h-dvh (not min-h-screen) so mobile Safari's URL bar
 * reveal/hide doesn't reflow content behind the fixed tab bar. Safe
 * area insets on the tab bar itself are handled inside Nav.tsx.
 */

import { Outlet } from "react-router-dom";
import { Sidebar, TabBar } from "./Nav";

export function AppShell() {
  return (
    <div className="min-h-dvh bg-background text-foreground antialiased">
      <div className="flex">
        <Sidebar />
        <main
          className={
            // Padding-bottom on mobile so scrollable content doesn't
            // disappear under the fixed tab bar. Desktop has no tab
            // bar so no extra padding.
            "flex-1 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0"
          }
        >
          <Outlet />
        </main>
      </div>
      <TabBar />
    </div>
  );
}

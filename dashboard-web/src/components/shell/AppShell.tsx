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
    // Outer flex row is `min-h-dvh` so the sidebar (a flex child with
    // default align-stretch) naturally fills the full viewport height.
    // Previously min-h-dvh sat on a plain block wrapper, which left
    // the sidebar at content-height — visually it stopped short of
    // the bottom on long pages where content grew past the nav.
    <div className="flex min-h-dvh bg-background text-foreground antialiased">
      <Sidebar />
      <main
        className={
          // min-w-0 is load-bearing. Without it, any wide child
          // (e.g. a report table, a long unbroken monospace string)
          // pushes the flex-1 column past viewport width, which on
          // mobile Safari reads as "page is wider than the screen"
          // and the browser zooms out to fit. min-w-0 lets the
          // column shrink so overflow stays local to the child.
          "min-w-0 flex-1 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0"
        }
      >
        <Outlet />
      </main>
      <TabBar />
    </div>
  );
}

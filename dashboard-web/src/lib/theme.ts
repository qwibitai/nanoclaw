/**
 * Follow-system theme provider.
 *
 * v1 is follow-system-only — no manual toggle, no localStorage, no
 * provider state surface. Decision locked during document review (see
 * plan Key Technical Decisions). If Boris wants to flip the theme on
 * his phone, he flips his OS setting — same as any other HIG-native
 * iOS app.
 *
 * Applies `class="dark"` to <html> on mount based on
 * `prefers-color-scheme` and re-applies on OS-level changes. No React
 * state, no context, no exported hook — just a single top-level
 * useEffect in App.tsx that calls applyThemeFromSystem().
 */

const DARK_CLASS = "dark";

function setDarkMode(enabled: boolean) {
  const root = document.documentElement;
  if (enabled) {
    root.classList.add(DARK_CLASS);
  } else {
    root.classList.remove(DARK_CLASS);
  }
}

/**
 * Apply the current system preference and subscribe to changes.
 * Returns a teardown function for the subscription.
 */
export function applyThemeFromSystem(): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  setDarkMode(media.matches);

  const listener = (ev: MediaQueryListEvent) => {
    setDarkMode(ev.matches);
  };

  // addEventListener is the modern API; addListener is deprecated but
  // still on a handful of old Safari versions. We only care about
  // Mobile Safari current + Chrome current, so addEventListener is
  // fine.
  media.addEventListener("change", listener);

  return () => {
    media.removeEventListener("change", listener);
  };
}

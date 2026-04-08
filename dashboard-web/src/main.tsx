/**
 * App entry.
 *
 * IMPORTANT ORDERING: the bare-fragment hash shim below MUST run
 * before any React Router import. createHashRouter reads
 * window.location synchronously at construction time, so if the shim
 * runs after the App module loads, the router has already resolved
 * the wrong URL and the fix is too late. That's why the shim is a
 * top-of-file side-effect statement and App is imported AFTER it.
 */

// ---------------------------------------------------------------------
// Hash router compatibility shim.
//
// The previous hand-rolled dashboard wrote bare fragments:
//   #vault            (no leading slash)
//   #reports/<id>     (no leading slash)
//
// Pip emits #reports/<id> in every Telegram report link (see
// docs/solutions/agent-tool-output-vs-session-history.md and
// reference_dashboard_magicdns_url.md). React Router's
// createHashRouter produces #/vault and #/reports/<id> by default,
// so every pre-existing link would break on cutover.
//
// The shim rewrites bare fragments to slash-prefixed form before the
// router reads window.location. Runs exactly once at module load.
// Only matches the fixed allowlist of view names. Report ids are
// validated against a narrow allowlist; anything that fails drops
// the id and lets the router render its 404 state.
//
// Uses history.replaceState (not location.hash =) so it does NOT
// trigger a hashchange event and cannot re-enter itself.
// ---------------------------------------------------------------------

(function rewriteBareFragments() {
  const hash = window.location.hash;
  if (!hash || hash === "#" || hash.startsWith("#/")) {
    return;
  }

  // Match: #<view> or #<view>/<suffix>
  const match = hash.match(
    /^#(vault|meals|tasks|devtasks|reports)(?:\/(.*))?$/,
  );
  if (!match) {
    // Garbage / unknown hash — leave it alone. Router will default to
    // /vault on the fallback route.
    return;
  }

  const view = match[1];
  const suffix = match[2];
  let rewritten = `#/${view}`;

  if (suffix !== undefined) {
    // Validate the id segment against a narrow allowlist so crafted
    // URLs can't inject anything unusual into the router's path.
    // Reports use report ids like `rpt_abc-123`; the character set is
    // [a-zA-Z0-9_-], nothing else. If validation fails, drop the id.
    if (/^[a-zA-Z0-9_-]+$/.test(suffix)) {
      rewritten = `#/${view}/${suffix}`;
    }
  }

  window.history.replaceState(null, "", rewritten);
})();

// --- React mount ------------------------------------------------------

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

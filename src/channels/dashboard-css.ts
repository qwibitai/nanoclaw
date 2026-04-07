/**
 * CSS design system for the NanoClaw dashboard.
 * Inspired by FamBot iOS app design tokens + meal plan page.
 * Light/dark via prefers-color-scheme.
 */

export function getDashboardCSS(): string {
  return `
:root {
  --bg: #F7F4EC;
  --surface: #FFFFFF;
  --surface-hover: #F1EEE5;
  --text: #161412;
  --text-secondary: #6B655C;
  --text-tertiary: #A39B8F;
  --accent: #EA5A1A;
  --accent-strong: #C9410A;
  --accent-light: #FFE9DB;
  --border: #E5E0D3;
  --shadow-card: 0 1px 0 rgba(20,18,15,0.04), 0 8px 24px -12px rgba(20,18,15,0.12);
  --shadow-card-strong: 0 1px 0 rgba(20,18,15,0.06), 0 16px 40px -16px rgba(20,18,15,0.18);
  /* Per-view accent colors — wayfinding, used by sidebar icons */
  --view-vault:    #3B82F6;
  --view-meals:    #EA5A1A;
  --view-tasks:    #2D8A4E;
  --view-devtasks: #8B5CF6;
  --view-reports:  #10B981;
  --green: #2D8A4E;
  --green-light: #EBF5EE;
  --blue: #3B82F6;
  --blue-light: #EFF6FF;
  --orange: #E8743B;
  --orange-light: #FFF3ED;
  --purple: #8B5CF6;
  --purple-light: #F3F0FF;
  --mint: #10B981;
  --mint-light: #ECFDF5;
  --red: #EF4444;
  --red-light: #FEF2F2;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --sidebar-width: 220px;
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 12px;
  --spacing-lg: 16px;
  --spacing-xl: 24px;
  --spacing-xxl: 32px;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #100E0C;
    --surface: #1C1A18;
    --surface-hover: #2A2724;
    --text: #F4F0E8;
    --text-secondary: #A39B8F;
    --text-tertiary: #6B655C;
    --accent: #F58A3D;
    --accent-strong: #FFA866;
    --accent-light: #3A2418;
    --border: #2A2724;
    --shadow-card: 0 1px 0 rgba(0,0,0,0.6), 0 8px 24px -12px rgba(0,0,0,0.6);
    --shadow-card-strong: 0 1px 0 rgba(0,0,0,0.7), 0 16px 40px -16px rgba(0,0,0,0.8);
    --view-vault:    #60A5FA;
    --view-meals:    #F58A3D;
    --view-tasks:    #4CAF72;
    --view-devtasks: #A78BFA;
    --view-reports:  #34D399;
    --green: #4CAF72;
    --green-light: #1E3028;
    --blue: #60A5FA;
    --blue-light: #1E293B;
    --orange: #F0924C;
    --orange-light: #3A2820;
    --purple: #A78BFA;
    --purple-light: #2D2640;
    --mint: #34D399;
    --mint-light: #1A3030;
    --red: #F87171;
    --red-light: #3B1C1C;
  }
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: 'SF Pro Rounded', ui-rounded, -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  height: 100vh;
  overflow: hidden;
}

/* --- Layout --- */

.app {
  display: flex;
  height: 100vh;
}

/* --- Sidebar (desktop) --- */

.sidebar {
  width: var(--sidebar-width);
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: var(--spacing-xl) 0;
  flex-shrink: 0;
}

.sidebar-header {
  padding: 0 var(--spacing-lg) var(--spacing-xl);
  border-bottom: 1px solid var(--border);
  margin-bottom: var(--spacing-md);
}

.sidebar-header h1 {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.6px;
  color: var(--text);
}

.sidebar-header .subtitle {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.4px;
  color: var(--text-secondary);
  margin-top: 6px;
  text-transform: uppercase;
}

.sidebar nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--spacing-sm) var(--spacing-md);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: 10px var(--spacing-lg);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.1px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, transform 0.12s;
  border: none;
  background: none;
  width: 100%;
  text-align: left;
}

.nav-item:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.nav-item.active {
  background: var(--accent-light);
  color: var(--accent-strong);
  font-weight: 800;
}

@media (prefers-color-scheme: dark) {
  .nav-item.active { color: var(--accent-strong); }
}

.nav-item svg {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  opacity: 0.65;
  transition: opacity 0.15s, transform 0.15s;
}
.nav-item:hover svg,
.nav-item.active svg { opacity: 1; }

.nav-item[data-view="vault"]    svg { color: var(--view-vault); }
.nav-item[data-view="meals"]    svg { color: var(--view-meals); }
.nav-item[data-view="tasks"]    svg { color: var(--view-tasks); }
.nav-item[data-view="devtasks"] svg { color: var(--view-devtasks); }
.nav-item[data-view="reports"]  svg { color: var(--view-reports); }

.tab-item[data-view="vault"]    svg { color: var(--view-vault); }
.tab-item[data-view="meals"]    svg { color: var(--view-meals); }
.tab-item[data-view="tasks"]    svg { color: var(--view-tasks); }
.tab-item[data-view="devtasks"] svg { color: var(--view-devtasks); }
.tab-item[data-view="reports"]  svg { color: var(--view-reports); }

/* --- Main content --- */

.main {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--spacing-xl);
}

.view {
  display: none;
  height: 100%;
  animation: fadeIn 0.2s ease-out;
}

.view.active {
  display: block;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* --- Bottom tab bar (mobile) --- */

.tab-bar {
  display: none;
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--surface);
  border-top: 1px solid var(--border);
  z-index: 100;
  padding: var(--spacing-sm) 0 env(safe-area-inset-bottom, var(--spacing-sm));
}

.tab-bar nav {
  display: flex;
  justify-content: space-around;
}

.tab-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: var(--spacing-xs) var(--spacing-sm);
  color: var(--text-tertiary);
  font-size: 10px;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
  border: none;
  background: none;
  transition: color 0.15s;
}

.tab-item.active {
  color: var(--accent);
}

.tab-item svg {
  width: 22px;
  height: 22px;
}

/* --- Shared components --- */

.badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 9px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.3px;
}

.badge-working { background: var(--orange-light); color: var(--orange); }
.badge-open { background: var(--blue-light); color: var(--blue); }
.badge-needs_session { background: var(--purple-light); color: var(--purple); }
.badge-pr_ready { background: var(--green-light); color: var(--green); }
.badge-has_followups { background: var(--mint-light); color: var(--mint); }
.badge-done { background: var(--surface-hover); color: var(--text-tertiary); }
.badge-active { background: var(--green-light); color: var(--green); }
.badge-paused { background: var(--orange-light); color: var(--orange); }
.badge-completed { background: var(--surface-hover); color: var(--text-tertiary); }

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
  box-shadow: var(--shadow-card);
}

.card + .card {
  margin-top: var(--spacing-md);
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--text-secondary);
  margin-bottom: var(--spacing-md);
}

.empty-state {
  text-align: center;
  padding: 80px var(--spacing-xl);
  color: var(--text-secondary);
}

.empty-state h3 {
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: var(--spacing-xs);
}

.empty-state p {
  font-size: 14px;
}

/* ============================================================
   Shared dashboard vocabulary (devtask #60)
   Type scale + page-header + list-section + list-row +
   list-detail + input. Each type style is a class so it can be
   applied independently of slot classes. Slot classes (.page-header__title,
   .list-row__title, etc.) bake the matching type style in directly.
   ============================================================ */

/* --- Type scale (helpers) --- */

.t-page-title {
  font-size: 32px;
  font-weight: 800;
  letter-spacing: -0.8px;
  line-height: 1.1;
  color: var(--text);
}

.t-page-eyebrow,
.t-section-eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--accent);
}

.t-body {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
}

.t-body-secondary {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-secondary);
}

.t-meta {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-tertiary);
}

.t-badge {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.t-display {
  font-size: 36px;
  font-weight: 800;
  letter-spacing: -1px;
  line-height: 1.1;
  color: var(--text);
}

.t-mono {
  font-family: var(--font-mono);
}

/* --- View shell (full-height column flex: page-header on top, content below) --- */

.view-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.view-shell > .page-header {
  flex-shrink: 0;
}

.view-shell > .list-detail,
.view-shell > .view-body {
  flex: 1;
  min-height: 0;
}

.view-body {
  overflow-y: auto;
}

/* --- Code chip (mono inline chip for branches, ids, etc.) --- */

.code-chip {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text);
  background: var(--surface-hover);
  padding: 2px 6px;
  border-radius: 4px;
  word-break: break-all;
}

/* --- Page header --- */

.page-header {
  display: flex;
  align-items: flex-end;
  gap: var(--spacing-lg);
  flex-wrap: wrap;
  padding-bottom: var(--spacing-xl);
  margin-bottom: var(--spacing-xl);
  border-bottom: 1px solid var(--border);
  position: relative;
}

.page-header::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: -1px;
  width: 56px;
  height: 3px;
  background: var(--accent);
  border-radius: 2px;
}

.page-header__title-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1 1 280px;
  min-width: 200px;
}

.page-header__eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--accent);
}

.page-header__title {
  font-size: 32px;
  font-weight: 800;
  letter-spacing: -0.8px;
  line-height: 1.05;
  color: var(--text);
}

.page-header__meta {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-md);
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-top: 4px;
}

.page-header__tools {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-left: auto;
  flex-shrink: 0;
}

/* --- Detail header (smaller, nested inside list-detail panes) --- */

.detail-header {
  display: flex;
  align-items: flex-end;
  gap: var(--spacing-lg);
  padding-bottom: var(--spacing-md);
  margin-bottom: var(--spacing-lg);
}

.detail-header__title-block {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  flex: 1;
  min-width: 0;
}

.detail-header__eyebrow {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.detail-header__title {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.4px;
  line-height: 1.2;
  color: var(--text);
}

.detail-header__meta {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-md);
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}

.detail-header__tools {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-left: auto;
  flex-shrink: 0;
}

/* --- List section (sticky eyebrow with count) --- */

.list-section {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface);
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-lg) var(--spacing-lg) var(--spacing-sm);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--accent);
}

.list-section__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 7px;
  border-radius: 10px;
  background: var(--accent-light);
  color: var(--accent-strong);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0;
}

/* --- List section status / bucket modifiers (semantic color) --- */

.list-section--working { color: var(--orange); }
.list-section--working .list-section__count { background: var(--orange-light); color: var(--orange); }

.list-section--open { color: var(--blue); }
.list-section--open .list-section__count { background: var(--blue-light); color: var(--blue); }

.list-section--needs_session { color: var(--purple); }
.list-section--needs_session .list-section__count { background: var(--purple-light); color: var(--purple); }

.list-section--pr_ready { color: var(--green); }
.list-section--pr_ready .list-section__count { background: var(--green-light); color: var(--green); }

.list-section--has_followups { color: var(--mint); }
.list-section--has_followups .list-section__count { background: var(--mint-light); color: var(--mint); }

.list-section--done,
.list-section--completed {
  color: var(--text-tertiary);
}
.list-section--done .list-section__count,
.list-section--completed .list-section__count {
  background: var(--surface-hover);
  color: var(--text-tertiary);
}

.list-section--active { color: var(--green); }
.list-section--active .list-section__count { background: var(--green-light); color: var(--green); }

.list-section--paused { color: var(--orange); }
.list-section--paused .list-section__count { background: var(--orange-light); color: var(--orange); }

/* Reports time-bucket modifiers */
.list-section--today { color: var(--accent); }
.list-section--today .list-section__count { background: var(--accent-light); color: var(--accent-strong); }

.list-section--this-week { color: var(--blue); }
.list-section--this-week .list-section__count { background: var(--blue-light); color: var(--blue); }

.list-section--this-month { color: var(--purple); }
.list-section--this-month .list-section__count { background: var(--purple-light); color: var(--purple); }

.list-section--older { color: var(--text-tertiary); }
.list-section--older .list-section__count { background: var(--surface-hover); color: var(--text-tertiary); }

/* --- List row (button) --- */

.list-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  padding: var(--spacing-md) var(--spacing-lg);
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  border-left: 3px solid transparent;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font-family: inherit;
  transition: background 0.12s ease, border-left-color 0.12s ease;
}

@media (hover: hover) {
  .list-row:hover {
    background: var(--surface-hover);
  }
}

.list-row.is-selected {
  background: var(--accent-light);
  border-left-color: var(--accent);
}

.list-row:focus { outline: none; }

.list-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.list-row__title {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.1px;
  color: var(--text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.list-row__summary {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.list-row__meta {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-md);
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}

.list-row__expanded {
  display: none;
  margin-top: var(--spacing-sm);
}

.list-row.is-expanded > .list-row__expanded {
  display: block;
}

.list-row__empty-section {
  padding: var(--spacing-sm) var(--spacing-lg) var(--spacing-md);
  font-size: 12px;
  color: var(--text-tertiary);
  font-style: italic;
}

/* --- List detail (two-column shell) --- */

.list-detail {
  display: flex;
  height: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: var(--shadow-card);
}

.list-detail__list {
  width: 350px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  overflow-y: auto;
  background: var(--surface);
}

.list-detail__detail {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-xl);
  background: var(--surface);
}

.list-detail__empty,
.list-detail__no-results {
  text-align: center;
  padding: 60px var(--spacing-xl);
  color: var(--text-secondary);
}

.list-detail__empty h3,
.list-detail__no-results h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: var(--spacing-xs);
}

.list-detail__empty p,
.list-detail__no-results p {
  font-size: 13px;
  color: var(--text-secondary);
}

/* --- Shared input pattern (recessed against surface) --- */

.input {
  appearance: none;
  -webkit-appearance: none;
  background: var(--bg);
  color: var(--text);
  border: 1.5px solid var(--border);
  border-radius: var(--radius-md);
  padding: 9px 14px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  outline: none;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}

.input::placeholder {
  color: var(--text-tertiary);
  font-weight: 500;
}

.input:hover {
  border-color: var(--text-tertiary);
}

.input:focus-visible {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-light);
}

/* (Mobile rules consolidated in the responsive section below.)
   Desktop default for mobile-only back button: hidden. */
.list-detail__back { display: none; }

/* --- Connection indicator --- */

.connection-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--green);
  display: inline-block;
  margin-right: 6px;
  animation: pulse 2s infinite;
  box-shadow: 0 0 0 3px rgba(45, 138, 78, 0.18);
}

.connection-dot.disconnected {
  background: var(--red);
  animation: none;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* --- Responsive --- */

@media (max-width: 768px) {
  .sidebar { display: none; }
  .tab-bar { display: block; }
  .app { flex-direction: column; }

  .main {
    padding: var(--spacing-md);
    padding-bottom: calc(60px + env(safe-area-inset-bottom, 16px));
  }

  /* Page header — drop the giant title size, let tools wrap below */
  .page-header {
    flex-wrap: wrap;
    padding-bottom: var(--spacing-md);
    margin-bottom: var(--spacing-lg);
    gap: var(--spacing-md);
  }
  .page-header__title,
  .t-page-title {
    font-size: 26px;
    letter-spacing: -0.5px;
  }
  .page-header__title-block {
    flex: 1 1 100%;
    min-width: 0;
  }
  .page-header__tools {
    width: 100%;
    margin-left: 0;
    flex-wrap: wrap;
  }
  .page-header::after {
    width: 40px;
    height: 3px;
  }

  .detail-header__title {
    font-size: 20px;
  }

  /* List-detail collapses to single-pane navigation pattern.
     Default state shows the list. JS adds .is-detail-open when a row
     is selected, which swaps the panes. A back button (.list-detail__back)
     lives in the detail pane and removes the class. */
  .list-detail {
    flex-direction: column;
    border-radius: var(--radius-md);
  }
  .list-detail__list {
    width: 100%;
    border-right: none;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .list-detail__detail {
    display: none;
    padding: var(--spacing-lg);
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .list-detail.is-detail-open .list-detail__list {
    display: none;
  }
  .list-detail.is-detail-open .list-detail__detail {
    display: block;
  }
  .list-detail__back {
    display: flex;
    align-items: center;
    gap: 4px;
    width: calc(100% + 2 * var(--spacing-lg));
    min-height: 44px;
    padding: 10px 12px;
    margin: calc(-1 * var(--spacing-lg)) calc(-1 * var(--spacing-lg)) var(--spacing-md);
    background: var(--surface);
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--accent);
    font-family: inherit;
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.2px;
    cursor: pointer;
    position: sticky;
    top: 0;
    z-index: 5;
  }
  .list-detail__back:active { background: var(--surface-hover); }
  .list-detail__back::before {
    content: '‹';
    font-size: 28px;
    line-height: 1;
    margin-right: 4px;
    position: relative;
    top: -2px;
  }

  /* Tighter row + section padding on mobile */
  .list-row {
    padding: var(--spacing-md) var(--spacing-md);
  }
  .list-section {
    padding: var(--spacing-md) var(--spacing-md) var(--spacing-sm);
  }

  /* Vault: hide legend pills + zoom buttons on mobile.
     Legend is decorative (graph dots already encode domain), and
     pinch-to-zoom replaces the zoom controls. Search input stays. */
  .vault-legend,
  .vault-ctrls {
    display: none !important;
  }
  .vault-canvas {
    border-radius: var(--radius-md);
  }
}

`;
}

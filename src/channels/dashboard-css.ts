/**
 * CSS design system for the NanoClaw dashboard.
 * Inspired by FamBot iOS app design tokens + meal plan page.
 * Light/dark via prefers-color-scheme.
 */

export function getDashboardCSS(): string {
  return `
:root {
  --bg: #FAF9F6;
  --surface: #FFFFFF;
  --surface-hover: #F5F4F1;
  --text: #1A1A1A;
  --text-secondary: #6B6B6B;
  --text-tertiary: #999;
  --accent: #E8743B;
  --accent-light: #FFF3ED;
  --border: #E8E5E0;
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
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111111;
    --surface: #1C1C1E;
    --surface-hover: #2C2C2E;
    --text: #F0EFED;
    --text-secondary: #A0A0A0;
    --text-tertiary: #666;
    --accent: #F0924C;
    --accent-light: #3A2820;
    --border: #2C2C2E;
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
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
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
  padding: var(--spacing-lg) 0;
  flex-shrink: 0;
}

.sidebar-header {
  padding: 0 var(--spacing-lg) var(--spacing-xl);
  border-bottom: 1px solid var(--border);
  margin-bottom: var(--spacing-sm);
}

.sidebar-header h1 {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.3px;
}

.sidebar-header .subtitle {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.sidebar nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--spacing-sm) var(--spacing-sm);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md) var(--spacing-md);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
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
  color: var(--accent);
  font-weight: 600;
}

.nav-item svg {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

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
}

.view.active {
  display: block;
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
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 600;
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
  border-radius: var(--radius-md);
  padding: var(--spacing-lg);
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

/* --- Connection indicator --- */

.connection-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--green);
  display: inline-block;
  margin-right: 4px;
  animation: pulse 2s infinite;
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
  .main {
    padding: var(--spacing-lg);
    padding-bottom: calc(60px + env(safe-area-inset-bottom, 16px));
  }
  .app { flex-direction: column; }
}
`;
}

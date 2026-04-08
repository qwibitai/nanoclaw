import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { dashboardFixturesPlugin } from './dev-fixtures/plugin'

// Mounted under /dashboard by nanoclaw's HTTP server (see
// nanoclaw/src/channels/dashboard-page.ts and dashboard-assets.ts).
// All emitted asset URLs need the /dashboard/ prefix so the browser
// fetches them through the right handler.
//
// The dashboard-fixtures plugin is included unconditionally but is
// a no-op unless DASHBOARD_FIXTURES=1 is set in the environment at
// dev/preview time. It serves dummy /dashboard/api/* responses from
// dev-fixtures/ so vite preview can render every view without
// nanoclaw running. Build output is unaffected — the plugin only
// touches dev/preview middleware, never the production bundle.
export default defineConfig({
  base: '/dashboard/',
  plugins: [react(), tailwindcss(), dashboardFixturesPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})

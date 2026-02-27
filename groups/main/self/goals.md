# Goals

## Current Session Focus

*This file is updated at the end of each session to provide orientation for the next session.*

## Active Threads

### NanoClaw Trading System Development
- **Enhanced Dashboard**: Built tabbed UI with Trading tab (Overview, Trading, Messages, Tasks), restart button
- **Prediction Market Trading**: Rebuilt from stock-based to probability-based strategies
- **PR #19 Created**: Enhanced Dashboard + Prediction Market Trading System (feat/enhanced-dashboard-prediction-markets)
- **Issue**: Dashboard not showing trading data - fixed database path resolution in monitor-server.ts API endpoints
- **Next**: Verify dashboard displays demo data after restart, then merge PR #19

## Deferred

*Nothing deferred at this time*

## Recently Completed

- **Enhanced Dashboard** (2026-02-27, PR #19) — Tabbed interface with Trading tab, restart button, SSE connection, trading metrics display
- **Prediction Market Rebuild** (2026-02-27, PR #19) — Converted from stock strategies (RSI, time stops) to probability-based (Kelly Criterion, Bayesian updating, edge calculation)
- **Trading Tools Created** (2026-02-27) — analyze-event-probability, detect-news-catalyst, assess-liquidity with Fed/BTC/political probability models
- **Demo Data Seeded** (2026-02-27) — Created seed script with 4 positions, 3 signals, performance metrics for dashboard testing
- **Database Path Fix** (2026-02-27) — Fixed monitor-server.ts API endpoints to use absolute paths instead of relative 'store' path
- **Article Processing Session** (2026-02-24) — Processed 10 articles using /read-article workflow, created 18 memory notes + 10 research summaries
- **Ars Contexta Integration** (PR #6, merged) — Three-space architecture (self/, memory/, ops/)
- **Self-Edit Workflow** (PR #7, merged) — Safe PR-based workflow for modifying own source code
- **Personality Interview** (PR #8, merged) — Communication preferences, response structure guidelines

## Learnings This Session

- **Stock strategies don't apply to prediction markets** — Binary outcomes (0/1), fixed resolution, price = probability vs continuous pricing
- **Probability-based trading fundamentals** — Edge = true_prob - market_prob, Kelly Criterion sizing, thesis-driven exits (not time stops)
- **Dashboard troubleshooting pattern** — Check API endpoints, verify database path, test with curl/node, seed demo data for visual validation
- **better-sqlite3 native module** — Requires rebuild after container changes (npm rebuild better-sqlite3)
- **Monitor server path resolution** — Relative paths fail when STORE_DIR not set, use __dirname-based absolute paths
- **PR creation with REST API** — gh CLI GraphQL fails with fine-grained PATs, use `gh api repos/owner/repo/pulls` instead
- **User feedback pattern** — "separate stock trading from polymarket trading" = fundamental architecture change needed, not just parameter tweaking

## Next Session

When starting next session:
1. **Verify dashboard fix** — Check if trading data now displays after restart
2. **Merge PR #19** if dashboard works correctly
3. **Real API integration** — Replace mock probability estimation with real Polymarket/Kalshi APIs
4. **Schedule trading tasks** — Set up 3:50 PM scan, 3:58 PM execute as originally planned
5. Check `ops/queue/` for pending knowledge updates

---

*Last updated: 2026-02-27*

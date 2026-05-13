---
name: audit-website
description: Audit a website for SEO, performance, accessibility, security, and broken links. Local rebuild using open-source tooling (no squirrel dependency) — runs Lighthouse, axe-core, linkinator, and meta/header checks in parallel, then aggregates into an LLM-optimized Markdown report. Use when the user asks to audit, score, scan, or review a website's health, SEO, a11y, perf, or broken links.
allowed-tools: Bash, Read, Write, WebFetch
metadata:
  author: nanoclaw
  version: "2.0"
---

# audit-website

Composite audit of any public URL. Runs entirely inside the agent container —
no external API, no Cloudflare-blocked vendor CLI.

## When to use

- "audit this website"
- "what's wrong with my SEO / a11y / perf?"
- "find broken links on …"
- "give me a Lighthouse score for …"
- competitive site analysis, pre/post-deploy health checks, client audits.

## Tooling

Already baked into the agent container image:

| Tool | Purpose | Pinned in Dockerfile |
| --- | --- | --- |
| `lighthouse` | perf / a11y / SEO / best-practices + Core Web Vitals | v13.3.0 |
| `axe` (`@axe-core/cli`) | deep accessibility violations | v4.11.3 |
| `linkinator` | recursive broken-link checker | v7.6.1 |
| `curl`, `node` | security headers, robots.txt, sitemap, meta tags, JSON-LD | system |

## How to run it

Always invoke the runner script — never call the underlying tools directly,
because the script normalizes flags (headless Chrome no-sandbox, timeouts,
output paths) and aggregates everything into one report.

```bash
bash .claude/skills/audit-website/scripts/audit.sh <url>
```

Quick mode (Lighthouse + headers + meta only, ~20s; skips axe and linkinator):

```bash
bash .claude/skills/audit-website/scripts/audit.sh <url> --quick
```

Full mode takes 60–180s depending on the target site and link count. Reach
for `--quick` when the user wants a fast overview or has already triaged
a11y / link health.

The script prints the Markdown report to stdout. Pipe to a file if you need
to retain it (`> /workspace/agent/audits/<host>-<date>.md`), otherwise pass
the captured stdout straight to the user.

Raw tool artifacts (Lighthouse JSON, axe JSON, linkinator JSON, headers,
robots.txt, sitemap.xml, meta JSON) land in `/tmp/audit-<host>-<epoch>/` so
you can drill in if the user asks "why did Lighthouse mark this red".

## Report structure

See [references/OUTPUT-FORMAT.md](references/OUTPUT-FORMAT.md) for the full
schema. Sections, in order:

1. **Composite health score** — average of the four Lighthouse pillars.
2. **Scorecard** — Performance, Accessibility, SEO, Best Practices.
3. **Performance** — LCP, INP, CLS, FCP, TBT, Speed Index.
4. **SEO** — title / description / canonical / viewport / robots meta,
   robots.txt + sitemap.xml HTTP status, JSON-LD presence, OG + Twitter card
   completeness.
5. **Accessibility** — axe-core violations bucketed by impact (critical /
   serious / moderate / minor). Skipped in `--quick` mode.
6. **Security & Best Practices** — HTTPS / mixed-content from Lighthouse,
   plus presence of HSTS, CSP, X-Frame-Options, Referrer-Policy,
   X-Content-Type-Options, Permissions-Policy.
7. **Broken Links** — linkinator output split internal vs external. Skipped
   in `--quick` mode.
8. **Top Recommendations** — prioritized list (high / medium / low) with
   concrete fix guidance.

## After running

Don't just dump the report wholesale to the user — lead with the composite
score and the top 3 recommendations, then offer to expand any section. If
they ask for fixes, the raw artifacts under `/tmp/audit-…/` give you enough
detail to point to specific URLs / selectors / audit IDs.

## Failure modes

- **Lighthouse fails** (exit 3) — the script aborts. Usually means the URL
  is unreachable from the container, or the target blocks headless Chrome.
  Check `/tmp/audit-…/lighthouse.log`.
- **axe-core empty output** — some sites block headless Chromium. Falls
  back to `[]`; Lighthouse's a11y score is still meaningful. Check
  `/tmp/audit-…/axe.log`.
- **linkinator timeout** — for large sites, the default 15s per-link
  timeout may not be enough. Re-run with `--quick` and tell the user link
  check was skipped.
- **WAF / Cloudflare 403 on the URL itself** — Lighthouse uses real
  Chromium so usually gets through, but the meta-check `fetch()` may 403.
  The report will still include Lighthouse data; the meta section will say
  "missing" for everything.

# audit-website

Composite local website audit skill for NanoClaw v2.

This is a ground-up rebuild — the previous version wrapped the
[squirrelscan](https://squirrelscan.com) `squirrel` CLI, but Cloudflare's
AI-tool protections block it in most container environments. This rebuild
runs entirely on open-source tooling already baked into the agent image.

## Stack

- **Lighthouse 13.3** — perf / a11y / SEO / best-practices scores + Core
  Web Vitals.
- **@axe-core/cli 4.11** — deeper a11y violations than Lighthouse's subset.
- **linkinator 7.6** — recursive broken-link checker.
- **curl + node (regex)** — security headers, robots.txt, sitemap.xml,
  meta tags, OpenGraph, JSON-LD.

All three pnpm globals are pinned in `container/Dockerfile` and installed
into the agent image. Versions must satisfy the project's
`minimumReleaseAge: 4320` (3 days) supply-chain policy.

## Files

| Path | What it does |
| --- | --- |
| `SKILL.md` | When-to-use, how-to-run, output schema for the agent |
| `references/OUTPUT-FORMAT.md` | Detailed report schema + raw artifact map |
| `scripts/audit.sh` | Orchestrator — runs tools, calls aggregator |
| `scripts/meta-check.mjs` | Fetch + regex parse for meta / OG / JSON-LD |
| `scripts/aggregate.mjs` | Combine all tool outputs into final Markdown |

## How agents invoke it

```bash
bash .claude/skills/audit-website/scripts/audit.sh https://example.com
bash .claude/skills/audit-website/scripts/audit.sh https://example.com --quick
```

The script writes raw artifacts to `/tmp/audit-<host>-<epoch>/` and prints
the aggregated Markdown report to stdout.

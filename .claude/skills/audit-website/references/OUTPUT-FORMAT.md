# audit-website — output format

The `scripts/audit.sh` runner emits one Markdown document to stdout. Sections
and their data sources, in order:

## 1. Composite health score

Average of the four Lighthouse pillars (Performance / Accessibility / SEO /
Best Practices), rounded. Quick mode appends *"(quick mode — axe and
link-check skipped)"*.

## 2. Scorecard

Markdown table:

| Category | Score |
| --- | --- |
| Performance | 🟢 92/100 |
| Accessibility | 🟡 78/100 |
| SEO | 🟢 95/100 |
| Best Practices | 🔴 65/100 |

- 🟢 = ≥90 · 🟡 = 70-89 · 🔴 = <70 · "n/a" if Lighthouse couldn't compute.

Source: `lighthouse.categories[*].score * 100`.

## 3. Performance

Core Web Vitals + supporting metrics from Lighthouse audit IDs:

- `largest-contentful-paint` → LCP
- `interaction-to-next-paint` → INP
- `cumulative-layout-shift` → CLS
- `first-contentful-paint` → FCP
- `total-blocking-time` → TBT
- `speed-index` → SI

Uses each audit's `displayValue` first, then falls back to `numericValue`.

## 4. SEO

Bullet list:

- Title (value + char length)
- Meta description (value + char length)
- Canonical URL
- Viewport meta
- Robots meta
- robots.txt HTTP status
- sitemap.xml HTTP status
- JSON-LD block count + detected `@type`s

Followed by a table of OpenGraph (`og:title`, `og:description`, `og:image`,
`og:url`, `og:type`) and Twitter card tags (`twitter:card`, `twitter:title`,
`twitter:description`, `twitter:image`). Missing values render as
**missing** (bold).

Source: `scripts/meta-check.mjs` parses the HTML head via regex. robots /
sitemap fetched with curl; status code from `-w '%{http_code}'`.

## 5. Accessibility

In `--quick` mode: a note that axe was skipped.

Otherwise: total violation count + node count, then violations grouped by
impact (critical / serious / moderate / minor). Each line is:

```
- `<rule-id>` — <help text> (<N> nodes) [docs](<helpUrl>)
```

Source: `@axe-core/cli` JSON, `result.violations[]`.

## 6. Security & Best Practices

- One-line HTTPS / mixed-content summary from Lighthouse `is-on-https`.
- Table of response headers (HSTS, CSP, X-Frame-Options, Referrer-Policy,
  X-Content-Type-Options, Permissions-Policy). Missing values render as
  **missing**.

Source: `curl -sIL` against the URL.

## 7. Broken Links

In `--quick` mode: a note that linkinator was skipped.

Otherwise: total scanned + broken counts (split internal vs external),
followed by a table of the first 20 broken links with status, URL, and
parent. "_N more_" row appended if there are more.

Source: `linkinator` JSON, filtering `state === "BROKEN"`. Internal vs
external classified by URL host comparison with the audit target.

## 8. Top Recommendations

Bulleted list, sorted high → medium → low. Each entry:

```
- **[<priority>] <area>** — <concrete fix guidance>
```

Generated rules (in `scripts/aggregate.mjs`):

| Trigger | Priority | Area |
| --- | --- | --- |
| Perf score < 70 | high | Performance |
| A11y score < 90 | high | Accessibility |
| ≥1 critical axe violation | high | Accessibility |
| Internal broken links present | high | Broken links |
| Mixed-content / non-HTTPS | high | Security |
| SEO score < 90 | medium | SEO |
| Each meta issue (missing title, etc.) | medium | SEO/Meta |
| robots.txt non-200 | medium | Crawlability |
| Missing security headers | medium | Security headers |
| sitemap.xml non-200 | low | Crawlability |
| >5 external broken links | low | Broken links |

## Raw artifacts

In addition to stdout, the runner writes raw outputs to
`/tmp/audit-<host>-<epoch>/`:

- `lighthouse.json` — full Lighthouse run (categories, audits, metrics)
- `lighthouse.log` — Lighthouse stderr
- `axe.json` — axe-cli output (`[]` if skipped or empty)
- `axe.log` — axe-cli stderr
- `linkinator.json` — full link scan results
- `linkinator.log` — linkinator stderr
- `headers.txt` — `curl -sIL` output
- `robots.txt` — fetched robots.txt body (empty if non-200)
- `sitemap.xml` — fetched sitemap.xml body (empty if non-200)
- `meta.json` — meta-check.mjs output (title, description, OG, JSON-LD, issues)
- `meta.log` — meta-check.mjs stderr

These let the agent drill into specifics ("show me the LCP element",
"what's the actual CSP string", "which axe nodes failed `color-contrast`")
without re-running the full audit.

---
name: audit-website
description: Audit websites for SEO, performance, security, technical, content, and 15 other issue cateories with 230+ rules using the squirrelscan CLI. Returns LLM-optimized reports with health scores, broken links, meta tag analysis, and actionable recommendations. Use to discover and asses website or webapp issues and health.
license: See LICENSE file in repository root
compatibility: Requires squirrel CLI installed and accessible in PATH
metadata:
  author: squirrelscan
  version: "1.22"
allowed-tools: Bash(squirrel:*) Read Edit Grep Glob
---

# Website Audit Skill

Audit websites for SEO, technical, content, performance and security issues using the squirrelscan cli.

squirrelscan provides a cli tool squirrel - available for macos, windows and linux. It carries out extensive website auditing
by emulating a browser, search crawler, and analyzing the website's structure and content against over 230+ rules.

It will provide you a list of issues as well as suggestions on how to fix them.

## Links 

* squirrelscan website is at [https://squirrelscan.com](https://squirrelscan.com)
* documentation (including rule references) are at [docs.squirrelscan.com](https://docs.squirrelscan.com)

You can look up the docs for any rule with this template:

https://docs.squirrelscan.com/rules/{rule_category}/{rule_id}

example:

https://docs.squirrelscan.com/rules/links/external-links

## What This Skill Does

This skill enables AI agents to audit websites for over 230 rules in 21 categories, including:

- **SEO issues**: Meta tags, titles, descriptions, canonical URLs, Open Graph tags
- **Technical problems**: Broken links, redirect chains, page speed, mobile-friendliness
- **Performance**: Page load time, resource usage, caching
- **Content quality**: Heading structure, image alt text, content analysis
- **Security**: Leaked secrets, HTTPS usage, security headers, mixed content
- **Accessibility**: Alt text, color contrast, keyboard navigation
- **Usability**: Form validation, error handling, user flow
- **Links**: Checks for broken internal and external links
- **E-E-A-T**: Expertise, Experience, Authority, Trustworthiness
- **User Experience**: User flow, error handling, form validation
- **Mobile**: Checks for mobile-friendliness, responsive design, touch-friendly elements
- **Crawlability**: Checks for crawlability, robots.txt, sitemap.xml and more
- **Schema**: Schema.org markup, structured data, rich snippets
- **Legal**: Compliance with legal requirements, privacy policies, terms of service
- **Social**: Open graph, twitter cards and validating schemas, snippets etc.
- **Url Structure**: Length, hyphens, keywords
- **Keywords**: Keyword stuffing 
- **Content**: Content structure, headings
- **Images**: Alt text, color contrast, image size, image format
- **Local SEO**: NAP consistency, geo metadata
- **Video**: VideoObject schema, accessibility

and more

The audit crawls the website, analyzes each page against audit rules, and returns a comprehensive report with:
- Overall health score (0-100)
- Category breakdowns (core SEO, technical SEO, content, security)
- Specific issues with affected URLs
- Broken link detection
- Actionable recommendations
- Rules have levels of error, warning and notice and also have a rank between 1 and 10

## When to Use

Use this skill when you need to:

- Analyze a website's health
- Debug technical SEO issues
- Fix all of the issues mentioned above
- Check for broken links
- Validate meta tags and structured data
- Generate site audit reports
- Compare site health before/after changes
- Improve website performance, accessibility, SEO, security and more.

You should re-audit as often as possible to ensure your website remains healthy and performs well. 

## Prerequisites

This skill requires the squirrel CLI installed and in PATH.

**Install:** [squirrelscan.com/download](https://squirrelscan.com/download)

**Verify:**
```bash
squirrel --version
```

## Setup

Run `squirrel init` to create a `squirrel.toml` config in the current directory. If none exists, create one and specify a project name:

```bash
squirrel init -n my-project
# overwrite existing config
squirrel init -n my-project --force
```

## Usage

### Intro

There are three processes that you can run and they're all cached in the local project database:

- crawl - subcommand to run a crawl or refresh, continue a crawl
- analyze - subcommand to analyze the crawl results
- report - subcommand to generate a report in desired format (llm, text, console, html etc.)

the 'audit' command is a wrapper around these three processes and runs them sequentially:

```bash
squirrel audit https://example.com --format llm
```

YOU SHOULD always prefer format option llm - it was made for you and provides an exhaustive and compact output format.

FIRST SCAN should be a surface scan, which is a quick and shallow scan of the website to gather basic information about the website, such as its structure, content, and technology stack. This scan can be done quickly and without impacting the website's performance.

SECOND SCAN should be a deep scan, which is a thorough and detailed scan of the website to gather more information about the website, such as its security, performance, and accessibility. This scan can take longer and may impact the website's performance.

If the user doesn't provide a website to audit, ask which URL they'd like audited.

You should PREFER to audit live websites - only there do we get a TRUE representation of the website and performance or rendering issuers. 

If you have both local and live websites to audit, prompt the user to choose which one to audit and SUGGEST they choose live.

You can apply fixes from an audit on the live site against the local code.

When planning scope tasks so they can run concurrently as sub-agents to speed up fixes. 

When implementing fixes take advantage of subagents to speed up implementation of fixes.

After applying fixes, verify the code still builds and passes any existing checks in the project.

### Basic Workflow

The audit process is two steps:

1. **Run the audit** (saves to database, shows console output)
2. **Export report** in desired format

```bash
# Step 1: Run audit (default: console output)
squirrel audit https://example.com

# Step 2: Export as LLM format
squirrel report <audit-id> --format llm
```

### Regression Diffs

When you need to detect regressions between audits, use diff mode:

```bash
# Compare current report against a baseline audit ID
squirrel report --diff <audit-id> --format llm

# Compare latest domain report against a baseline domain
squirrel report --regression-since example.com --format llm
```

Diff mode supports `console`, `text`, `json`, `llm`, and `markdown`. `html` and `xml` are not supported.

### Running Audits

When running an audit:

1. **Present the report** - show the user the audit results and score
2. **Propose fixes** - list the issues you can fix and ask the user to confirm before making changes
3. **Parallelize approved fixes** - use subagents for bulk content edits (alt text, headings, descriptions)
4. **Iterate** - fix batch → re-audit → present results → propose next batch
5. **Pause for judgment** - broken links, structural changes, and anything ambiguous should be flagged for user review
6. **Show before/after** - present score comparison after each fix batch

- **Iteration Loop**: After fixing a batch of issues, re-audit and continue fixing until:
  - Score reaches target (typically 85+), OR
  - Only issues requiring human judgment remain (e.g., "should this link be removed?")

- **Treat all fixes equally**: Code changes and content changes are equally important.

- **Parallelize content fixes**: For issues affecting multiple files:
  - Spawn subagents to fix in parallel
  - Example: 7 files need alt text → spawn 1-2 agents to fix all
  - Example: 30 files have heading issues → spawn agents to batch edit

- **Completion criteria**:
  - ✅ All errors fixed
  - ✅ All warnings fixed (or documented as requiring human review)
  - ✅ Re-audit confirms improvements
  - ✅ Before/after comparison shown to user

After fixes are applied, ask the user if they'd like to review the changes.

### Score Targets

| Starting Score | Target Score | Expected Work |
|----------------|--------------|---------------|
| < 50 (Grade F) | 75+ (Grade C) | Major fixes |
| 50-70 (Grade D) | 85+ (Grade B) | Moderate fixes |
| 70-85 (Grade C) | 90+ (Grade A) | Polish |
| > 85 (Grade B+) | 95+ | Fine-tuning |

A site is only considered COMPLETE and FIXED when scores are above 95 (Grade A) with coverage set to FULL (--coverage full).

### Issue Categories

| Category | Fix Approach | Parallelizable |
|----------|--------------|----------------|
| Meta tags/titles | Edit page components or metadata | No |
| Structured data | Add JSON-LD to page templates | No |
| Missing H1/headings | Edit page components + content files | Yes (content) |
| Image alt text | Edit content files | Yes |
| Heading hierarchy | Edit content files | Yes |
| Short descriptions | Edit content frontmatter | Yes |
| HTTP→HTTPS links | Find and replace in content | Yes |
| Broken links | Manual review (flag for user) | No |

**For parallelizable fixes**: Spawn subagents with specific file assignments.

### Content File Fixes

Many issues require editing content files. These are equally important as code fixes:

- **Image alt text**: Add descriptive alt text to images
- **Heading hierarchy**: Fix skipped heading levels
- **Meta descriptions**: Extend short descriptions in frontmatter
- **HTTP links**: Update insecure links to HTTPS

### Parallelizing Fixes with Subagents

When the user approves a batch of fixes, you can use subagents to apply them in parallel:

- **Ask the user first** — always confirm which fixes to apply before spawning subagents
- Group 3-5 files per subagent for the same fix type
- Only parallelize independent files (no shared components or config)
- Spawn multiple subagents in a single message for concurrent execution

### Advanced Options

Audit more pages:

```bash
squirrel audit https://example.com --max-pages 200
```

Force fresh crawl (ignore cache):

```bash
squirrel audit https://example.com --refresh
```

Resume interrupted crawl:

```bash
squirrel audit https://example.com --resume
```

Verbose output for debugging:

```bash
squirrel audit https://example.com --verbose
```

## Common Options

### Audit Command Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--format <fmt>` | `-f <fmt>` | Output format: console, text, json, html, markdown, llm | console |
| `--coverage <mode>` | `-C <mode>` | Coverage mode: quick, surface, full | surface |
| `--max-pages <n>` | `-m <n>` | Maximum pages to crawl (max 5000) | varies by coverage |
| `--output <path>` | `-o <path>` | Output file path | - |
| `--refresh` | `-r` | Ignore cache, fetch all pages fresh | false |
| `--resume` | - | Resume interrupted crawl | false |
| `--verbose` | `-v` | Verbose output | false |
| `--debug` | - | Debug logging | false |
| `--trace` | - | Enable performance tracing | false |
| `--project-name <name>` | `-n <name>` | Override project name | from config |

### Coverage Modes

Choose a coverage mode based on your audit needs:

| Mode | Default Pages | Behavior | Use Case |
|------|---------------|----------|----------|
| `quick` | 25 | Seed + sitemaps only, no link discovery | CI checks, fast health check |
| `surface` | 100 | One sample per URL pattern | General audits (default) |
| `full` | 500 | Crawl everything up to limit | Deep analysis |

**Surface mode is smart** - it detects URL patterns like `/blog/{slug}` or `/products/{id}` and only crawls one sample per pattern. This makes it efficient for sites with many similar pages (blogs, e-commerce).

```bash
# Quick health check (25 pages, no link discovery)
squirrel audit https://example.com -C quick --format llm

# Default surface audit (100 pages, pattern sampling)
squirrel audit https://example.com --format llm

# Full comprehensive audit (500 pages)
squirrel audit https://example.com -C full --format llm

# Override page limit for any mode
squirrel audit https://example.com -C surface -m 200 --format llm
```

**When to use each mode:**
- `quick`: CI pipelines, daily health checks, monitoring
- `surface`: Most audits - covers unique templates efficiently
- `full`: Before launches, comprehensive analysis, deep dives

### Report Command Options

| Option | Alias | Description |
|--------|-------|-------------|
| `--list` | `-l` | List recent audits |
| `--severity <level>` | - | Filter by severity: error, warning, all |
| `--category <cats>` | - | Filter by categories (comma-separated) |
| `--format <fmt>` | `-f <fmt>` | Output format: console, text, json, html, markdown, xml, llm |
| `--output <path>` | `-o <path>` | Output file path |
| `--input <path>` | `-i <path>` | Load from JSON file (fallback mode) |

### Config Subcommands

| Command | Description |
|---------|-------------|
| `config show` | Show current config |
| `config set <key> <value>` | Set config value |
| `config path` | Show config file path |
| `config validate` | Validate config file |

### Other Commands

| Command | Description |
|---------|-------------|
| `squirrel feedback` | Send feedback to squirrelscan team |
| `squirrel skills install` | Install Claude Code skill |
| `squirrel skills update` | Update Claude Code skill |

### Self Commands

Self-management commands under `squirrel self`:

| Command | Description |
|---------|-------------|
| `self install` | Bootstrap local installation |
| `self update` | Check and apply updates |
| `self completion` | Generate shell completions |
| `self doctor` | Run health checks |
| `self version` | Show version information |
| `self settings` | Manage CLI settings |
| `self uninstall` | Remove squirrel from the system |

## Output Formats

### Console Output (default)

The `audit` command shows human-readable console output by default with colored output and progress indicators.

### LLM Format

To get LLM-optimized output, use the `report` command with `--format llm`:

```bash
squirrel report <audit-id> --format llm
```

The LLM format is a compact XML/text hybrid optimized for token efficiency (40% smaller than verbose XML):

- **Summary**: Overall health score and key metrics
- **Issues by Category**: Grouped by audit rule category (core SEO, technical, content, security)
- **Broken Links**: List of broken external and internal links
- **Recommendations**: Prioritized action items with fix suggestions

See [OUTPUT-FORMAT.md](references/OUTPUT-FORMAT.md) for detailed format specification.

## Examples

### Example 1: Quick Site Audit with LLM Output

```bash
# User asks: "Check squirrelscan.com for SEO issues"
squirrel audit https://squirrelscan.com --format llm
```

### Example 2: Deep Audit for Large Site

```bash
# User asks: "Do a thorough audit of my blog with up to 500 pages"
squirrel audit https://myblog.com --max-pages 500 --format llm
```

### Example 3: Fresh Audit After Changes

```bash
# User asks: "Re-audit the site and ignore cached results"
squirrel audit https://example.com --refresh --format llm
```

### Example 4: Two-Step Workflow (Reuse Previous Audit)

```bash
# First run an audit
squirrel audit https://example.com
# Note the audit ID from output (e.g., "a1b2c3d4")

# Later, export in different format
squirrel report a1b2c3d4 --format llm
```

## Output

On completion give the user a summary of all of the changes you made.

## Troubleshooting

### squirrel command not found

If you see this error, squirrel is not installed or not in your PATH.

**Solution:**
1. Install squirrel: [squirrelscan.com/download](https://squirrelscan.com/download)
2. Ensure `~/.local/bin` is in PATH
3. Verify: `squirrel --version`

### Permission denied

If squirrel is not executable, ensure the binary has execute permissions. Reinstalling from [squirrelscan.com/download](https://squirrelscan.com/download) will fix this.

### Crawl timeout or slow performance

For very large sites, the audit may take several minutes. Use `--verbose` to see progress:

```bash
squirrel audit https://example.com --format llm --verbose
```

### Invalid URL

Ensure the URL includes the protocol (http:// or https://):

```bash
# ✗ Wrong
squirrel audit example.com

# ✓ Correct
squirrel audit https://example.com
```

## How It Works

1. **Crawl**: Discovers and fetches pages starting from the base URL
2. **Analyze**: Runs audit rules on each page
3. **External Links**: Checks external links for availability
4. **Report**: Generates LLM-optimized report with findings

The audit is stored in a local database and can be retrieved later with `squirrel report` commands.

## Additional Resources

- **Output Format Reference**: [OUTPUT-FORMAT.md](references/OUTPUT-FORMAT.md)
- **squirrelscan Documentation**: https://docs.squirrelscan.com
- **CLI Help**: `squirrel audit --help`

# LLM Format Output Reference

## Overview

The `--format llm` output is a compact, token-optimized hybrid XML/text format designed specifically for AI agent consumption. It provides structured audit data in a format that balances machine readability with token efficiency.

## Key Characteristics

- **40-70% smaller** than verbose XML format
- **1-space indentation** for minimal token usage
- **Hybrid structure**: XML tags + text prefixes for metadata
- **Inline attributes**: Metadata stored as XML attributes, not nested elements
- **Comma-separated lists**: Pages and arrays formatted inline
- **Flattened hierarchy**: Reduced nesting depth compared to verbose XML

## Format Structure

### 1. Document Header

```xml
<?xml version="1.0" encoding="UTF-8"?>
<audit version="0.0.24">
```

### 2. Site Information

```xml
<site url="https://example.com" crawled="51" date="2025-01-18T10:30:00Z"/>
```

Attributes:
- `url` - Base URL audited
- `crawled` - Number of pages crawled
- `date` - ISO 8601 timestamp

### 3. Health Score

```xml
<score overall="85" grade="B">
 <cat name="Core SEO" score="92"/>
 <cat name="Technical SEO" score="88"/>
 <cat name="Content Quality" score="76"/>
</score>
```

Attributes:
- `overall` - 0-100 health score
- `grade` - Letter grade (A-F)
- Categories with individual scores

### 4. Summary

```xml
<summary passed="120" warnings="15" failed="8"/>
```

Attributes:
- `passed` - Number of passed checks
- `warnings` - Number of warnings
- `failed` - Number of failed checks

### 5. Issues Section

Issues are grouped by category with compact inline metadata:

```xml
<issues>
 <category name="Core SEO" errors="2" warnings="3">
  <rule id="core/meta-title" severity="error" status="fail">
   Missing or empty meta title tags
   Desc: Every page should have a unique meta title
   Fix: Add descriptive <title> tags to each page
   Pages (2): https://example.com/about, https://example.com/contact
   Items (2):
    - https://example.com/about
    - https://example.com/contact
  </rule>
  <rule id="core/meta-description" severity="warning" status="warn">
   Desc: Pages should have meta descriptions
   Fix: Add <meta name="description"> tags
   Pages (5): https://example.com/page1, https://example.com/page2, ...
  </rule>
 </category>
 <category name="Performance" errors="0" warnings="1">
  ...
 </category>
</issues>
```

#### Rule Structure

Each `<rule>` element contains:

**Attributes:**
- `id` - Rule identifier (e.g., `core/meta-title`)
- `severity` - `error`, `warning`, or `info`
- `status` - `pass`, `warn`, or `fail`

**Text Content (in order):**
1. **Message** (optional) - Human-readable issue summary
2. **Desc:** - Rule description (what's being checked)
3. **Fix:** - Recommended solution (how to fix)
4. **Pages (n):** - Comma-separated list of affected URLs
5. **Items (n):** - Dash-prefixed list of specific items with metadata

### 6. Items Format

Items provide detailed context about affected elements:

```xml
Items (3):
 - https://example.com/missing-title (title: "")
 - https://example.com/duplicate-title (title: "Home Page") (from: https://example.com/other)
 - /broken-link [status: 404, type: internal] (from: https://example.com/contact)
```

Item format:
- `- <id>` - Primary identifier (URL, selector, etc.)
- `(<label>)` - Optional human-readable label if different from id
- `[key: value, ...]` - Metadata in square brackets
- `(from: <sources>)` - Source pages where item appears

## Diff Output (LLM Format)

When using `squirrel report --diff` or `--regression-since` with `--format llm`,
the output is a compact XML diff format:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<diff version="0.0.24">
 <baseline id="a7b3c2d1" url="https://example.com" date="2026-01-17T10:30:00Z" pages="42" score="87" grade="B"/>
 <current id="b9c4e1f2" url="https://example.com" date="2026-01-18T10:30:00Z" pages="44" score="84" grade="B"/>
 <summary added="3" removed="1" changed="2" regressions="1" improvements="1"/>
 <added>
  <issue fp="abc123" rule="core/meta-title" severity="error" status="fail" check="meta-title" category="core" weight="8">
   Missing page title
   Target: page /about
  </issue>
 </added>
 <removed>
  ...
 </removed>
 <changed>
  <change type="regression" fp="def456" rule="links/broken-links" severity="warning" status="fail" check="broken-links">
   warn→fail: Broken link count increased
   Before:
    <issue ...> ... </issue>
   After:
    <issue ...> ... </issue>
  </change>
 </changed>
</diff>
```

Key fields:
- `fp`: deterministic fingerprint for the issue instance
- `rule`, `check`, `severity`, `status`: rule and check metadata
- `Target:`: item/page/check target
- `change type`: `regression`, `improvement`, or `change`

## Example Output

```xml
<?xml version="1.0" encoding="UTF-8"?>
<audit version="0.0.24">
<site url="https://example.com" crawled="51" date="2025-01-18T10:30:00Z"/>
<score overall="78" grade="C">
 <cat name="Core SEO" score="85"/>
 <cat name="Technical SEO" score="92"/>
 <cat name="Performance" score="65"/>
</score>
<summary passed="98" warnings="12" failed="5"/>
<issues>
 <category name="Core SEO" errors="2" warnings="1">
  <rule id="core/meta-title" severity="error" status="fail">
   Missing meta title on 2 pages
   Desc: Every page should have a unique meta title
   Fix: Add descriptive <title> tags to each page
   Pages (2): https://example.com/about, https://example.com/contact
   Items (2):
    - https://example.com/about
    - https://example.com/contact
  </rule>
 </category>
</issues>
</audit>
```

## Usage

The LLM format is available via both `audit` and `report` commands:

```bash
# Direct LLM output (single step)
squirrel audit https://example.com --format llm

# Or two-step workflow
squirrel audit https://example.com
squirrel report <audit-id> --format llm

# Pipe directly to AI agent
squirrel audit https://example.com --format llm | claude
```

The `audit` command supports `--format llm` directly for convenience. Use the two-step workflow when you need to generate reports in multiple formats from a single audit.

## Comparison with Other Formats

| Format | Size | Structure | Best For |
|--------|------|-----------|----------|
| `xml` | 209KB | Verbose, 2-space indent, fully nested | Enterprise integration, archival |
| `llm` | 125KB | Compact, 1-space indent, hybrid | AI agents, token-limited contexts |
| `json` | 180KB | Structured data | Programmatic processing |
| `text` | 45KB | Plain text, no structure | Simple piping, grep |

## Token Efficiency

The LLM format achieves 40-70% size reduction compared to verbose XML through:

1. **1-space indentation** instead of 2-4 spaces
2. **Inline attributes** instead of nested elements
3. **Text prefixes** (Desc:, Fix:) instead of XML tags
4. **Comma-separated lists** instead of multiple elements
5. **Flattened hierarchy** - fewer nesting levels

## XML Character Escaping

Special characters are properly escaped:
- `&` → `&amp;`
- `<` → `&lt;`
- `>` → `&gt;`
- `"` → `&quot;`
- `'` → `&apos;`

## Design Philosophy

The LLM format is optimized for:
1. **Token efficiency** - Critical for API cost and context limits
2. **Easy parsing** - XML structure for reliable extraction
3. **Human readability** - AI agents can explain issues naturally
4. **Progressive disclosure** - Summary → Categories → Rules → Items
5. **Actionable insights** - Fix recommendations included inline

## Implementation Notes

- Generated by `generateLlmReport()` in `app/src/reports/output/llm.ts`
- Empty issues section renders as self-closing: `<issues/>`
- All text content is XML-escaped for safety
- Indentation uses spaces only (no tabs)
- Line endings are Unix-style (`\n`)

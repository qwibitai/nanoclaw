# Scan Modes Reference

## Mode: Run All

Full scan with all rulesets and severity levels. Current default behavior. No filtering applied — all findings are reported and triaged.

## Mode: Important Only

Focused on high-confidence security vulnerabilities. Excludes code quality, best practices, and low-confidence audit findings.

### Pre-Filter: CLI Severity Flag

Add these flags to every `semgrep` command:

```bash
--severity MEDIUM --severity HIGH --severity CRITICAL
```

This excludes LOW/INFO severity findings at scan time, reducing output volume before post-filtering.

### Post-Filter: Metadata Criteria

After scanning, filter each JSON result file to keep only findings matching ALL of:

| Metadata Field | Accepted Values | Rationale |
|---|---|---|
| `extra.metadata.category` | `"security"` | Excludes correctness, best-practice, maintainability, performance |
| `extra.metadata.confidence` | `"MEDIUM"`, `"HIGH"` | Excludes low-precision rules (high false positive rate) |
| `extra.metadata.impact` | `"MEDIUM"`, `"HIGH"` | Excludes low-impact informational findings |

**Third-party rules** (Trail of Bits, 0xdea, Decurity, etc.) may not have `confidence`/`impact`/`category` metadata. Findings **without** these metadata fields are **kept** — we cannot filter what is not annotated, and third-party rules are typically security-focused.

### Semgrep Metadata Background

Semgrep security rules have these metadata fields (required for `category: security` in the official registry):

| Field | Purpose | Values |
|---|---|---|
| `severity` (top-level) | Overall rule severity, derived from likelihood × impact | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `category` | Rule category | `security`, `correctness`, `best-practice`, `maintainability`, `performance` |
| `confidence` | True positive rate of the rule (precision) | `LOW`, `MEDIUM`, `HIGH` |
| `impact` | Potential damage if vulnerability is exploited | `LOW`, `MEDIUM`, `HIGH` |
| `likelihood` | How likely the vulnerability is exploitable | `LOW`, `MEDIUM`, `HIGH` |
| `subcategory` | Finding type | `vuln`, `audit`, `secure default` |

Key relationship: `severity = f(likelihood, impact)` while `confidence` is independent (describes rule quality, not vulnerability severity).

### Post-Filter jq Command

Apply to each JSON result file after scanning:

```bash
# Filter a single result file
jq '{
  results: [.results[] |
    ((.extra.metadata.category // "security") | ascii_downcase) as $cat |
    ((.extra.metadata.confidence // "HIGH") | ascii_upcase) as $conf |
    ((.extra.metadata.impact // "HIGH") | ascii_upcase) as $imp |
    select(
      ($cat == "security") and
      ($conf == "MEDIUM" or $conf == "HIGH") and
      ($imp == "MEDIUM" or $imp == "HIGH")
    )
  ],
  errors: .errors,
  paths: .paths
}' "$f" > "${f%.json}-important.json"
```

Default values (`// "security"`, `// "HIGH"`) handle third-party rules without metadata — they pass all filters by default.

### Filter All Result Files in a Directory

Raw scan output lives in `$OUTPUT_DIR/raw/`. The filter creates `*-important.json` files alongside the originals — the raw files are preserved unmodified.

```bash
# Apply important-only filter to all scan result JSON files in raw/
for f in "$OUTPUT_DIR/raw"/*-*.json; do
  [[ "$f" == *-triage.json || "$f" == *-important.json ]] && continue
  jq '{
    results: [.results[] |
      ((.extra.metadata.category // "security") | ascii_downcase) as $cat |
      ((.extra.metadata.confidence // "HIGH") | ascii_upcase) as $conf |
      ((.extra.metadata.impact // "HIGH") | ascii_upcase) as $imp |
      select(
        ($cat == "security") and
        ($conf == "MEDIUM" or $conf == "HIGH") and
        ($imp == "MEDIUM" or $imp == "HIGH")
      )
    ],
    errors: .errors,
    paths: .paths
  }' "$f" > "${f%.json}-important.json"
  BEFORE=$(jq '.results | length' "$f")
  AFTER=$(jq '.results | length' "${f%.json}-important.json")
  echo "$f: $BEFORE → $AFTER findings (filtered $(( BEFORE - AFTER )))"
done
```

### Scanner Task Modifications

In important-only mode, add `[SEVERITY_FLAGS]` to the scanner template:

```bash
semgrep [--pro if available] --metrics=off [SEVERITY_FLAGS] --config [RULESET] --json -o [OUTPUT_DIR]/raw/[lang]-[ruleset].json --sarif-output=[OUTPUT_DIR]/raw/[lang]-[ruleset].sarif [TARGET] &
```

Where `[SEVERITY_FLAGS]` is:
- **Run all**: *(empty)*
- **Important only**: `--severity MEDIUM --severity HIGH --severity CRITICAL`

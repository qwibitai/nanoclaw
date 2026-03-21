# Important-Only Query Suite

In important-only mode, generate a custom `.qls` query suite file at runtime. This applies the same precision/severity filtering to **all** packs (official + third-party).

## Why a Custom Suite

The built-in `security-extended` suite only applies to the official `codeql/<lang>-queries` pack. Third-party packs (Trail of Bits, Community Packs) run unfiltered when passed directly to `codeql database analyze`. A custom `.qls` suite loads queries from all packs and applies a single set of `include`/`exclude` filters uniformly.

## Metadata Criteria

Two-phase filtering: the **suite** selects candidate queries (broad), then a **post-analysis jq filter** removes low-severity medium-precision results from the SARIF output.

### Phase 1: Suite selection (which queries run)

Queries are included if they match **any** of these blocks (OR logic across blocks, AND logic within):

| Block | kind | precision | problem.severity | tags |
|-------|------|-----------|-----------------|------|
| 1 | `problem`, `path-problem` | `high`, `very-high` | *(any)* | must contain `security` |
| 2 | `problem`, `path-problem` | `medium` | *(any)* | must contain `security` |

### Phase 2: Post-analysis filter (which results are reported)

After `codeql database analyze` completes, filter the SARIF output:

| precision | security-severity | Action |
|-----------|-------------------|--------|
| high / very-high | *(any)* | **Keep** |
| medium | >= 6.0 | **Keep** |
| medium | < 6.0 or missing | **Drop** |

This ensures medium-precision queries with meaningful security impact (e.g., `cpp/path-injection` at 7.5, `cpp/world-writable-file-creation` at 7.8) are included, while noisy low-severity medium-precision findings are filtered out.

Excluded: deprecated queries, model editor/generator queries. Experimental queries are **included**.

**Key difference from `security-extended`:** The `security-extended` suite includes medium-precision queries at any severity. Important-only mode adds a security-severity threshold to reduce noise from medium-precision queries that flag low-impact issues.

## Suite Template

Generate this file as `important-only.qls` in the results directory before running analysis:

```yaml
- description: Important-only — security vulnerabilities, medium-high confidence
# Official queries
- queries: .
  from: codeql/<CODEQL_LANG>-queries
# Third-party packs (include only if installed, one entry per pack)
# - queries: .
#   from: trailofbits/<CODEQL_LANG>-queries
# - queries: .
#   from: GitHubSecurityLab/CodeQL-Community-Packs-<CODEQL_LANG>
# Filtering: security only, high/very-high precision (any severity),
# medium precision (any severity — low-severity filtered post-analysis by security-severity score).
# Experimental queries included.
- include:
    kind:
      - problem
      - path-problem
    precision:
      - high
      - very-high
    tags contain:
      - security
- include:
    kind:
      - problem
      - path-problem
    precision:
      - medium
    tags contain:
      - security
- exclude:
    deprecated: //
- exclude:
    tags contain:
      - modeleditor
      - modelgenerator
```

> **Post-analysis step required:** After running the analysis, apply the post-analysis jq filter (defined in the run-analysis workflow Step 5) to remove medium-precision results with `security-severity` < 6.0.

## Generation Script

The agent should generate the suite file dynamically based on installed packs:

```bash
RAW_DIR="$OUTPUT_DIR/raw"
SUITE_FILE="$RAW_DIR/important-only.qls"

# NOTE: CODEQL_LANG must be set before running this script (e.g., CODEQL_LANG=cpp)
# NOTE: INSTALLED_THIRD_PARTY_PACKS must be a space-separated list of pack names

# Use a heredoc WITHOUT quotes so ${CODEQL_LANG} expands
cat > "$SUITE_FILE" << HEADER
- description: Important-only — security vulnerabilities, medium-high confidence
- queries: .
  from: codeql/${CODEQL_LANG}-queries
HEADER

# Add each installed third-party pack
for PACK in $INSTALLED_THIRD_PARTY_PACKS; do
  cat >> "$SUITE_FILE" << PACK_ENTRY
- queries: .
  from: ${PACK}
PACK_ENTRY
done

# Append the filtering rules (quoted heredoc — no variable expansion needed)
cat >> "$SUITE_FILE" << 'FILTERS'
- include:
    kind:
      - problem
      - path-problem
    precision:
      - high
      - very-high
    tags contain:
      - security
- include:
    kind:
      - problem
      - path-problem
    precision:
      - medium
    tags contain:
      - security
- exclude:
    deprecated: //
- exclude:
    tags contain:
      - modeleditor
      - modelgenerator
FILTERS

# Verify the suite resolves correctly
: "${CODEQL_LANG:?ERROR: CODEQL_LANG must be set before generating suite}"
: "${SUITE_FILE:?ERROR: SUITE_FILE must be set}"

if ! codeql resolve queries "$SUITE_FILE" | head -20; then
  echo "ERROR: Suite file failed to resolve. Check CODEQL_LANG=$CODEQL_LANG and installed packs."
fi
echo "Suite generated: $SUITE_FILE"
```

## How Filtering Works on Third-Party Queries

CodeQL query suite filters match on query metadata (`@precision`, `@problem.severity`, `@tags`). Third-party queries that:

- **Have proper metadata**: Filtered normally (kept if they match the include criteria)
- **Lack `@precision`**: Excluded by `include` blocks (they require precision to match). This is correct — if a query doesn't declare its precision, we cannot assess its confidence.
- **Lack `@tags security`**: Excluded. Non-security queries are not relevant to important-only mode.

This is a stricter-than-necessary filter for third-party packs, but it ensures only well-annotated security queries run in important-only mode. The post-analysis jq filter then further narrows medium-precision results to those with `security-severity` >= 6.0.

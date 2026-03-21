# SARIF Processing

jq commands for processing CodeQL SARIF output. Used in the run-analysis workflow Step 5.

> **SARIF structure note:** `security-severity` and `level` are stored on rule definitions (`.runs[].tool.driver.rules[]`), NOT on individual result objects. Results reference rules by `ruleIndex`. The jq commands below join results with their rule metadata.
>
> **Portability note:** These jq patterns assume CodeQL SARIF output where `ruleIndex` is populated. For SARIF from other tools (e.g., Semgrep), use `ruleId`-based lookups instead.

> **Directory convention:** Unfiltered output lives in `$RAW_DIR` (`$OUTPUT_DIR/raw`). Final results live in `$RESULTS_DIR` (`$OUTPUT_DIR/results`). The summary commands below operate on `$RESULTS_DIR/results.sarif` (the final output).

## Count Findings

```bash
jq '.runs[].results | length' "$RESULTS_DIR/results.sarif"
```

## Summary by SARIF Level

```bash
jq -r '
  .runs[] |
  . as $run |
  .results[] |
  ($run.tool.driver.rules[.ruleIndex].defaultConfiguration.level // "unknown")
' "$RESULTS_DIR/results.sarif" \
  | sort | uniq -c | sort -rn
```

## Summary by Security Severity (most useful for triage)

```bash
jq -r '
  .runs[] |
  . as $run |
  .results[] |
  ($run.tool.driver.rules[.ruleIndex].properties["security-severity"] // "none") + " | " +
  .ruleId + " | " +
  (.locations[0].physicalLocation.artifactLocation.uri // "?") + ":" +
  ((.locations[0].physicalLocation.region.startLine // 0) | tostring) + " | " +
  (.message.text // "no message" | .[0:80])
' "$RESULTS_DIR/results.sarif" | sort -rn | head -20
```

## Summary by Rule

```bash
jq -r '.runs[].results[] | .ruleId' "$RESULTS_DIR/results.sarif" \
  | sort | uniq -c | sort -rn
```

## Important-Only Post-Filter

If scan mode is "important only", filter out medium-precision results with `security-severity` < 6.0 from the report. The suite includes all medium-precision security queries to let CodeQL evaluate them, but low-severity medium-precision findings are noise.

The filter reads from `$RAW_DIR/results.sarif` (unfiltered) and writes to `$RESULTS_DIR/results.sarif` (final). The raw file is preserved unmodified.

```bash
# Filter important-only results: drop medium-precision findings with security-severity < 6.0
# Medium-precision queries without a security-severity score default to 0.0 (excluded).
# Non-medium queries are always kept regardless of security-severity.
# Reads from raw/, writes to results/ — preserving the unfiltered original.
RAW_DIR="$OUTPUT_DIR/raw"
RESULTS_DIR="$OUTPUT_DIR/results"
jq '
  .runs[] |= (
    . as $run |
    .results = [
      .results[] |
      ($run.tool.driver.rules[.ruleIndex].properties.precision // "unknown") as $prec |
      ($run.tool.driver.rules[.ruleIndex].properties["security-severity"] // null) as $raw_sev |
      (if $prec == "medium" then ($raw_sev // "0" | tonumber) else 10 end) as $sev |
      select(
        ($prec == "high") or ($prec == "very-high") or ($prec == "unknown") or
        ($prec == "medium" and $sev >= 6.0)
      )
    ]
  )
' "$RAW_DIR/results.sarif" > "$RESULTS_DIR/results.sarif"
```

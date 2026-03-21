# SARIF jq Query Reference

Ready-to-use jq queries for common SARIF parsing tasks.

## Basic Exploration

```bash
# Pretty print
jq '.' results.sarif

# Get SARIF version
jq '.version' results.sarif

# List tool names from all runs
jq '.runs[].tool.driver.name' results.sarif

# Count runs
jq '.runs | length' results.sarif
```

## Result Queries

```bash
# Total result count
jq '[.runs[].results[]] | length' results.sarif

# Count by severity level
jq 'reduce .runs[].results[] as $r ({}; .[$r.level] += 1)' results.sarif

# List unique rule IDs
jq '[.runs[].results[].ruleId] | unique | sort' results.sarif

# Count per rule
jq '[.runs[].results[]] | group_by(.ruleId) | map({rule: .[0].ruleId, count: length}) | sort_by(-.count)' results.sarif
```

## Filtering Results

```bash
# Only errors
jq '.runs[].results[] | select(.level == "error")' results.sarif

# Only warnings
jq '.runs[].results[] | select(.level == "warning")' results.sarif

# By specific rule ID
jq --arg rule "SQL_INJECTION" '.runs[].results[] | select(.ruleId == $rule)' results.sarif

# By file path (contains)
jq --arg file "auth" '.runs[].results[] | select(.locations[].physicalLocation.artifactLocation.uri | contains($file))' results.sarif

# By file extension
jq '.runs[].results[] | select(.locations[].physicalLocation.artifactLocation.uri | test("\\.py$"))' results.sarif

# Multiple conditions
jq '.runs[].results[] | select(.level == "error" and (.ruleId | startswith("SEC")))' results.sarif
```

## Extracting Locations

```bash
# File and line for each result
jq '.runs[].results[] | {
  rule: .ruleId,
  file: .locations[0].physicalLocation.artifactLocation.uri,
  line: .locations[0].physicalLocation.region.startLine
}' results.sarif

# Unique affected files
jq '[.runs[].results[].locations[].physicalLocation.artifactLocation.uri] | unique | sort' results.sarif

# Results grouped by file
jq '[.runs[].results[] | {file: .locations[0].physicalLocation.artifactLocation.uri, result: .}] | group_by(.file) | map({file: .[0].file, count: length})' results.sarif
```

## Rule Information

```bash
# List all rules with severity
jq '.runs[].tool.driver.rules[] | {id: .id, name: .name, level: .defaultConfiguration.level}' results.sarif

# Get rule description by ID
jq --arg id "RULE001" '.runs[].tool.driver.rules[] | select(.id == $id)' results.sarif

# Rules with help URLs
jq '.runs[].tool.driver.rules[] | select(.helpUri) | {id: .id, help: .helpUri}' results.sarif
```

## Fingerprints

```bash
# Results with fingerprints
jq '.runs[].results[] | select(.fingerprints or .partialFingerprints) | {rule: .ruleId, fp: (.fingerprints // .partialFingerprints)}' results.sarif

# Extract all partial fingerprints
jq '[.runs[].results[].partialFingerprints] | add' results.sarif
```

## Aggregation and Reporting

```bash
# Summary by severity and rule
jq '[.runs[].results[]] | group_by(.level) | map({level: .[0].level, rules: (group_by(.ruleId) | map({rule: .[0].ruleId, count: length}))})' results.sarif

# Top 10 most frequent rules
jq '[.runs[].results[]] | group_by(.ruleId) | map({rule: .[0].ruleId, count: length}) | sort_by(-.count) | .[0:10]' results.sarif

# Files with most issues
jq '[.runs[].results[] | .locations[0].physicalLocation.artifactLocation.uri] | group_by(.) | map({file: .[0], count: length}) | sort_by(-.count) | .[0:10]' results.sarif
```

## Output Formatting

```bash
# CSV-like output
jq -r '.runs[].results[] | [.ruleId, .level, .locations[0].physicalLocation.artifactLocation.uri, .locations[0].physicalLocation.region.startLine, .message.text] | @csv' results.sarif

# Tab-separated
jq -r '.runs[].results[] | [.ruleId, .level, .locations[0].physicalLocation.artifactLocation.uri // "N/A"] | @tsv' results.sarif

# Markdown table
echo "| Rule | Level | File | Line |"
echo "|------|-------|------|------|"
jq -r '.runs[].results[] | "| \(.ruleId) | \(.level) | \(.locations[0].physicalLocation.artifactLocation.uri // "N/A") | \(.locations[0].physicalLocation.region.startLine // "N/A") |"' results.sarif
```

## Comparison and Diff

```bash
# Find rules in file1 not in file2
comm -23 <(jq -r '[.runs[].results[].ruleId] | unique | sort[]' file1.sarif) <(jq -r '[.runs[].results[].ruleId] | unique | sort[]' file2.sarif)

# Compare result counts
echo "File 1: $(jq '[.runs[].results[]] | length' file1.sarif)"
echo "File 2: $(jq '[.runs[].results[]] | length' file2.sarif)"
```

## Transformation

```bash
# Extract minimal SARIF (results only)
jq '{version: .version, runs: [.runs[] | {tool: {driver: {name: .tool.driver.name}}, results: .results}]}' results.sarif

# Filter and create new SARIF with only errors
jq '.runs[].results = [.runs[].results[] | select(.level == "error")]' results.sarif > errors-only.sarif

# Merge multiple SARIF files
jq -s '{version: "2.1.0", runs: [.[].runs[]]}' file1.sarif file2.sarif > merged.sarif
```

## Validation Checks

```bash
# Check if version is 2.1.0
jq -e '.version == "2.1.0"' results.sarif && echo "Valid version" || echo "Invalid version"

# Check for empty results
jq -e '[.runs[].results[]] | length > 0' results.sarif && echo "Has results" || echo "No results"

# Verify all results have locations
jq '[.runs[].results[] | select(.locations | length == 0)] | length' results.sarif
```

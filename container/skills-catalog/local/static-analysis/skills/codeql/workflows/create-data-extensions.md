# Create Data Extensions Workflow

Generate data extension YAML files to improve CodeQL's data flow coverage for project-specific APIs. Runs after database build and before analysis.

## Task System

Create these tasks on workflow start:

```
TaskCreate: "Check for existing data extensions" (Step 1)
TaskCreate: "Query known sources and sinks" (Step 2) - blockedBy: Step 1
TaskCreate: "Identify missing sources and sinks" (Step 3) - blockedBy: Step 2
TaskCreate: "Create data extension files" (Step 4) - blockedBy: Step 3
TaskCreate: "Validate with re-analysis" (Step 5) - blockedBy: Step 4
```

### Early Exit Points

| After Step | Condition | Action |
|------------|-----------|--------|
| Step 1 | Extensions already exist | Return found packs/files to run-analysis workflow, finish |
| Step 3 | No missing models identified | Report coverage is adequate, finish |

---

## Steps

### Step 1: Check for Existing Data Extensions

**Entry:** CodeQL database exists (`codeql resolve database` succeeds)
**Exit:** Either existing extensions found (report and finish) OR no extensions found (proceed to Step 2)

Search the project for existing data extensions and model packs.

```bash
# 1. In-repo model packs (exclude output dirs and legacy database dirs)
fd '(qlpack|codeql-pack)\.yml$' . --exclude 'static_analysis_codeql_*' --exclude 'codeql_*.db' | while read -r f; do
  if grep -q 'dataExtensions' "$f"; then
    echo "MODEL PACK: $(dirname "$f") - $(grep '^name:' "$f")"
  fi
done

# 2. Standalone data extension files
rg -l '^extensions:' --glob '*.yml' --glob '!static_analysis_codeql_*/**' --glob '!codeql_*.db/**' | head -20

# 3. Installed model packs
codeql resolve qlpacks 2>/dev/null | grep -iE 'model|extension'
```

**If any found:** Report to user and finish. These will be picked up by the run-analysis workflow.

**If none found:** Proceed to Step 2.

---

### Step 2: Query Known Sources and Sinks

**Entry:** Step 1 found no existing extensions; database and language identified
**Exit:** `sources.csv` and `sinks.csv` exist in `$DIAG_DIR` with enumerated source/sink locations

Run custom QL queries against the database to enumerate all sources and sinks CodeQL currently recognizes.

#### 2a: Select Database and Language

A CodeQL database is a directory containing a `codeql-database.yml` marker file. `$DB_NAME` may already be set by the parent skill. If not, discover inside `$OUTPUT_DIR`.

```bash
if [ -z "$DB_NAME" ]; then
  FOUND_DBS=()
  while IFS= read -r yml; do
    FOUND_DBS+=("$(dirname "$yml")")
  done < <(find "$OUTPUT_DIR" -maxdepth 2 -name "codeql-database.yml" 2>/dev/null)

  if [ ${#FOUND_DBS[@]} -eq 0 ]; then
    echo "ERROR: No CodeQL database found in $OUTPUT_DIR"; exit 1
  elif [ ${#FOUND_DBS[@]} -eq 1 ]; then
    DB_NAME="${FOUND_DBS[0]}"
  else
    # Multiple databases — use AskUserQuestion to select
    # SKIP if user already specified which database in their prompt
  fi
fi

CODEQL_LANG=$(codeql resolve database --format=json -- "$DB_NAME" | jq -r '.languages[0]')
DIAG_DIR="$OUTPUT_DIR/diagnostics"
mkdir -p "$DIAG_DIR"
```

#### 2b: Write Source Enumeration Query

Use the `Write` tool to create `$DIAG_DIR/list-sources.ql` using the source template from [diagnostic-query-templates.md](../references/diagnostic-query-templates.md#source-enumeration-query). Pick the correct import block for `$CODEQL_LANG`.

#### 2c: Write Sink Enumeration Query

Use the `Write` tool to create `$DIAG_DIR/list-sinks.ql` using the language-specific sink template from [diagnostic-query-templates.md](../references/diagnostic-query-templates.md#sink-enumeration-queries).

**For Java:** Also create `$DIAG_DIR/qlpack.yml` with a `codeql/java-all` dependency and run `codeql pack install` before executing queries.

#### 2d: Run Queries

```bash
codeql query run --database="$DB_NAME" --output="$DIAG_DIR/sources.bqrs" -- "$DIAG_DIR/list-sources.ql"
codeql bqrs decode --format=csv --output="$DIAG_DIR/sources.csv" -- "$DIAG_DIR/sources.bqrs"

codeql query run --database="$DB_NAME" --output="$DIAG_DIR/sinks.bqrs" -- "$DIAG_DIR/list-sinks.ql"
codeql bqrs decode --format=csv --output="$DIAG_DIR/sinks.csv" -- "$DIAG_DIR/sinks.bqrs"
```

#### 2e: Summarize Results

Read both CSV files and present a summary showing source types and sink kinds with counts.

---

### Step 3: Identify Missing Sources and Sinks

**Entry:** Step 2 complete (`sources.csv` and `sinks.csv` available)
**Exit:** Either no gaps found (report adequate coverage and finish) OR user confirms which gaps to model (proceed to Step 4)

Cross-reference the project's API surface against CodeQL's known models.

#### 3a: Map the Project's API Surface

Read source code to identify security-relevant patterns:

| Pattern | What To Find | Likely Model Type |
|---------|-------------|-------------------|
| HTTP/request handlers | Custom request parsing | `sourceModel` (kind: `remote`) |
| Database layers | Custom ORM, raw query wrappers | `sinkModel` (kind: `sql-injection`) |
| Command execution | Shell wrappers, process spawners | `sinkModel` (kind: `command-injection`) |
| File operations | Custom file read/write | `sinkModel` (kind: `path-injection`) |
| Template rendering | HTML output, response builders | `sinkModel` (kind: `xss`) |
| Deserialization | Custom deserializers | `sinkModel` (kind: `unsafe-deserialization`) |
| HTTP clients | URL construction | `sinkModel` (kind: `ssrf`) |
| Sanitizers | Input validation, escaping | `neutralModel` |
| Pass-through wrappers | Logging, caching, encoding | `summaryModel` (kind: `taint`) |

Use `Grep` to search for these patterns in source code (adapt per language).

#### 3b: Cross-Reference Against Known Sources and Sinks

For each API pattern found, check if it appears in `sources.csv` or `sinks.csv` from Step 2.

**An API is "missing" if:**
- It handles user input but does not appear in `sources.csv`
- It performs a dangerous operation but does not appear in `sinks.csv`
- It wraps tainted data but has no summary model

#### 3c: Report Gaps

Present findings and use `AskUserQuestion`:

```
header: "Extensions"
question: "Create data extension files for the identified gaps?"
options:
  - label: "Create all (Recommended)"
    description: "Generate extensions for all identified gaps"
  - label: "Select individually"
    description: "Choose which gaps to model"
  - label: "Skip"
    description: "No extensions needed, proceed to analysis"
```

---

### Step 4: Create Data Extension Files

**Entry:** Step 3 identified gaps and user confirmed which to model
**Exit:** YAML extension files created in `$OUTPUT_DIR/extensions/` and deployed to `<lang>-all` ext/ directory

Generate YAML data extension files for the gaps confirmed by the user.

#### File Structure

Create files in `$OUTPUT_DIR/extensions/`:

```
$OUTPUT_DIR/extensions/
  sources.yml       # sourceModel entries
  sinks.yml         # sinkModel entries
  summaries.yml     # summaryModel and neutralModel entries
```

#### YAML Format and Deployment

See [extension-yaml-format.md](../references/extension-yaml-format.md) for column definitions, per-language examples (Python, Java, JS, Go, C/C++), and the deployment workaround for pre-compiled query packs.

Use the `Write` tool to create each file. Only create files that have entries — skip empty categories.

---

### Step 5: Validate with Re-Analysis

**Entry:** Step 4 complete (extension files deployed)
**Exit:** Finding delta measured (with-extensions count >= baseline count); extensions validated as loading correctly

Run a full security analysis with and without extensions to measure the finding delta.

#### 5a: Run Baseline Analysis (without extensions)

Validation artifacts go in `$DIAG_DIR` (not `results/`) since these are intermediate comparisons, not the final analysis output.

```bash
codeql database analyze "$DB_NAME" \
  --format=sarif-latest --output="$DIAG_DIR/baseline.sarif" --threads=0 \
  -- codeql/<lang>-queries:codeql-suites/<lang>-security-extended.qls
```

#### 5b: Run Analysis with Extensions

```bash
codeql database cleanup "$DB_NAME"
codeql database analyze "$DB_NAME" \
  --format=sarif-latest --output="$DIAG_DIR/with-extensions.sarif" --threads=0 --rerun \
  -- codeql/<lang>-queries:codeql-suites/<lang>-security-extended.qls
```

Use `-vvv` flag to verify extensions are being loaded.

#### 5c: Compare Findings

```bash
BASELINE=$(python3 -c "import json; print(sum(len(r.get('results',[])) for r in json.load(open('$DIAG_DIR/baseline.sarif')).get('runs',[])))")
WITH_EXT=$(python3 -c "import json; print(sum(len(r.get('results',[])) for r in json.load(open('$DIAG_DIR/with-extensions.sarif')).get('runs',[])))")
echo "Findings: $BASELINE → $WITH_EXT (+$((WITH_EXT - BASELINE)))"
```

**If counts did not increase:** Check extension loading (`-vvv`), pre-compiled pack workaround, Java `True`/`False` capitalization, column value accuracy.

---

## Final Output

```
## Data Extensions Created

**Output directory:** $OUTPUT_DIR
**Database:** $DB_NAME
**Language:** <LANG>

### Files Created:
- $OUTPUT_DIR/extensions/sources.yml — <N> source models
- $OUTPUT_DIR/extensions/sinks.yml — <N> sink models
- $OUTPUT_DIR/extensions/summaries.yml — <N> summary/neutral models

### Model Coverage:
- Sources: <BEFORE> → <AFTER> (+<DELTA>)
- Sinks: <BEFORE> → <AFTER> (+<DELTA>)

### Usage:
Extensions deployed to `<lang>-all` ext/ directory (auto-loaded).
Source files in `$OUTPUT_DIR/extensions/` for version control.
Run the run-analysis workflow to use them.
```

## References

- [Threat models reference](../references/threat-models.md) — control which source categories are active during analysis
- [CodeQL data extensions](https://codeql.github.com/docs/codeql-cli/using-custom-queries-with-the-codeql-cli/#using-extension-packs)
- [Customizing library models](https://codeql.github.com/docs/codeql-language-guides/customizing-library-models-for-python/)

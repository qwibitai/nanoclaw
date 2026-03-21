# Build Database Workflow

Create high-quality CodeQL databases by trying build methods in sequence until one produces good results.

## Task System

Create these tasks on workflow start:

```
TaskCreate: "Detect language and configure" (Step 1)
TaskCreate: "Build database" (Step 2) - blockedBy: Step 1
TaskCreate: "Apply fixes if needed" (Step 3) - blockedBy: Step 2
TaskCreate: "Assess quality" (Step 4) - blockedBy: Step 3
TaskCreate: "Improve quality if needed" (Step 5) - blockedBy: Step 4
TaskCreate: "Generate final report" (Step 6) - blockedBy: Step 5
```

---

## Overview

Database creation differs by language type:

### Interpreted Languages (Python, JavaScript, Go, Ruby)
- **No build required** — CodeQL extracts source directly
- **Exclusion config supported** — Use `--codescanning-config` to skip irrelevant files

### Compiled Languages (C/C++, Java, C#, Rust, Swift)
- **Build required** — CodeQL must trace the compilation
- **Exclusion config NOT supported** — All compiled code must be traced
- Try build methods in order until one succeeds:
  1. **Autobuild** — CodeQL auto-detects and runs the build
  2. **Custom Command** — Explicit build command for the detected build system
  2m. **macOS arm64 Toolchain** — Homebrew compiler + multi-step tracing (Apple Silicon workaround)
  3. **Multi-step** — Fine-grained control with init → trace-command → finalize
  4. **No-build fallback** — `--build-mode=none` (partial analysis, last resort)

> **macOS Apple Silicon:** On arm64 Macs, system tools (`/usr/bin/make`, `/usr/bin/clang`, `/usr/bin/ar`) are `arm64e` but CodeQL's `libtrace.dylib` only has `arm64`. macOS kills `arm64e` processes with a non-`arm64e` injected dylib (SIGKILL, exit 137). Step 2a detects this and routes to Method 2m.

---

## Output Directory

This workflow receives `$OUTPUT_DIR` from the parent skill (resolved once at invocation). All files go inside it.

```bash
DB_NAME="$OUTPUT_DIR/codeql.db"
```

---

## Build Log

Maintain a log file throughout. Initialize at start:

```bash
LOG_FILE="$OUTPUT_DIR/build.log"
echo "=== CodeQL Database Build Log ===" > "$LOG_FILE"
echo "Started: $(date -Iseconds)" >> "$LOG_FILE"
echo "Output dir: $OUTPUT_DIR" >> "$LOG_FILE"
echo "Database: $DB_NAME" >> "$LOG_FILE"
```

Log helper:
```bash
log_step()   { echo "[$(date -Iseconds)] $1" >> "$LOG_FILE"; }
log_cmd()    { echo "[$(date -Iseconds)] COMMAND: $1" >> "$LOG_FILE"; }
log_result() { echo "[$(date -Iseconds)] RESULT: $1" >> "$LOG_FILE"; echo "" >> "$LOG_FILE"; }
```

**What to log:** Detected language/build system, each build attempt with exact command, fix attempts and outcomes, quality assessment results, final successful command.

---

## Step 1: Detect Language and Configure

**Entry:** CodeQL CLI installed and on PATH (`codeql --version` succeeds)
**Exit:** `CODEQL_LANG` variable set to a valid CodeQL language identifier; exclusion config created (interpreted) or skipped (compiled)

### 1a. Detect Language

```bash
fd -t f -e py -e js -e ts -e go -e rb -e java -e c -e cpp -e h -e hpp -e rs -e cs | \
  sed 's/.*\.//' | sort | uniq -c | sort -rn | head -5
ls -la Makefile CMakeLists.txt build.gradle pom.xml Cargo.toml *.sln 2>/dev/null || true
```

| Language | `--language=` | Type |
|----------|---------------|------|
| Python | `python` | Interpreted |
| JavaScript/TypeScript | `javascript` | Interpreted |
| Go | `go` | Interpreted |
| Ruby | `ruby` | Interpreted |
| Java/Kotlin | `java` | Compiled |
| C/C++ | `cpp` | Compiled |
| C# | `csharp` | Compiled |
| Rust | `rust` | Compiled |
| Swift | `swift` | Compiled (macOS) |

### 1b. Create Exclusion Config (Interpreted Languages Only)

> **Skip for compiled languages** — exclusion config is not supported when build tracing is required.

Scan for irrelevant directories and create `$OUTPUT_DIR/codeql-config.yml` with `paths-ignore` entries for `node_modules`, `vendor`, `venv`, third-party code, and generated/minified files.

---

## Step 2: Build Database

**Entry:** Step 1 complete (`CODEQL_LANG` set, `DB_NAME` assigned, log file initialized)
**Exit:** `codeql resolve database -- "$DB_NAME"` succeeds (database exists and is valid)

### For Interpreted Languages

```bash
log_step "Building database for interpreted language: <LANG>"
CMD="codeql database create $DB_NAME --language=$CODEQL_LANG --source-root=. --codescanning-config=$OUTPUT_DIR/codeql-config.yml --overwrite"
log_cmd "$CMD"
$CMD 2>&1 | tee -a "$LOG_FILE"
```

**Skip to Step 4 after success.**

---

### For Compiled Languages

#### Step 2a: macOS arm64e Detection (C/C++ primarily)

```bash
IS_MACOS_ARM64E=false
if [[ "$(uname -s)" == "Darwin" ]] && [[ "$(uname -m)" == "arm64" ]]; then
  LIBTRACE=$(find "$(dirname "$(command -v codeql)")" -name libtrace.dylib 2>/dev/null | head -1)
  if [ -n "$LIBTRACE" ]; then
    LIBTRACE_ARCHS=$(lipo -archs "$LIBTRACE" 2>/dev/null)
    if [[ "$LIBTRACE_ARCHS" != *"arm64e"* ]]; then
      MAKE_ARCHS=$(lipo -archs /usr/bin/make 2>/dev/null)
      [[ "$MAKE_ARCHS" == *"arm64e"* ]] && IS_MACOS_ARM64E=true
    fi
  fi
fi
```

**If `IS_MACOS_ARM64E=true`:** Skip Methods 1 and 2 — go directly to Method 2m.

---

Try build methods in sequence until one succeeds:

#### Method 1: Autobuild

> **Skip if `IS_MACOS_ARM64E=true`.**

```bash
log_step "METHOD 1: Autobuild"
CMD="codeql database create $DB_NAME --language=$CODEQL_LANG --source-root=. --overwrite"
log_cmd "$CMD"
$CMD 2>&1 | tee -a "$LOG_FILE"
```

#### Method 2: Custom Command

> **Skip if `IS_MACOS_ARM64E=true`.**

Detect build system and use explicit command:

| Build System | Detection | Command |
|--------------|-----------|---------|
| Make | `Makefile` | `make clean && make -j$(nproc)` |
| CMake | `CMakeLists.txt` | `cmake -B build && cmake --build build` |
| Gradle | `build.gradle` | `./gradlew clean build -x test` |
| Maven | `pom.xml` | `mvn clean compile -DskipTests` |
| Cargo | `Cargo.toml` | `cargo clean && cargo build` |
| .NET | `*.sln` | `dotnet clean && dotnet build` |

Also check for project-specific build scripts (`build.sh`, `compile.sh`) and README instructions.

```bash
log_step "METHOD 2: Custom command"
CMD="codeql database create $DB_NAME --language=$CODEQL_LANG --source-root=. --command='$BUILD_CMD' --overwrite"
log_cmd "$CMD"
$CMD 2>&1 | tee -a "$LOG_FILE"
```

#### Method 2m: macOS arm64 Toolchain (Apple Silicon workaround)

> **Use when `IS_MACOS_ARM64E=true`.** Replaces Methods 1 and 2 on affected systems.

See [macos-arm64e-workaround.md](../references/macos-arm64e-workaround.md) for the full sub-method sequence (2m-a through 2m-d): Homebrew compiler with multi-step tracing → Rosetta x86_64 → system compiler verification → ask user.

#### Method 3: Multi-step Build

For complex builds needing fine-grained control:

> **On macOS with `IS_MACOS_ARM64E=true`:** Only trace arm64 Homebrew binaries. Do NOT trace system tools.

```bash
log_step "METHOD 3: Multi-step build"
codeql database init $DB_NAME --language=$CODEQL_LANG --source-root=. --overwrite
codeql database trace-command $DB_NAME -- <build step 1>
codeql database trace-command $DB_NAME -- <build step 2>
codeql database finalize $DB_NAME
```

#### Method 4: No-Build Fallback (Last Resort)

> **WARNING:** Creates a database without build tracing. Only source-level patterns detected.

```bash
log_step "METHOD 4: No-build fallback (partial analysis)"
CMD="codeql database create $DB_NAME --language=$CODEQL_LANG --source-root=. --build-mode=none --overwrite"
log_cmd "$CMD"
$CMD 2>&1 | tee -a "$LOG_FILE"
```

---

## Step 3: Apply Fixes (if build failed)

**Entry:** Step 2 build method failed (non-zero exit or `codeql resolve database` fails)
**Exit:** Fix applied and current build method retried; either succeeds (go to Step 4) or all fixes exhausted (try next build method in Step 2)

Try fixes in order, then retry current build method. See [build-fixes.md](../references/build-fixes.md) for the full fix catalog: clean state, clean build cache, install dependencies, handle private registries.

---

## Steps 4-5: Assess and Improve Quality

**Entry:** Database exists and `codeql resolve database` succeeds
**Exit (Step 4):** Quality metrics collected (baseline LoC, file counts, extractor errors, finalization status)
**Exit (Step 5):** Quality is GOOD (baseline LoC > 0, errors < 5%, project files present) OR user accepts current state

Run quality checks and compare against expected source files. See [quality-assessment.md](../references/quality-assessment.md) for metric collection, quality criteria table, and improvement steps.

---

## Exit Conditions

**Success:** Quality assessment shows GOOD or user accepts current state.

**Failure (all methods exhausted):**
```
AskUserQuestion: "All build methods failed. Options:"
  1. "Accept current state" (if any database exists)
  2. "I'll fix the build manually and retry"
  3. "Abort"
```

---

## Final Report

```bash
echo "=== Build Complete ===" >> "$LOG_FILE"
echo "Finished: $(date -Iseconds)" >> "$LOG_FILE"
echo "Final database: $DB_NAME" >> "$LOG_FILE"
echo "Successful method: <METHOD>" >> "$LOG_FILE"
codeql resolve database -- "$DB_NAME" >> "$LOG_FILE" 2>&1
```

Report to user:
```
## Database Build Complete

**Output directory:** $OUTPUT_DIR
**Database:** $DB_NAME
**Language:** <LANG>
**Build method:** autobuild | custom | multi-step
**Files extracted:** <COUNT>

### Quality:
- Errors: <N>
- Coverage: <good/partial/poor>

### Build Log:
See `$OUTPUT_DIR/build.log` for complete details.

**Final command used:** <EXACT_COMMAND>
**Ready for analysis.**
```

# macOS arm64e Workaround

Methods for building CodeQL databases on macOS Apple Silicon when the `arm64e`/`arm64` architecture mismatch causes SIGKILL (exit code 137) during build tracing.

**Use when `IS_MACOS_ARM64E=true`** (detected in build-database workflow Step 2a). These replace Methods 1 and 2 on affected systems.

The strategy is to use Homebrew-installed tools (plain `arm64`, not `arm64e`) so `libtrace.dylib` can be injected successfully. Try sub-methods in order:

## Sub-method 2m-a: Homebrew clang/gcc with multi-step tracing

Trace only the compiler invocations individually, avoiding system tools (`/usr/bin/ar`, `/bin/mkdir`) that would be killed. This requires a multi-step build: init → trace each compiler call → finalize.

```bash
log_step "METHOD 2m-a: macOS arm64 — Homebrew compiler with multi-step tracing"

# 1. Find Homebrew C/C++ compiler (arm64, not arm64e)
BREW_CC=""
# Prefer Homebrew clang
if [ -x "/opt/homebrew/opt/llvm/bin/clang" ]; then
  BREW_CC="/opt/homebrew/opt/llvm/bin/clang"
# Try Homebrew GCC (e.g. gcc-14, gcc-13)
elif command -v gcc-14 >/dev/null 2>&1; then
  BREW_CC="$(command -v gcc-14)"
elif command -v gcc-13 >/dev/null 2>&1; then
  BREW_CC="$(command -v gcc-13)"
fi

if [ -z "$BREW_CC" ]; then
  log_result "No Homebrew C/C++ compiler found — skipping 2m-a"
  # Fall through to 2m-b
else
  # Verify it's arm64 (not arm64e)
  BREW_CC_ARCH=$(lipo -archs "$BREW_CC" 2>/dev/null)
  if [[ "$BREW_CC_ARCH" == *"arm64e"* ]]; then
    log_result "Homebrew compiler is arm64e — skipping 2m-a"
  else
    log_step "Using Homebrew compiler: $BREW_CC (arch: $BREW_CC_ARCH)"

    # 2. Run the build normally (without tracing) to create build dirs and artifacts
    #    Use Homebrew make (gmake) if available, otherwise system make outside tracer
    if command -v gmake >/dev/null 2>&1; then
      MAKE_CMD="gmake"
    else
      MAKE_CMD="make"
    fi
    $MAKE_CMD clean 2>/dev/null || true
    $MAKE_CMD CC="$BREW_CC" 2>&1 | tee -a "$LOG_FILE"

    # 3. Extract compiler commands from the Makefile / build system
    #    Use make's dry-run mode to get the exact compiler invocations
    $MAKE_CMD clean 2>/dev/null || true
    COMPILE_CMDS=$($MAKE_CMD CC="$BREW_CC" --dry-run 2>/dev/null \
      | grep -E "^\s*$BREW_CC\b.*\s-c\s" \
      | sed 's/^[[:space:]]*//')

    if [ -z "$COMPILE_CMDS" ]; then
      log_result "Could not extract compile commands from dry-run — skipping 2m-a"
    else
      # 4. Init database
      codeql database init $DB_NAME --language=cpp --source-root=. --overwrite 2>&1 \
        | tee -a "$LOG_FILE"

      # 5. Ensure build directories exist (outside tracer — avoids arm64e mkdir)
      $MAKE_CMD clean 2>/dev/null || true
      #    Parse -o flags to find output dirs, or just create common dirs
      echo "$COMPILE_CMDS" | sed -n 's/.*-o[[:space:]]\{1,\}\([^[:space:]]\{1,\}\).*/\1/p' | xargs -I{} dirname {} \
        | sort -u | xargs mkdir -p 2>/dev/null || true

      # 6. Trace each compiler invocation individually
      TRACE_OK=true
      while IFS= read -r cmd; do
        [ -z "$cmd" ] && continue
        log_cmd "codeql database trace-command $DB_NAME -- $cmd"
        if ! codeql database trace-command $DB_NAME -- $cmd 2>&1 | tee -a "$LOG_FILE"; then
          log_result "FAILED on: $cmd"
          TRACE_OK=false
          break
        fi
      done <<< "$COMPILE_CMDS"

      if $TRACE_OK; then
        # 7. Finalize
        codeql database finalize $DB_NAME 2>&1 | tee -a "$LOG_FILE"
        if codeql resolve database -- "$DB_NAME" >/dev/null 2>&1; then
          log_result "SUCCESS (macOS arm64 multi-step)"
          # Done — skip to Step 4
        else
          log_result "FAILED (finalize failed)"
        fi
      fi
    fi
  fi
fi
```

## Sub-method 2m-b: Rosetta x86_64 emulation

Force the entire CodeQL pipeline to run under Rosetta, which uses the `x86_64` slice of both `libtrace.dylib` and system tools — no `arm64e` mismatch.

```bash
log_step "METHOD 2m-b: macOS arm64 — Rosetta x86_64 emulation"

# Check if Rosetta is available
if ! arch -x86_64 /usr/bin/true 2>/dev/null; then
  log_result "Rosetta not available — skipping 2m-b"
else
  BUILD_CMD="<BUILD_CMD>"  # e.g. "make clean && make -j4"
  CMD="arch -x86_64 codeql database create $DB_NAME --language=$CODEQL_LANG --source-root=. --command='$BUILD_CMD' --overwrite"
  log_cmd "$CMD"

  arch -x86_64 codeql database create $DB_NAME --language=$CODEQL_LANG --source-root=. \
    --command="$BUILD_CMD" --overwrite 2>&1 | tee -a "$LOG_FILE"

  if codeql resolve database -- "$DB_NAME" >/dev/null 2>&1; then
    log_result "SUCCESS (Rosetta x86_64)"
  else
    log_result "FAILED (Rosetta)"
  fi
fi
```

## Sub-method 2m-c: System compiler (direct attempt)

As a verification step, try the standard autobuild with the system compiler. This will likely fail with exit code 137 on affected systems, but confirms the arm64e issue is the cause.

> **This sub-method is optional.** Skip it if arm64e incompatibility was already confirmed in Step 2a.

```bash
log_step "METHOD 2m-c: System compiler (expected to fail on arm64e)"
CMD="codeql database create $DB_NAME --language=$CODEQL_LANG --source-root=. --overwrite"
log_cmd "$CMD"

$CMD 2>&1 | tee -a "$LOG_FILE"

EXIT_CODE=$?
if [ $EXIT_CODE -eq 137 ] || [ $EXIT_CODE -eq 134 ]; then
  log_result "FAILED: exit code $EXIT_CODE confirms arm64e/libtrace incompatibility"
elif codeql resolve database -- "$DB_NAME" >/dev/null 2>&1; then
  log_result "SUCCESS (unexpected — system compiler worked)"
else
  log_result "FAILED (exit code: $EXIT_CODE)"
fi
```

## Sub-method 2m-d: Ask user

If all macOS workarounds fail, present options:

```
AskUserQuestion:
  header: "macOS Build"
  question: "Build tracing failed due to macOS arm64e incompatibility. How to proceed?"
  multiSelect: false
  options:
    - label: "Use build-mode=none (Recommended)"
      description: "Source-level analysis only. Misses some interprocedural data flow but catches most C/C++ vulnerabilities (format strings, buffer overflows, unsafe functions)."
    - label: "Install arm64 tools and retry"
      description: "Run: brew install llvm make — then retry with Homebrew toolchain"
    - label: "Install Rosetta and retry"
      description: "Run: softwareupdate --install-rosetta — then retry under x86_64 emulation"
    - label: "Abort"
      description: "Stop database creation"
```

**If "Use build-mode=none":** Proceed to Method 4.

**If "Install arm64 tools and retry":**
```bash
log_step "Installing Homebrew arm64 toolchain"
brew install llvm make 2>&1 | tee -a "$LOG_FILE"
# Retry Sub-method 2m-a
```

**If "Install Rosetta and retry":**
```bash
log_step "Installing Rosetta"
softwareupdate --install-rosetta --agree-to-license 2>&1 | tee -a "$LOG_FILE"
# Retry Sub-method 2m-b
```

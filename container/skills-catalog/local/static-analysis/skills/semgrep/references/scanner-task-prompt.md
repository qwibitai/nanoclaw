# Scanner Subagent Task Prompt

Use this prompt template when spawning scanner Tasks in Step 4. Use `subagent_type: static-analysis:semgrep-scanner`.

## Template

```
You are a Semgrep scanner for [LANGUAGE_CATEGORY].

## Task
Run Semgrep scans for [LANGUAGE] files and save results to [OUTPUT_DIR]/raw.

## Pro Engine Status: [PRO_AVAILABLE: true/false]

## Scan Mode: [SCAN_MODE: run-all/important-only]

## APPROVED RULESETS (from user-confirmed plan)
[LIST EXACT RULESETS USER APPROVED - DO NOT SUBSTITUTE]

Example:
- p/python
- p/django
- p/security-audit
- p/secrets
- https://github.com/trailofbits/semgrep-rules

## Commands to Run (in parallel)

### Clone GitHub URL rulesets first:
```bash
mkdir -p [OUTPUT_DIR]/repos
# For each GitHub URL ruleset, clone into [OUTPUT_DIR]/repos/[name]:
git clone --depth 1 https://github.com/org/repo [OUTPUT_DIR]/repos/repo-name
```

### Generate commands for EACH approved ruleset:
```bash
semgrep [--pro if available] --metrics=off [SEVERITY_FLAGS] [INCLUDE_FLAGS] --config [RULESET] --json -o [OUTPUT_DIR]/raw/[lang]-[ruleset].json --sarif-output=[OUTPUT_DIR]/raw/[lang]-[ruleset].sarif [TARGET] &
```

Wait for all to complete:
```bash
wait
```

### Clean up cloned repos:
```bash
[ -n "[OUTPUT_DIR]" ] && rm -rf [OUTPUT_DIR]/repos
```

## Critical Rules
- Use ONLY the rulesets listed above - do not add or remove any
- Always use --metrics=off (prevents sending telemetry to Semgrep servers)
- Use --pro when Pro is available (enables cross-file taint tracking)
- If scan mode is **important-only**, add `--severity MEDIUM --severity HIGH --severity CRITICAL` to every command
- If scan mode is **run-all**, do NOT add severity flags
- Run all rulesets in parallel with & and wait
- For GitHub URL rulesets, always clone into [OUTPUT_DIR]/repos/ and use the local path as --config (do NOT pass URLs directly to semgrep — its URL handling is unreliable for repos with non-standard YAML)
- Add `--include` flags for language-specific rulesets (e.g., `--include="*.py"` for p/python). Do NOT add `--include` to cross-language rulesets like p/security-audit, p/secrets, or third-party repos
- After all scans complete, delete [OUTPUT_DIR]/repos/ to avoid leaving cloned repos behind

## Output
Report:
- Number of findings per ruleset
- Any scan errors
- File paths of JSON results (in [OUTPUT_DIR]/raw/)
- [If Pro] Note any cross-file findings detected
```

## Variable Substitutions

| Variable | Description | Example |
|----------|-------------|---------|
| `[LANGUAGE_CATEGORY]` | Language group being scanned | Python, JavaScript, Docker |
| `[LANGUAGE]` | Specific language | Python, TypeScript, Go |
| `[OUTPUT_DIR]` | Output directory (absolute path, resolved in Step 1) | /path/to/static_analysis_semgrep_1 |
| `[PRO_AVAILABLE]` | Whether Pro engine is available | true, false |
| `[SEVERITY_FLAGS]` | Severity pre-filter flags | *(empty)* for run-all, `--severity MEDIUM --severity HIGH --severity CRITICAL` for important-only |
| `[INCLUDE_FLAGS]` | File extension filter for language-specific rulesets | `--include="*.py"` for Python rulesets, *(empty)* for cross-language rulesets like p/security-audit, p/secrets, or third-party repos |
| `[RULESET]` | Semgrep ruleset identifier or local clone path | p/python, [OUTPUT_DIR]/repos/semgrep-rules |
| `[TARGET]` | Absolute path to directory to scan | /path/to/codebase |

## Example: Python Scanner Task

```
You are a Semgrep scanner for Python.

## Task
Run Semgrep scans for Python files and save results to /path/to/static_analysis_semgrep_1/raw.

## Pro Engine Status: true

## Scan Mode: run-all

## APPROVED RULESETS (from user-confirmed plan)
- p/python
- p/django
- p/security-audit
- p/secrets
- https://github.com/trailofbits/semgrep-rules

## Commands to Run (in parallel)

### Clone GitHub URL rulesets first:
```bash
mkdir -p /path/to/static_analysis_semgrep_1/repos
git clone --depth 1 https://github.com/trailofbits/semgrep-rules /path/to/static_analysis_semgrep_1/repos/trailofbits
```

### Run scans:
```bash
semgrep --pro --metrics=off --include="*.py" --config p/python --json -o /path/to/static_analysis_semgrep_1/raw/python-python.json --sarif-output=/path/to/static_analysis_semgrep_1/raw/python-python.sarif /path/to/codebase &
semgrep --pro --metrics=off --include="*.py" --config p/django --json -o /path/to/static_analysis_semgrep_1/raw/python-django.json --sarif-output=/path/to/static_analysis_semgrep_1/raw/python-django.sarif /path/to/codebase &
semgrep --pro --metrics=off --config p/security-audit --json -o /path/to/static_analysis_semgrep_1/raw/python-security-audit.json --sarif-output=/path/to/static_analysis_semgrep_1/raw/python-security-audit.sarif /path/to/codebase &
semgrep --pro --metrics=off --config p/secrets --json -o /path/to/static_analysis_semgrep_1/raw/python-secrets.json --sarif-output=/path/to/static_analysis_semgrep_1/raw/python-secrets.sarif /path/to/codebase &
semgrep --pro --metrics=off --config /path/to/static_analysis_semgrep_1/repos/trailofbits --json -o /path/to/static_analysis_semgrep_1/raw/python-trailofbits.json --sarif-output=/path/to/static_analysis_semgrep_1/raw/python-trailofbits.sarif /path/to/codebase &
wait
```

### Clean up cloned repos:
```bash
rm -rf /path/to/static_analysis_semgrep_1/repos
```

## Critical Rules
- Use ONLY the rulesets listed above - do not add or remove any
- Always use --metrics=off
- Use --pro when Pro is available
- Run all rulesets in parallel with & and wait
- Clone GitHub URL rulesets into the output dir repos/ subfolder, use local path as --config
- Add --include="*.py" to language-specific rulesets (p/python, p/django) but NOT to p/security-audit, p/secrets, or third-party repos
- Delete repos/ after scanning

## Output
Report:
- Number of findings per ruleset
- Any scan errors
- File paths of JSON results (in raw/ subdirectory)
- Note any cross-file findings detected
```

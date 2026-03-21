# Data Extension YAML Format

YAML format for CodeQL data extension files. Used by the create-data-extensions workflow to model project-specific sources, sinks, and flow summaries.

## Structure

All extension files follow this structure:

```yaml
extensions:
  - addsTo:
      pack: codeql/<language>-all  # Target library pack
      extensible: <model-type>      # sourceModel, sinkModel, summaryModel, neutralModel
    data:
      - [<columns>]
```

## Source Models

Columns: `[package, type, subtypes, name, signature, ext, output, kind, provenance]`

| Column | Description | Example |
|--------|-------------|---------|
| package | Module/package path | `myapp.auth` |
| type | Class or module name | `AuthManager` |
| subtypes | Include subclasses | `True` (Java: capitalized) / `true` (Python/JS/Go) |
| name | Method name | `get_token` |
| signature | Method signature (optional) | `""` (Python/JS), `"(String,int)"` (Java) |
| ext | Extension (optional) | `""` |
| output | What is tainted | `ReturnValue`, `Parameter[0]` (Java) / `Argument[0]` (Python/JS/Go) |
| kind | Source category | `remote`, `local`, `file`, `environment`, `database` |
| provenance | How model was created | `manual` |

**Java-specific format differences:**
- **subtypes**: Use `True` / `False` (capitalized, Python-style), not `true` / `false`
- **output for parameters**: Use `Parameter[N]` (not `Argument[N]`) to mark method parameters as sources
- **signature**: Required for disambiguation — use Java type syntax: `"(String)"`, `"(String,int)"`
- **Parameter ranges**: Use `Parameter[0..2]` to mark multiple consecutive parameters

Example (Python):

```yaml
# $OUTPUT_DIR/extensions/sources.yml
extensions:
  - addsTo:
      pack: codeql/python-all
      extensible: sourceModel
    data:
      - ["myapp.http", "Request", true, "get_param", "", "", "ReturnValue", "remote", "manual"]
      - ["myapp.http", "Request", true, "get_header", "", "", "ReturnValue", "remote", "manual"]
```

Example (Java — note `True`, `Parameter[N]`, and signature):

```yaml
# $OUTPUT_DIR/extensions/sources.yml
extensions:
  - addsTo:
      pack: codeql/java-all
      extensible: sourceModel
    data:
      - ["com.myapp.controller", "ApiController", True, "search", "(String)", "", "Parameter[0]", "remote", "manual"]
      - ["com.myapp.service", "FileService", True, "upload", "(String,String)", "", "Parameter[0..1]", "remote", "manual"]
```

## Sink Models

Columns: `[package, type, subtypes, name, signature, ext, input, kind, provenance]`

Note: column 7 is `input` (which argument receives tainted data), not `output`.

| Kind | Vulnerability |
|------|---------------|
| `sql-injection` | SQL injection |
| `command-injection` | Command injection |
| `path-injection` | Path traversal |
| `xss` | Cross-site scripting |
| `code-injection` | Code injection |
| `ssrf` | Server-side request forgery |
| `unsafe-deserialization` | Insecure deserialization |

Example (Python):

```yaml
# $OUTPUT_DIR/extensions/sinks.yml
extensions:
  - addsTo:
      pack: codeql/python-all
      extensible: sinkModel
    data:
      - ["myapp.db", "Connection", true, "raw_query", "", "", "Argument[0]", "sql-injection", "manual"]
      - ["myapp.shell", "Runner", false, "execute", "", "", "Argument[0]", "command-injection", "manual"]
```

Example (Java — note `True` and `Argument[N]` for sink input):

```yaml
extensions:
  - addsTo:
      pack: codeql/java-all
      extensible: sinkModel
    data:
      - ["com.myapp.db", "QueryRunner", True, "execute", "(String)", "", "Argument[0]", "sql-injection", "manual"]
```

## Summary Models

Columns: `[package, type, subtypes, name, signature, ext, input, output, kind, provenance]`

| Kind | Description |
|------|-------------|
| `taint` | Data flows through, still tainted |
| `value` | Data flows through, exact value preserved |

Example:

```yaml
# $OUTPUT_DIR/extensions/summaries.yml
extensions:
  # Pass-through: taint propagates
  - addsTo:
      pack: codeql/python-all
      extensible: summaryModel
    data:
      - ["myapp.cache", "Cache", true, "get", "", "", "Argument[0]", "ReturnValue", "taint", "manual"]
      - ["myapp.utils", "JSON", false, "parse", "", "", "Argument[0]", "ReturnValue", "taint", "manual"]

```

## Neutral Models

Columns: `[package, type, name, signature, kind, provenance]` (6 columns, NOT the 10-column `summaryModel` format).

Use `neutralModel` to explicitly block taint propagation through known-safe functions.

Example:

```yaml
  - addsTo:
      pack: codeql/python-all
      extensible: neutralModel
    data:
      - ["myapp.security", "Sanitizer", "escape_html", "", "summary", "manual"]
```

**`neutralModel` vs no model:** If a function has no model at all, CodeQL may still infer flow through it. Use `neutralModel` to explicitly block taint propagation through known-safe functions.

## Language-Specific Notes

**Python:** Use dotted module paths for `package` (e.g., `myapp.db`).

**JavaScript:** `package` is often `""` for project-local code. Use the import path for npm packages.

**Go:** Use full import paths (e.g., `myapp/internal/db`). `type` is often `""` for package-level functions.

**Java:** Use fully qualified package names (e.g., `com.myapp.db`).

**C/C++:** Use `""` for package, put the namespace in `type`.

## Deploying Extensions

**Known limitation:** `--additional-packs` and `--model-packs` flags do not work with pre-compiled query packs (bundled CodeQL distributions that cache `java-all` inside `.codeql/libraries/`). Extensions placed in a standalone model pack directory will be resolved by `codeql resolve qlpacks` but silently ignored during `codeql database analyze`.

**Workaround — copy extensions into the library pack's `ext/` directory:**

> **Warning:** Files copied into the `ext/` directory live inside CodeQL's managed pack cache. They will be **lost** when packs are updated via `codeql pack download` or version upgrades. After any pack update, re-run this deployment step to restore the extensions.

```bash
# Find the java-all ext directory used by the query pack
JAVA_ALL_EXT=$(find "$(codeql resolve qlpacks 2>/dev/null | grep 'java-queries' | awk '{print $NF}' | tr -d '()')" \
  -path '*/.codeql/libraries/codeql/java-all/*/ext' -type d 2>/dev/null | head -1)

if [ -n "$JAVA_ALL_EXT" ]; then
  PROJECT_NAME=$(basename "$(pwd)")
  cp "$OUTPUT_DIR/extensions/sources.yml" "$JAVA_ALL_EXT/${PROJECT_NAME}.sources.model.yml"
  [ -f "$OUTPUT_DIR/extensions/sinks.yml" ] && cp "$OUTPUT_DIR/extensions/sinks.yml" "$JAVA_ALL_EXT/${PROJECT_NAME}.sinks.model.yml"
  [ -f "$OUTPUT_DIR/extensions/summaries.yml" ] && cp "$OUTPUT_DIR/extensions/summaries.yml" "$JAVA_ALL_EXT/${PROJECT_NAME}.summaries.model.yml"

  # Verify deployment — confirm files landed correctly
  DEPLOYED=$(ls "$JAVA_ALL_EXT/${PROJECT_NAME}".*.model.yml 2>/dev/null | wc -l)
  if [ "$DEPLOYED" -gt 0 ]; then
    echo "Extensions deployed to $JAVA_ALL_EXT ($DEPLOYED files):"
    ls -la "$JAVA_ALL_EXT/${PROJECT_NAME}".*.model.yml
  else
    echo "ERROR: Files were copied but verification failed. Check path: $JAVA_ALL_EXT"
  fi
else
  echo "WARNING: Could not find java-all ext directory. Extensions may not load."
  echo "Attempted path lookup from: codeql resolve qlpacks | grep java-queries"
  echo "Run 'codeql resolve qlpacks' manually to debug."
fi
```

**For Python/JS/Go:** The same limitation may apply. Locate the `<lang>-all` pack's `ext/` directory and copy extensions there.

**Alternative (if query packs are NOT pre-compiled):** Use `--additional-packs=./codeql-extensions` with a proper model pack `qlpack.yml`:

```yaml
# $OUTPUT_DIR/extensions/qlpack.yml
name: custom/<project>-extensions
version: 0.0.1
library: true
extensionTargets:
  codeql/<lang>-all: "*"
dataExtensions:
  - sources.yml
  - sinks.yml
  - summaries.yml
```

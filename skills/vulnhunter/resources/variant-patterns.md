# Variant Analysis Patterns

Reusable templates for hunting vulnerability variants across codebases.

## Pattern Extraction Framework

### Step 1: Decompose the Vulnerability

```
┌─────────────────────────────────────────────────────────────┐
│                    VULNERABILITY                            │
├─────────────────────────────────────────────────────────────┤
│  SOURCE      │  Where does attacker-controlled data enter?  │
│  TRANSFORM   │  How is the data processed/modified?         │
│  SINK        │  Where does the data cause harm?             │
│  MISSING     │  What validation/sanitization is absent?     │
└─────────────────────────────────────────────────────────────┘
```

### Step 2: Create Search Patterns

#### Regex Patterns
```
# General template
[source_pattern].*[transform_pattern]?.*[sink_pattern]

# Without [validation_pattern] between source and sink
```

#### AST Patterns (Semgrep style)
```yaml
patterns:
  - pattern: |
      $SOURCE = request.$METHOD(...)
      ...
      $SINK($SOURCE)
  - pattern-not: |
      $SOURCE = request.$METHOD(...)
      ...
      $SANITIZED = sanitize($SOURCE)
      ...
      $SINK($SANITIZED)
```

## Common Vulnerability Patterns

### Pattern 1: SQL Injection Variants

**Original Finding:**
```python
cursor.execute("SELECT * FROM users WHERE id = " + request.args['id'])
```

**Pattern Abstraction:**
```
user_input -> string_concat/format -> sql_execute
```

**Search Patterns:**
```python
# Pattern A: String concatenation
r'execute\([^)]*\+.*request'
r'execute\([^)]*\+.*params'

# Pattern B: Format strings
r'execute\([^)]*%.*%'
r'execute\([^)]*\.format'

# Pattern C: f-strings
r'execute\(f["\'].*\{'
```

**Variant Locations to Check:**
- Other database methods: `fetchone`, `fetchall`, `executemany`
- ORM raw queries: `Model.objects.raw()`, `session.execute()`
- Different input sources: POST body, headers, cookies

---

### Pattern 2: Command Injection Variants

**Original Finding:**
```python
os.system(f"ping {user_host}")
```

**Pattern Abstraction:**
```
user_input -> command_string -> shell_execution
```

**Search Patterns:**
```python
# Direct execution
r'os\.system\([^)]*\{'
r'subprocess\..*shell\s*=\s*True'
r'Popen\([^)]*shell\s*=\s*True'

# Backtick/eval equivalents
r'eval\(.*request'
r'exec\(.*input'
```

**Variant Locations:**
- CI/CD configurations (shell commands)
- Build scripts
- System utilities
- Log processing

---

### Pattern 3: Path Traversal Variants

**Original Finding:**
```python
file_path = os.path.join("/uploads", user_filename)
open(file_path)
```

**Pattern Abstraction:**
```
user_input -> path_construction -> file_operation
```

**Search Patterns:**
```python
# Path operations with user input
r'os\.path\.join\([^)]*request'
r'open\([^)]*\+.*input'
r'Path\([^)]*request'
r'send_file\(.*filename'

# Archive extraction
r'extractall\('
r'ZipFile.*extract'
r'tarfile.*extract'
```

**Variants:**
- Download endpoints
- File upload handling
- Template loading
- Static file serving
- Log file access

---

### Pattern 4: SSRF Variants

**Original Finding:**
```python
requests.get(user_url)
```

**Pattern Abstraction:**
```
user_input -> url_construction -> http_request
```

**Search Patterns:**
```python
# HTTP libraries
r'requests\.(get|post|put)\([^)]*request'
r'urllib\..*open\([^)]*user'
r'http\.client.*request'
r'aiohttp.*session\.(get|post)'

# URL in redirects
r'redirect\(.*request'
r'HttpResponseRedirect\([^)]*input'
```

**Variants:**
- Webhook configurations
- OAuth callbacks
- PDF generation (URL fetching)
- Image proxy services
- Link preview features

---

### Pattern 5: Insecure Deserialization

**Original Finding:**
```python
data = pickle.loads(request.data)
```

**Pattern Abstraction:**
```
untrusted_bytes -> deserialize -> object_instantiation
```

**Search Patterns:**
```python
# Python
r'pickle\.loads?\('
r'yaml\.load\([^)]*$'  # Without safe_load
r'marshal\.loads?\('

# Java patterns
r'ObjectInputStream'
r'readObject\(\)'
r'XMLDecoder'

# PHP
r'unserialize\('
```

**Variants:**
- Session storage backends
- Cache systems (Redis, Memcached)
- Message queues
- RPC mechanisms
- Cookie values

---

### Pattern 6: Hardcoded Secrets

**Original Finding:**
```python
API_KEY = "sk-live-abc123"
```

**Pattern Abstraction:**
```
literal_string -> assignment -> sensitive_variable
```

**Search Patterns:**
```python
# API keys and tokens
r'(api[_-]?key|apikey)\s*[=:]\s*["\'][^"\']+["\']'
r'(secret|token|password)\s*[=:]\s*["\'][^"\']+["\']'
r'(aws[_-]?access|aws[_-]?secret).*[=:]\s*["\'][A-Za-z0-9/+]+["\']'

# Connection strings
r'(mysql|postgres|mongodb)://[^@]+:[^@]+@'
r'redis://:[^@]+@'
```

**Variants:**
- Test/fixture files
- Docker configurations
- CI/CD configs
- Mobile app configs
- Frontend code (API keys)

---

### Pattern 7: Missing Authentication

**Original Finding:**
```python
@app.route('/admin/delete_user/<id>')
def delete_user(id):  # No @login_required!
    User.delete(id)
```

**Pattern Abstraction:**
```
route_definition -> handler -> sensitive_operation (missing: auth_decorator)
```

**Search Patterns:**
```python
# Flask/Django routes without auth
r'@app\.route.*\n(?!.*@login_required).*def'
r'@api_view.*\n(?!.*@permission_classes).*def'

# Express routes
r'app\.(get|post|put|delete)\([^,]+,\s*\([^)]*\)\s*=>'  # Check no middleware
```

**Variants:**
- Admin endpoints
- API endpoints
- Internal tools
- Debug endpoints
- Health checks exposing sensitive info

---

### Pattern 8: Race Conditions (TOCTOU)

**Original Finding:**
```python
if user.balance >= amount:
    user.balance -= amount
    transfer(amount)
```

**Pattern Abstraction:**
```
check_condition -> gap -> act_on_condition (missing: atomic/lock)
```

**Search Patterns:**
```python
# Balance/resource checks
r'if.*balance.*>=.*\n.*balance.*-='
r'if.*count.*>.*\n.*count.*-='

# File operations
r'if.*exists\(.*\).*\n.*open\('
r'if.*isfile\(.*\).*\n.*remove\('
```

**Variants:**
- Financial operations
- Inventory management
- Rate limiting
- File locking
- Session handling

---

## Variant Discovery Workflow

```
┌─────────────────────────────────────────────────────────────┐
│  1. ANALYZE ORIGINAL FINDING                                │
│     - What's the root cause?                                │
│     - What makes it exploitable?                            │
├─────────────────────────────────────────────────────────────┤
│  2. EXTRACT ABSTRACT PATTERN                                │
│     - Source → Transform → Sink                             │
│     - What's missing (validation)?                          │
├─────────────────────────────────────────────────────────────┤
│  3. CREATE SEARCH QUERIES                                   │
│     - Regex for quick grep                                  │
│     - Semgrep/CodeQL for precision                          │
├─────────────────────────────────────────────────────────────┤
│  4. EXPAND SEARCH SCOPE                                     │
│     - Same pattern, different source                        │
│     - Same pattern, different sink                          │
│     - Same pattern, different language/framework            │
├─────────────────────────────────────────────────────────────┤
│  5. VALIDATE EACH FINDING                                   │
│     - Is it reachable?                                      │
│     - Is input controllable?                                │
│     - Is impact significant?                                │
└─────────────────────────────────────────────────────────────┘
```

## Cross-Language Pattern Mapping

| Vulnerability | Python | JavaScript | Go | Rust |
|--------------|--------|------------|-----|------|
| SQL Injection | `cursor.execute()` | `query()` | `db.Query()` | `query()` |
| Command Injection | `os.system()` | `exec()` | `exec.Command()` | `Command::new()` |
| Path Traversal | `open(path)` | `fs.readFile()` | `os.Open()` | `File::open()` |
| Deserialize | `pickle.loads()` | `JSON.parse()` | `json.Unmarshal()` | `serde::from_*()` |
| Template Injection | `Template()` | `eval()` | `template.Execute()` | N/A |

## Semgrep Rule Templates

### Generic Taint Tracking
```yaml
rules:
  - id: generic-injection
    mode: taint
    pattern-sources:
      - pattern: request.$METHOD(...)
      - pattern: $PARAM = request.params[...]
    pattern-sinks:
      - pattern: dangerous_function($SINK)
    pattern-sanitizers:
      - pattern: sanitize(...)
    message: "Tainted data flows to dangerous sink"
    languages: [python, javascript]
    severity: ERROR
```

### Missing Security Control
```yaml
rules:
  - id: missing-auth-check
    patterns:
      - pattern: |
          @app.route($PATH)
          def $FUNC(...):
            ...
      - pattern-not: |
          @app.route($PATH)
          @login_required
          def $FUNC(...):
            ...
    message: "Route may be missing authentication"
    languages: [python]
    severity: WARNING
```

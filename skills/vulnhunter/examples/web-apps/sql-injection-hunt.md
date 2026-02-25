# Example: SQL Injection Variant Hunt

Real-world example of hunting SQL injection variants after discovering an initial finding.

## Scenario

During a code review of an e-commerce application, we found this vulnerability:

```python
# Original finding in app/api/users.py:45
@app.route('/api/users/<user_id>')
def get_user(user_id):
    query = f"SELECT * FROM users WHERE id = {user_id}"
    result = db.execute(query)
    return jsonify(result.fetchone())
```

## Step 1: Root Cause Analysis

**Why is this vulnerable?**
- User input (`user_id`) flows directly into SQL query
- No parameterization or input validation
- f-string allows arbitrary SQL injection

**Pattern:**
```
URL_parameter → f-string/concat → db.execute()
```

## Step 2: Extract Search Patterns

### Pattern A: f-string SQL
```bash
grep -rn 'execute(f["\'].*SELECT\|INSERT\|UPDATE\|DELETE' --include="*.py"
```

### Pattern B: String concatenation SQL
```bash
grep -rn 'execute([^)]*\+' --include="*.py"
```

### Pattern C: Format string SQL
```bash
grep -rn 'execute([^)]*%' --include="*.py"
```

### Semgrep Rule
```yaml
rules:
  - id: sql-injection-fstring
    patterns:
      - pattern: $DB.execute(f"...$VAR...")
    message: "Potential SQL injection via f-string"
    languages: [python]
    severity: ERROR
```

## Step 3: Search Results

### Raw Matches
```
app/api/users.py:45:    query = f"SELECT * FROM users WHERE id = {user_id}"
app/api/products.py:78:    query = f"SELECT * FROM products WHERE category = '{category}'"
app/api/orders.py:112:   query = "SELECT * FROM orders WHERE user_id = " + str(user_id)
app/admin/reports.py:34: cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
app/search/index.py:89:  query = "SELECT * FROM items WHERE name LIKE '%%%s%%'" % search_term
lib/database.py:156:     self.execute(f"INSERT INTO logs VALUES ('{action}')")
```

## Step 4: Validate Each Finding

### Variant 1: Products endpoint (CONFIRMED)
```python
# app/api/products.py:78
@app.route('/api/products')
def get_products():
    category = request.args.get('category')
    query = f"SELECT * FROM products WHERE category = '{category}'"
    result = db.execute(query)
    return jsonify(result.fetchall())
```

**Severity:** High
**Analysis:** Query parameter `category` is directly interpolated. Attacker can inject: `' OR '1'='1`

### Variant 2: Orders endpoint (CONFIRMED)
```python
# app/api/orders.py:112
@app.route('/api/orders/<user_id>')
def get_orders(user_id):
    query = "SELECT * FROM orders WHERE user_id = " + str(user_id)
    result = db.execute(query)
    return jsonify(result.fetchall())
```

**Severity:** High
**Analysis:** String concatenation allows injection. `str()` provides no protection against `1 OR 1=1`.

### Variant 3: Admin reports (CONFIRMED - CRITICAL)
```python
# app/admin/reports.py:34
@app.route('/admin/reports/<table_name>')
@admin_required
def generate_report(table_name):
    cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
    return jsonify(count=cursor.fetchone()[0])
```

**Severity:** Critical
**Analysis:** Table name injection allows reading arbitrary tables, potential data exfiltration. Example: `users; SELECT * FROM users--`

### Variant 4: Search functionality (CONFIRMED)
```python
# app/search/index.py:89
@app.route('/search')
def search():
    search_term = request.args.get('q')
    query = "SELECT * FROM items WHERE name LIKE '%%%s%%'" % search_term
    result = db.execute(query)
    return jsonify(result.fetchall())
```

**Severity:** High
**Analysis:** Old-style format string injection. Input `%'; DROP TABLE items;--` would be dangerous.

### Variant 5: Logging (FALSE POSITIVE - but still fix)
```python
# lib/database.py:156
def log_action(self, action):
    # action comes from internal code, not user input
    self.execute(f"INSERT INTO logs VALUES ('{action}')")
```

**Analysis:** `action` is set internally (e.g., `log_action("user_login")`), not from user input. However, this is still a code smell and should be parameterized for defense in depth.

## Step 5: Summary

| Finding | Location | Severity | Status |
|---------|----------|----------|--------|
| Original | users.py:45 | High | Confirmed |
| Variant 1 | products.py:78 | High | Confirmed |
| Variant 2 | orders.py:112 | High | Confirmed |
| Variant 3 | reports.py:34 | Critical | Confirmed |
| Variant 4 | search/index.py:89 | High | Confirmed |
| Variant 5 | database.py:156 | Low | FP (but fix) |

**Total: 5 confirmed SQL injection vulnerabilities (4 High, 1 Critical)**

## Step 6: Remediation

### Systemic Fix
Implement a database abstraction layer that only allows parameterized queries:

```python
# lib/safe_db.py
class SafeDatabase:
    def query(self, sql: str, params: tuple = ()):
        """Only allows parameterized queries."""
        if any(c in sql for c in ['{', '%s', '+']):
            raise SecurityError("Use parameterized queries only")
        return self._cursor.execute(sql, params)
```

### Individual Fixes

```python
# Fixed: app/api/users.py
@app.route('/api/users/<int:user_id>')  # Type constraint
def get_user(user_id):
    query = "SELECT * FROM users WHERE id = ?"
    result = db.execute(query, (user_id,))
    return jsonify(result.fetchone())

# Fixed: app/admin/reports.py
ALLOWED_TABLES = {'users', 'orders', 'products'}

@app.route('/admin/reports/<table_name>')
@admin_required
def generate_report(table_name):
    if table_name not in ALLOWED_TABLES:
        abort(400, "Invalid table")
    # Safe because table_name is from allowlist
    cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
    return jsonify(count=cursor.fetchone()[0])
```

### Prevention
1. Enable SQLAlchemy's `echo=True` in dev to review all queries
2. Add Semgrep to CI/CD pipeline with SQL injection rules
3. Code review checklist: "Are all database queries parameterized?"
4. Use ORM methods instead of raw SQL where possible

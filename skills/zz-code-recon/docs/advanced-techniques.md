# Advanced Reconnaissance Techniques

Deep dive techniques for complex codebases and specialized domains.

## Dynamic Analysis Integration

### 1. Traffic Capture Analysis

When static analysis isn't enough, capture real traffic:

```bash
# Capture HTTP traffic (development)
mitmproxy -p 8080 --save-stream-file traffic.flow

# Analyze captured traffic
mitmproxy --read-flow traffic.flow --view-filter "~m POST"
```

**What to look for:**
- Hidden API endpoints not in code
- Authentication token formats
- Request/response patterns
- Error message content

### 2. Debug Mode Reconnaissance

Enable verbose modes safely:

```python
# FastAPI debug
uvicorn main:app --reload --log-level debug

# Django debug (never in prod!)
DEBUG = True
ALLOWED_HOSTS = ['*']

# Express.js
DEBUG=* node app.js
```

**Capture:**
- SQL queries being executed
- Authentication decisions
- Error stack traces
- Timing information

### 3. Database Schema Extraction

Direct schema analysis:

```sql
-- PostgreSQL
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name;

-- MySQL
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'database_name';
```

**Look for:**
- Sensitive columns (password, ssn, etc.)
- Foreign key relationships
- Soft delete columns (deleted_at)
- Audit columns (created_by, updated_at)

## Semantic Code Analysis

### 1. AST-Based Analysis

Using tree-sitter for cross-language analysis:

```python
import tree_sitter_python as tspython
from tree_sitter import Language, Parser

PY_LANGUAGE = Language(tspython.language())
parser = Parser(PY_LANGUAGE)

code = open("target.py").read()
tree = parser.parse(bytes(code, "utf8"))

# Find all function definitions
def find_functions(node, results=[]):
    if node.type == "function_definition":
        name = node.child_by_field_name("name")
        results.append(name.text.decode())
    for child in node.children:
        find_functions(child, results)
    return results

functions = find_functions(tree.root_node)
```

### 2. Call Graph Generation

Build comprehensive call graphs:

```bash
# Python with pyan3
pyan3 app/**/*.py --dot > callgraph.dot
dot -Tpng callgraph.dot -o callgraph.png

# JavaScript with madge
madge --image graph.png src/

# Go with go-callvis
go-callvis -focus main ./...
```

**Analyze for:**
- Entry points to sensitive functions
- Unused code paths
- Circular dependencies
- External call sites

### 3. Data Flow Analysis

Using CodeQL for taint tracking:

```ql
/**
 * @name Find SQL injection vulnerabilities
 * @kind path-problem
 */

import python
import semmle.python.dataflow.TaintTracking

class SQLInjectionConfig extends TaintTracking::Configuration {
  SQLInjectionConfig() { this = "SQLInjectionConfig" }

  override predicate isSource(DataFlow::Node source) {
    exists(FunctionDef f |
      source.asCfgNode() = f.getArg(_).getAFlowNode()
    )
  }

  override predicate isSink(DataFlow::Node sink) {
    exists(Call c |
      c.getFunc().(Attribute).getName() = "execute" and
      sink.asCfgNode() = c.getArg(0).getAFlowNode()
    )
  }
}

from SQLInjectionConfig cfg, DataFlow::PathNode source, DataFlow::PathNode sink
where cfg.hasFlowPath(source, sink)
select sink, source, sink, "SQL injection from $@.", source, "user input"
```

## Protocol-Level Analysis

### 1. API Schema Extraction

Generate OpenAPI from code:

```bash
# FastAPI auto-generates at /openapi.json
curl http://localhost:8000/openapi.json > api-schema.json

# Express with swagger-jsdoc
npx swagger-jsdoc -d swaggerDef.js -o openapi.json

# Django with drf-spectacular
python manage.py spectacular --file schema.yml
```

### 2. GraphQL Introspection

```graphql
# Full schema introspection
query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      name
      kind
      fields {
        name
        args { name type { name } }
        type { name kind }
      }
    }
  }
}
```

**Look for:**
- Sensitive queries/mutations
- Authorization on fields
- Nested query depth limits
- Batch query limits

### 3. gRPC Service Discovery

```bash
# List services with grpcurl
grpcurl -plaintext localhost:50051 list

# Describe service methods
grpcurl -plaintext localhost:50051 describe MyService

# Describe message types
grpcurl -plaintext localhost:50051 describe MyRequest
```

## Binary and Compiled Code

### 1. Decompilation Strategies

**Java/Kotlin (Android):**
```bash
# APK to source
apktool d app.apk
jadx -d output/ app.apk
```

**Go binaries:**
```bash
# Symbol extraction
go tool nm binary | grep main
# Decompilation (limited)
ghidra-headless . project -import binary -postScript GoAnalysis.py
```

**Rust binaries:**
```bash
# With debug symbols
rust-gdb ./binary
# Symbol recovery
nm -C binary | grep -v " U "
```

### 2. Mobile App Analysis

```bash
# iOS: Extract from IPA
unzip app.ipa
plutil -convert xml1 Payload/App.app/Info.plist

# Android: Extract configurations
apktool d app.apk
grep -r "api\|key\|secret" app/res/
grep -r "api\|key\|secret" app/assets/
```

## Smart Contract Specific

### 1. Bytecode Analysis

```bash
# Extract bytecode
solc --bin Contract.sol

# Decompile with panoramix
panoramix 0x1234...

# Verify deployed matches source
# Compare compiled bytecode vs chain bytecode
```

### 2. Storage Layout Analysis

```solidity
// Slot calculation for mappings
// slot = keccak256(abi.encode(key, mappingSlot))

// Read storage directly
cast storage 0xContractAddress 0
cast storage 0xContractAddress 1
```

### 3. Event Log Analysis

```javascript
// Fetch historical events
const filter = contract.filters.Transfer();
const events = await contract.queryFilter(filter, startBlock, endBlock);

// Decode event data
events.forEach(e => {
    console.log(`From: ${e.args.from}, To: ${e.args.to}, Value: ${e.args.value}`);
});
```

## Large Codebase Strategies

### 1. Divide and Conquer

```
Phase 1: Identify boundaries (1-2 hours)
├── Map top-level modules
├── Identify entry points
└── Note inter-module communication

Phase 2: Depth-first on critical paths (2-4 hours)
├── Authentication flow
├── Payment/financial flows
├── Data export/import
└── Admin functionality

Phase 3: Breadth sweep (ongoing)
├── Secondary modules
├── Background jobs
└── Utility functions
```

### 2. Automated Scanning Orchestration

```bash
#!/bin/bash
# Full scan pipeline

# Dependency check
npm audit --json > reports/npm-audit.json
pip-audit -f json > reports/pip-audit.json

# SAST
semgrep --config=p/security-audit -o reports/semgrep.json --json .
bandit -r . -f json -o reports/bandit.json

# Secret scanning
trufflehog filesystem . --json > reports/secrets.json
gitleaks detect --source . -f json -r reports/gitleaks.json

# Aggregate results
python scripts/aggregate-findings.py reports/ > summary.md
```

### 3. Incremental Analysis

For ongoing engagements:

```bash
# Get changed files since last audit
git diff --name-only $(git log --since="2024-01-01" --format=%H | tail -1)

# Focus scan on changes
semgrep --config=p/security-audit $(git diff --name-only HEAD~10)

# Track new endpoints
diff -u prev-openapi.json curr-openapi.json
```

## Documentation Mining

### 1. Hidden Documentation

```bash
# Find internal docs
find . -name "*.md" -o -name "*.txt" -o -name "*.rst" | xargs grep -l "internal\|private\|secret"

# API documentation
find . -name "swagger*" -o -name "openapi*" -o -name "*api*doc*"

# Architecture docs
find . -name "*architecture*" -o -name "*design*" -o -name "*spec*"
```

### 2. Comment Analysis

```bash
# TODO/FIXME comments (often security-relevant)
grep -rn "TODO\|FIXME\|XXX\|HACK\|BUG" --include="*.py" --include="*.js"

# Security-related comments
grep -rn "security\|vulnerable\|danger\|unsafe\|insecure" --include="*.py"

# Disabled code
grep -rn "# *if 0\|// *if 0\|/\* *disabled" .
```

### 3. Git History Mining

```bash
# Commits mentioning security
git log --all --grep="security\|vulnerability\|CVE\|fix" --oneline

# Files with most security commits
git log --all --grep="security" --name-only --format="" | sort | uniq -c | sort -rn

# Removed code that might be interesting
git log -p --all -S "password" -- "*.py" | head -100
```

## Output Formats

### 1. Machine-Readable Output

```json
{
  "project": "example-app",
  "timestamp": "2024-01-15T10:30:00Z",
  "entry_points": [
    {
      "type": "http",
      "method": "POST",
      "path": "/api/login",
      "auth": "none",
      "handler": "auth.login",
      "file": "app/api/auth.py",
      "line": 45
    }
  ],
  "critical_functions": [],
  "trust_boundaries": [],
  "risks": []
}
```

### 2. Visual Outputs

```bash
# Generate diagrams
python scripts/generate-architecture.py > arch.mmd
mmdc -i arch.mmd -o arch.png

# Interactive HTML report
python scripts/generate-report.py --format html > report.html
```

### 3. Integration with Issue Trackers

```bash
# Create GitHub issues from findings
gh issue create --title "Security: SQL Injection in user lookup" \
  --body "$(cat finding-001.md)" \
  --label "security,high-priority"
```

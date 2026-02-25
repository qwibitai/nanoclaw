---
name: vulnhunter
description: Security vulnerability detection and variant analysis skill. Use when hunting for dangerous APIs, footgun patterns, error-prone configurations, and vulnerability variants across codebases. Combines sharp edges detection with variant hunting methodology.
---

# VulnHunter - Security Vulnerability Detection & Analysis

A comprehensive security audit skill for identifying dangerous APIs, footgun patterns, error-prone configurations, and hunting for vulnerability variants across codebases. Inspired by Trail of Bits' sharp-edges and variant-analysis methodologies.

## Overview

VulnHunter combines two powerful security analysis techniques:
1. **Sharp Edges Detection** - Identify error-prone APIs, dangerous defaults, and footgun designs
2. **Variant Analysis** - Find similar vulnerabilities across codebases using pattern-based analysis

### When to Use VulnHunter

**Activate this skill when:**
- Conducting security code reviews or audits
- Reviewing third-party dependencies for dangerous patterns
- Hunting for variants of known vulnerabilities
- Assessing API design for security footguns
- Pre-audit reconnaissance of unfamiliar codebases

## Sharp Edges Detection

### Categories of Sharp Edges

#### 1. Dangerous Default Configurations
Look for configurations that are insecure by default:

```
- CORS: Access-Control-Allow-Origin: *
- Debug modes enabled in production
- Default credentials or API keys
- Permissive file permissions (777, 666)
- SSL/TLS verification disabled
- Insecure deserialization settings
```

#### 2. Error-Prone APIs

**Memory Safety:**
```c
// Dangerous: No bounds checking
strcpy(), strcat(), sprintf(), gets()
memcpy() without size validation

// Safer alternatives
strncpy(), strncat(), snprintf(), fgets()
memcpy_s() with explicit size
```

**Cryptography Footguns:**
```
- ECB mode encryption
- MD5/SHA1 for security purposes
- Hardcoded IVs or salts
- Custom crypto implementations
- Random without CSPRNG (Math.random for tokens)
```

**Concurrency Issues:**
```
- Race conditions in file operations
- Time-of-check to time-of-use (TOCTOU)
- Double-checked locking anti-patterns
- Non-atomic increment/decrement operations
```

#### 3. Language-Specific Footguns

**JavaScript/TypeScript:**
```javascript
// Dangerous patterns
eval(), new Function(), setTimeout(string)
innerHTML, outerHTML, document.write()
Object.assign() for deep clone (shallow only!)
== instead of === (type coercion)
```

**Python:**
```python
# Dangerous patterns
pickle.loads(untrusted)  # RCE vector
yaml.load(untrusted)     # Use safe_load
exec(), eval()
os.system(), subprocess with shell=True
```

**Rust:**
```rust
// Patterns requiring extra scrutiny
unsafe { }
.unwrap() in production code
mem::transmute()
raw pointer dereference
```

**Solidity/Smart Contracts:**
```solidity
// High-risk patterns
tx.origin for authentication  // Phishing vulnerable
delegatecall to untrusted     // Storage collision
selfdestruct                  // Permanent destruction
block.timestamp for randomness // Miner manipulable
```

### Sharp Edges Checklist

When reviewing code, systematically check for:

- [ ] **Authentication bypasses** - Missing auth checks, default credentials
- [ ] **Authorization flaws** - Privilege escalation, IDOR patterns
- [ ] **Injection vectors** - SQL, Command, Template, XSS
- [ ] **Cryptographic weaknesses** - Weak algorithms, improper key handling
- [ ] **Resource exhaustion** - Unbounded loops, memory allocation
- [ ] **Race conditions** - TOCTOU, concurrent state modification
- [ ] **Information disclosure** - Verbose errors, debug endpoints
- [ ] **Deserialization** - Untrusted data unmarshaling
- [ ] **Path traversal** - User-controlled file paths
- [ ] **SSRF vectors** - User-controlled URLs, redirects

## Variant Analysis

### The Variant Hunting Process

1. **Identify the Root Cause** - Understand WHY a vulnerability exists
2. **Extract the Pattern** - What code structure enables it?
3. **Generalize the Pattern** - Create regex/AST patterns
4. **Search Codebase** - Hunt for similar structures
5. **Validate Findings** - Confirm each variant is exploitable

### Pattern Extraction Templates

#### Template 1: Missing Validation Pattern
```
Original bug: User input flows to SQL query without sanitization
Pattern: [user_input] -> [sink_function] without [validation_function]

Search for:
- Direct database calls with string concatenation
- ORM raw query methods with user parameters
- Similar data flows in adjacent modules
```

#### Template 2: Authentication Bypass
```
Original bug: Endpoint missing auth middleware
Pattern: Route definition without auth decorator/middleware

Search for:
- Routes defined after the vulnerable one
- Similar API patterns in other modules
- Admin/internal endpoints
```

#### Template 3: Race Condition
```
Original bug: Check-then-act without atomicity
Pattern: if (check_condition()) { act_on_condition() }

Search for:
- File existence checks followed by file operations
- Permission checks followed by privileged actions
- Balance checks followed by transfers
```

### Search Strategies

#### Grep-Based Search
```bash
# Find potential SQL injection
grep -rn "execute.*%s" --include="*.py"
grep -rn "query.*\+" --include="*.js"

# Find dangerous deserialize
grep -rn "pickle.loads\|yaml.load\|eval(" --include="*.py"

# Find command injection vectors
grep -rn "os.system\|subprocess.*shell=True" --include="*.py"
```

#### Semantic Search (AST-Based)
For more precise matching, use AST-based tools:
- **Semgrep** - Cross-language semantic grep
- **CodeQL** - GitHub's semantic analysis
- **tree-sitter** - Universal parser

### Variant Analysis Report Template

```markdown
## Variant Analysis Report

### Original Finding
- **ID**: FINDING-001
- **Severity**: High
- **Root Cause**: [Description]
- **Affected File**: path/to/file.ext:line

### Pattern Extracted
[Code pattern or regex]

### Variants Discovered

| # | Location | Severity | Status | Notes |
|---|----------|----------|--------|-------|
| 1 | file.ext:42 | High | Confirmed | Same root cause |
| 2 | other.ext:100 | Medium | Suspected | Needs validation |

### Recommendations
[Systematic fix approach]
```

## Workflow

### Phase 1: Reconnaissance
1. Identify technology stack and languages
2. Map entry points (APIs, CLI, file inputs)
3. Locate authentication/authorization logic
4. Find cryptographic operations
5. Identify external integrations

### Phase 2: Sharp Edges Scan
1. Run through sharp edges checklist
2. Focus on security-critical paths
3. Document all suspicious patterns
4. Cross-reference with known CVEs

### Phase 3: Variant Hunting
1. For each finding, extract pattern
2. Search for variants systematically
3. Validate each potential variant
4. Assess aggregate risk

### Phase 4: Reporting
1. Consolidate findings by category
2. Assign severity ratings
3. Provide remediation guidance
4. Highlight systemic issues

## Integration with Static Analysis

### Semgrep Rules for Common Patterns

```yaml
# Example: Detect SQL injection in Python
rules:
  - id: sql-injection-format
    patterns:
      - pattern: $CURSOR.execute($QUERY % ...)
    message: "Potential SQL injection via string formatting"
    severity: ERROR
    languages: [python]
```

### CodeQL Queries

```ql
// Find tainted data flowing to dangerous sinks
import python
import semmle.python.dataflow.TaintTracking

from DataFlow::PathNode source, DataFlow::PathNode sink
where TaintTracking::localTaint(source.getNode(), sink.getNode())
  and sink.getNode().asExpr().(Call).getTarget().getName() = "execute"
select sink, source, sink, "Tainted input reaches SQL execution"
```

## Examples

See the `/examples` folder for:
- Real-world sharp edges examples by language
- Variant analysis case studies
- Pattern extraction walkthroughs

## Resources

- `resources/sharp-edges-catalog.md` - Comprehensive catalog of dangerous patterns
- `resources/variant-patterns.md` - Common vulnerability pattern templates
- `templates/variant-report.md` - Report template for variant analysis

## Guidelines

1. **Always verify** - Don't report theoretical issues as confirmed vulnerabilities
2. **Context matters** - A pattern may be safe in one context, dangerous in another
3. **Prioritize exploitability** - Focus on patterns that lead to real impact
4. **Document assumptions** - Note any threat model assumptions
5. **Systemic over point fixes** - Recommend architectural improvements when patterns repeat

## Skill Files

```
vulnhunter/
├── SKILL.md                          # This file
├── resources/
│   ├── sharp-edges-catalog.md        # Categorized dangerous patterns
│   └── variant-patterns.md           # Vulnerability pattern templates
├── examples/
│   ├── smart-contracts/              # Solidity/blockchain examples
│   ├── web-apps/                     # Web application examples
│   └── native-code/                  # C/C++/Rust examples
├── templates/
│   └── variant-report.md             # Analysis report template
└── docs/
    └── methodology.md                # Detailed methodology guide
```

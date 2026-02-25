# VulnHunter Methodology Guide

Detailed methodology for conducting security audits using sharp edges detection and variant analysis.

## Phase 1: Reconnaissance

### 1.1 Technology Mapping

Create a technology inventory:

```markdown
## Project: [NAME]

### Languages
- Primary: [e.g., Python 3.11]
- Secondary: [e.g., JavaScript/TypeScript]

### Frameworks
- Backend: [e.g., FastAPI, Django]
- Frontend: [e.g., React, Vue]
- Smart Contracts: [e.g., Solidity 0.8.x, Anchor]

### Dependencies
- Database: [e.g., PostgreSQL, MongoDB]
- Cache: [e.g., Redis]
- Message Queue: [e.g., RabbitMQ, Kafka]
- External APIs: [list]

### Infrastructure
- Cloud: [AWS/GCP/Azure]
- Container: [Docker, K8s]
- CI/CD: [GitHub Actions, Jenkins]
```

### 1.2 Entry Point Mapping

Identify all data entry points:

| Entry Point | Type | Trust Level | Handler |
|-------------|------|-------------|---------|
| `/api/*` | HTTP REST | Untrusted | `api/routes.py` |
| `/admin/*` | HTTP REST | Semi-trusted | `admin/views.py` |
| `ws://` | WebSocket | Untrusted | `websocket/handler.py` |
| CLI args | Command Line | Trusted | `cli/main.py` |
| Config files | File | Trusted | `config/loader.py` |
| Message queue | Async | Internal | `workers/consumer.py` |

### 1.3 Security-Critical Components

Identify high-value targets:

- Authentication/authorization logic
- Payment/financial processing
- Cryptographic operations
- File upload/download handlers
- Admin/privileged functionality
- External service integrations
- Data export/import features

## Phase 2: Sharp Edges Detection

### 2.1 Automated Scanning

Run automated tools first:

```bash
# Semgrep with security rules
semgrep --config=p/security-audit --config=p/owasp-top-ten .

# Bandit for Python
bandit -r . -f json -o bandit-report.json

# npm audit for Node.js
npm audit --json > npm-audit.json

# cargo audit for Rust
cargo audit --json > cargo-audit.json

# Slither for Solidity
slither . --json slither-report.json
```

### 2.2 Manual Sharp Edges Review

For each security-critical component, check:

#### Authentication
- [ ] Default credentials removed?
- [ ] Password hashing uses bcrypt/argon2?
- [ ] Rate limiting on auth endpoints?
- [ ] Session regeneration on privilege change?
- [ ] Timing-safe comparisons for tokens?

#### Authorization
- [ ] All endpoints have auth checks?
- [ ] Role checks before privileged actions?
- [ ] Object ownership validated (IDOR)?
- [ ] API keys properly scoped?

#### Input Handling
- [ ] All user input validated?
- [ ] SQL queries parameterized?
- [ ] Command execution sanitized?
- [ ] File paths validated (no traversal)?
- [ ] Deserialization uses safe methods?

#### Cryptography
- [ ] No weak algorithms (MD5, SHA1, DES)?
- [ ] IVs/nonces are random, not reused?
- [ ] Keys from secure source?
- [ ] HTTPS enforced?
- [ ] Certificate validation enabled?

#### Output Handling
- [ ] XSS prevention (encoding/CSP)?
- [ ] Sensitive data not logged?
- [ ] Error messages don't leak info?
- [ ] CORS properly configured?

### 2.3 Document Findings

For each sharp edge found:

```markdown
### SHARP-[NUMBER]: [Title]

**Category:** [Auth/Crypto/Injection/etc.]
**Location:** `path/to/file.ext:line`
**Severity:** [Critical/High/Medium/Low/Info]

**Description:**
[What is the issue?]

**Impact:**
[What can an attacker achieve?]

**Code:**
```[lang]
// Problematic code
```

**Recommendation:**
[How to fix]
```

## Phase 3: Variant Analysis

### 3.1 Pattern Extraction

For each finding, extract the abstract pattern:

```
FINDING: SQL injection in user lookup

PATTERN EXTRACTION:
1. SOURCE: request.args.get('user_id')
2. TRANSFORM: string concatenation with query
3. SINK: cursor.execute()
4. MISSING: parameterization

ABSTRACT PATTERN:
request.* → string concat/format → *.execute()
```

### 3.2 Search Expansion

Expand search scope systematically:

```
ORIGINAL: request.args → f-string → cursor.execute()

VARIATIONS:
├── Different sources
│   ├── request.form
│   ├── request.json
│   ├── request.headers
│   └── request.cookies
├── Different string methods
│   ├── f-string: f"...{var}..."
│   ├── format: "...{}...".format()
│   ├── percent: "...%s..." % var
│   └── concat: "..." + var
└── Different sinks
    ├── cursor.execute()
    ├── db.session.execute()
    ├── Model.objects.raw()
    └── connection.query()
```

### 3.3 Systematic Search

```bash
# Create comprehensive search patterns
SOURCES='request\.(args|form|json|headers|cookies|data)'
STRING_OPS='(\+|\.format|%|f["\x27])'
DB_SINKS='(execute|query|raw|cursor)'

# Run searches
grep -rPn "$SOURCES.*$STRING_OPS.*$DB_SINKS" --include="*.py"
```

### 3.4 Validation Matrix

Track all potential variants:

| ID | Location | Pattern Match | Reachable | Controllable | Impact | Status |
|----|----------|---------------|-----------|--------------|--------|--------|
| V1 | file:42 | request→execute | Yes | Yes | RCE | Confirmed |
| V2 | file:78 | request→execute | Yes | Partial | SQLi | Confirmed |
| V3 | file:99 | config→execute | No | No | - | FP |

## Phase 4: Risk Assessment

### 4.1 Severity Scoring

Use CVSS-like scoring:

| Factor | Low (1) | Medium (2) | High (3) | Critical (4) |
|--------|---------|------------|----------|--------------|
| **Access** | Physical | Local | Adjacent | Network |
| **Complexity** | High | Medium | Low | None |
| **Privileges** | Admin | User | None | None |
| **User Interaction** | Required | Required | None | None |
| **Impact** | Info | Integrity | Availability | All |

### 4.2 Priority Matrix

Prioritize findings:

```
        │ Easy to Exploit │ Hard to Exploit │
────────┼─────────────────┼─────────────────┤
High    │  P1 - CRITICAL  │  P2 - HIGH      │
Impact  │  Fix immediately│  Fix this sprint│
────────┼─────────────────┼─────────────────┤
Low     │  P3 - MEDIUM    │  P4 - LOW       │
Impact  │  Fix next sprint│  Backlog        │
────────┴─────────────────┴─────────────────┘
```

## Phase 5: Reporting

### 5.1 Executive Summary

```markdown
## Executive Summary

### Scope
[What was reviewed]

### Key Findings
- X Critical vulnerabilities
- Y High vulnerabilities
- Z Medium vulnerabilities

### Risk Assessment
[Overall security posture]

### Top Recommendations
1. [Most important fix]
2. [Second most important]
3. [Third most important]
```

### 5.2 Technical Findings

For each finding:

```markdown
## [SEVERITY]-[NUMBER]: [Title]

### Summary
[One sentence description]

### Affected Components
- `path/to/file.ext`
- `path/to/other.ext`

### Technical Details
[In-depth explanation]

### Proof of Concept
[Steps to reproduce]

### Impact
[What an attacker can achieve]

### Remediation
[How to fix, with code examples]

### References
- [CVE if applicable]
- [OWASP reference]
```

### 5.3 Variant Analysis Appendix

Include variant analysis details:

```markdown
## Appendix: Variant Analysis

### Finding X Variants

| Variant | Location | Confirmed | Notes |
|---------|----------|-----------|-------|
| V1 | file:42 | Yes | Same root cause |
| V2 | file:78 | Yes | Different entry point |

### Search Patterns Used
[Document for reproducibility]
```

## Tools Reference

### Static Analysis
| Tool | Languages | Use Case |
|------|-----------|----------|
| Semgrep | Multi | Pattern matching |
| CodeQL | Multi | Dataflow analysis |
| Bandit | Python | Security linting |
| ESLint | JS/TS | Security plugins |
| Slither | Solidity | Smart contract |

### Dynamic Analysis
| Tool | Use Case |
|------|----------|
| Burp Suite | Web app testing |
| OWASP ZAP | Automated scanning |
| Nuclei | Template-based scanning |

### Fuzzing
| Tool | Use Case |
|------|----------|
| AFL++ | Binary fuzzing |
| LibFuzzer | Library fuzzing |
| Echidna | Solidity fuzzing |
| Foundry | Solidity testing |

## Checklist: Before Submitting Report

- [ ] All findings have PoC or clear reproduction steps
- [ ] Severity ratings are justified
- [ ] Remediation advice is actionable
- [ ] Variant analysis completed for critical findings
- [ ] No false positives included
- [ ] Executive summary is non-technical
- [ ] Code examples are correct and tested
- [ ] References are accurate

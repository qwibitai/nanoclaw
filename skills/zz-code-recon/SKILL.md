---
name: zz-code-recon
description: Deep architectural context building for security audits. Use when conducting security reviews, building codebase understanding, mapping trust boundaries, or preparing for vulnerability analysis. Inspired by Trail of Bits methodology.
---

# CodeRecon - Deep Architectural Context Building

Build comprehensive architectural understanding through ultra-granular code analysis. Designed for security auditors, code reviewers, and developers who need to rapidly understand unfamiliar codebases before diving deep.

## Overview

CodeRecon is a systematic approach to codebase reconnaissance that builds layered understanding from high-level architecture down to implementation details. Inspired by Trail of Bits' audit-context-building methodology.

### Why CodeRecon?

Before you can find vulnerabilities, you need to understand:
- How the system is architected
- Where data flows
- What the trust boundaries are
- Where security-critical logic lives

This skill provides a structured methodology for building that context efficiently.

## The Recon Pyramid

```
                    ┌─────────────┐
                    │   DETAILS   │  ← Implementation specifics
                   ─┼─────────────┼─
                  / │  FUNCTIONS  │  ← Key function analysis
                 /  ─┼─────────────┼─
                /   │   MODULES   │  ← Component relationships
               /    ─┼─────────────┼─
              /     │ ARCHITECTURE│  ← System structure
             /      ─┼─────────────┼─
            /       │   OVERVIEW  │  ← High-level understanding
           ─────────┴─────────────┴─────────
```

Start broad, go deep systematically.

## Phase 1: Overview Reconnaissance

### 1.1 Project Identification

Gather basic project information:

```bash
# Check for documentation
ls -la README* ARCHITECTURE* SECURITY* CHANGELOG* docs/

# Identify build system
ls package.json Cargo.toml go.mod pyproject.toml Makefile

# Check for tests
ls -la test* spec* *_test* __tests__/

# Identify CI/CD
ls -la .github/workflows/ .gitlab-ci.yml Jenkinsfile .circleci/
```

### 1.2 Technology Stack Detection

```bash
# Language distribution
find . -type f -name "*.py" | wc -l
find . -type f -name "*.js" -o -name "*.ts" | wc -l
find . -type f -name "*.go" | wc -l
find . -type f -name "*.rs" | wc -l
find . -type f -name "*.sol" | wc -l

# Framework indicators
grep -r "from flask" --include="*.py" | head -1
grep -r "from django" --include="*.py" | head -1
grep -r "express\|fastify" --include="*.js" | head -1
grep -r "anchor_lang" --include="*.rs" | head -1
```

### 1.3 Dependency Analysis

```bash
# Python dependencies
cat requirements.txt pyproject.toml setup.py 2>/dev/null | grep -E "^\s*[a-zA-Z]"

# Node.js dependencies
cat package.json | jq '.dependencies, .devDependencies'

# Rust dependencies
cat Cargo.toml | grep -A 100 "\[dependencies\]"

# Go dependencies
cat go.mod | grep -E "^\s+[a-z]"
```

### 1.4 Create Technology Map

```markdown
## Technology Map: [PROJECT NAME]

### Languages
| Language | Files | Lines | Primary Use |
|----------|-------|-------|-------------|
| Python | 150 | 25K | Backend API |
| TypeScript | 80 | 12K | Frontend |
| Solidity | 12 | 2K | Smart Contracts |

### Key Dependencies
| Package | Version | Purpose | Security Notes |
|---------|---------|---------|----------------|
| fastapi | 0.100.0 | Web framework | Recent CVEs: None |
| web3.py | 6.0.0 | Blockchain client | Check signing |
| pyjwt | 2.8.0 | JWT handling | Verify alg checks |

### Infrastructure
- Database: PostgreSQL 15
- Cache: Redis 7
- Message Queue: RabbitMQ
- Container: Docker + K8s
```

## Phase 2: Architecture Mapping

### 2.1 Directory Structure Analysis

```bash
# Top-level structure
tree -L 2 -d

# Identify entry points
find . -name "main.py" -o -name "app.py" -o -name "index.ts" -o -name "main.go"

# Identify config
find . -name "config*" -o -name "settings*" -o -name ".env*"
```

### 2.2 Component Identification

Look for common patterns:

```
project/
├── api/           # HTTP endpoints
├── auth/          # Authentication
├── core/          # Business logic
├── db/            # Database layer
├── models/        # Data models
├── services/      # External services
├── utils/         # Utilities
├── workers/       # Background jobs
└── tests/         # Test suite
```

### 2.3 Create Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENTS                              │
│              (Web, Mobile, API Consumers)                   │
└─────────────────────────┬───────────────────────────────────┘
                          │ HTTPS
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                      API GATEWAY                            │
│                   (Rate Limiting, Auth)                     │
└─────────────────────────┬───────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
    ┌──────────┐   ┌──────────┐   ┌──────────┐
    │  Auth    │   │  Core    │   │  Admin   │
    │ Service  │   │  API     │   │  API     │
    └────┬─────┘   └────┬─────┘   └────┬─────┘
         │              │              │
         └──────────────┼──────────────┘
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
    ┌──────────┐  ┌──────────┐  ┌──────────┐
    │ Database │  │  Cache   │  │ External │
    │ (Postgres)│  │ (Redis)  │  │  APIs    │
    └──────────┘  └──────────┘  └──────────┘
```

### 2.4 Trust Boundary Identification

Map where trust levels change:

```markdown
## Trust Boundaries

### Boundary 1: Internet → API Gateway
- **Type:** Network boundary
- **Controls:** TLS, Rate limiting, WAF
- **Risks:** DDoS, Injection, Auth bypass

### Boundary 2: API Gateway → Services
- **Type:** Authentication boundary
- **Controls:** JWT validation, Role checks
- **Risks:** Token forgery, Privilege escalation

### Boundary 3: Services → Database
- **Type:** Data access boundary
- **Controls:** Query parameterization, Connection pooling
- **Risks:** SQL injection, Data leakage

### Boundary 4: Services → External APIs
- **Type:** Third-party integration
- **Controls:** API keys, Request signing
- **Risks:** SSRF, Secret exposure
```

## Phase 3: Module Deep Dive

### 3.1 Entry Point Analysis

For each entry point type:

```python
# HTTP Routes - map all endpoints
grep -rn "@app.route\|@router\|@api_view" --include="*.py"
grep -rn "app.(get|post|put|delete)\|router.(get|post)" --include="*.ts"

# CLI Commands
grep -rn "@click.command\|argparse\|clap" --include="*.py" --include="*.rs"

# Event Handlers
grep -rn "@consumer\|@handler\|on_message" --include="*.py"
```

### 3.2 Create Entry Point Map

```markdown
## Entry Points

### HTTP API
| Method | Path | Handler | Auth | Input |
|--------|------|---------|------|-------|
| POST | /api/login | auth.login | None | JSON body |
| GET | /api/users | users.list | JWT | Query params |
| POST | /api/transfer | tx.transfer | JWT + 2FA | JSON body |
| GET | /admin/logs | admin.logs | Admin JWT | Query params |

### WebSocket
| Event | Handler | Auth | Data |
|-------|---------|------|------|
| connect | ws.connect | JWT | None |
| message | ws.message | Session | JSON |

### Background Jobs
| Queue | Handler | Trigger | Data Source |
|-------|---------|---------|-------------|
| emails | email.send | API call | Database |
| reports | report.gen | Cron | Database |
```

### 3.3 Data Flow Tracing

For each critical endpoint, trace data flow:

```
POST /api/transfer
       │
       ▼
┌──────────────────┐
│ Request Parser   │ ← Validate JSON schema
│ (validation.py)  │
└────────┬─────────┘
         │ TransferRequest
         ▼
┌──────────────────┐
│ Auth Middleware  │ ← Verify JWT, extract user
│ (middleware.py)  │
└────────┬─────────┘
         │ User context
         ▼
┌──────────────────┐
│ Transfer Service │ ← Business logic
│ (transfer.py)    │
└────────┬─────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────┐
│ DB     │ │External│
│ Write  │ │ API    │
└────────┘ └────────┘
```

## Phase 4: Function-Level Analysis

### 4.1 Security-Critical Function Identification

Search for security-sensitive operations:

```bash
# Authentication
grep -rn "def login\|def authenticate\|def verify_token" --include="*.py"
grep -rn "function login\|authenticate\|verifyToken" --include="*.ts"

# Authorization
grep -rn "def is_authorized\|def check_permission\|@requires_role" --include="*.py"

# Cryptography
grep -rn "encrypt\|decrypt\|hash\|sign\|verify" --include="*.py"
grep -rn "crypto\.\|bcrypt\|argon2" --include="*.py"

# Database
grep -rn "execute\|query\|cursor" --include="*.py"
grep -rn "\.query\|\.execute\|\.raw" --include="*.ts"

# File Operations
grep -rn "open\(.*\)\|read\|write\|unlink" --include="*.py"
```

### 4.2 Function Documentation Template

For each critical function:

```markdown
### Function: `transfer_funds()`

**Location:** `services/transfer.py:45`

**Purpose:** Execute fund transfer between accounts

**Parameters:**
| Name | Type | Source | Validation |
|------|------|--------|------------|
| from_account | str | JWT claim | UUID format |
| to_account | str | Request body | UUID format, exists check |
| amount | Decimal | Request body | > 0, <= balance |

**Returns:** TransferResult

**Side Effects:**
- Writes to `transactions` table
- Calls external payment API
- Emits `transfer_completed` event

**Security Considerations:**
- Requires authenticated user
- Rate limited to 10/minute
- Amount validated against balance
- Audit logged

**Potential Risks:**
- Race condition if concurrent transfers?
- What if external API fails mid-transfer?
```

### 4.3 Call Graph Analysis

```
transfer_funds()
├── validate_request()
│   └── check_uuid_format()
├── get_user_balance()
│   └── db.query()
├── check_rate_limit()
│   └── redis.get()
├── execute_transfer()     ← CRITICAL
│   ├── db.begin_transaction()
│   ├── update_balance()   ← State change
│   ├── external_api.send() ← External call
│   └── db.commit()
└── emit_event()
```

## Phase 5: Detail Reconnaissance

### 5.1 Configuration Analysis

```bash
# Find all config loading
grep -rn "os.environ\|getenv\|config\." --include="*.py"
grep -rn "process.env\|config\." --include="*.ts"

# Check for hardcoded secrets
grep -rn "password\s*=\|secret\s*=\|api_key\s*=" --include="*.py"
grep -rn "-----BEGIN\|sk-\|pk_live_" .
```

### 5.2 Error Handling Review

```bash
# Find exception handling
grep -rn "except.*:" --include="*.py" -A 2
grep -rn "catch\s*(" --include="*.ts" -A 2

# Find error responses
grep -rn "return.*error\|raise.*Error" --include="*.py"
```

### 5.3 Logging Analysis

```bash
# Find logging statements
grep -rn "logger\.\|logging\.\|console\.log" --include="*.py" --include="*.ts"

# Check what's being logged
grep -rn "log.*password\|log.*token\|log.*secret" --include="*.py"
```

## Output: Context Document

### Template

```markdown
# [PROJECT NAME] - Security Context Document

## Executive Summary
[2-3 sentences on what this system does]

## Technology Stack
[From Phase 1]

## Architecture
[Diagram from Phase 2]

## Trust Boundaries
[From Phase 2.4]

## Entry Points
[Table from Phase 3.2]

## Critical Functions
[Analysis from Phase 4]

## Data Flows
[Diagrams from Phase 3.3]

## Security Controls
| Control | Implementation | Location | Notes |
|---------|----------------|----------|-------|
| Authentication | JWT | middleware/auth.py | RS256 signing |
| Authorization | RBAC | decorators/auth.py | Role-based |
| Input Validation | Pydantic | schemas/*.py | Type checking |
| Encryption | AES-256-GCM | utils/crypto.py | At-rest |

## Areas Requiring Focus
1. [High-risk area 1]
2. [High-risk area 2]
3. [High-risk area 3]

## Open Questions
- [ ] How is X handled when Y?
- [ ] What happens if Z fails?
```

## Quick Start Commands

```bash
# Full recon script
./scripts/recon.sh /path/to/project

# Generate entry point map
./scripts/map-endpoints.sh /path/to/project

# Create call graph
./scripts/callgraph.sh /path/to/project
```

## Skill Files

```
code-recon/
├── SKILL.md                        # This file
├── resources/
│   ├── recon-checklist.md          # Comprehensive checklist
│   └── question-bank.md            # Questions to answer
├── examples/
│   ├── web-app-recon/              # Web application example
│   └── smart-contract-recon/       # Smart contract example
├── templates/
│   └── context-document.md         # Output template
└── docs/
    └── advanced-techniques.md      # Deep dive techniques
```

## Guidelines

1. **Top-down approach** - Start broad, go narrow
2. **Document everything** - Your notes are the deliverable
3. **Question assumptions** - Verify what docs say vs. what code does
4. **Focus on trust boundaries** - That's where bugs live
5. **Time-box phases** - Don't get stuck in the weeds early
6. **Iterate** - Revisit earlier phases as you learn more

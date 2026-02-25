# CodeRecon Question Bank

Questions to answer during codebase reconnaissance. Organized by security domain.

## Architecture Questions

### System Design
- What is the overall architecture pattern? (monolith, microservices, serverless)
- How do components communicate? (HTTP, gRPC, message queue)
- What are the scaling characteristics?
- Is there a service mesh or API gateway?
- How is configuration managed across environments?

### Dependencies
- What are the critical path dependencies?
- Are there any single points of failure?
- What happens when external services are unavailable?
- How are dependency versions managed?
- When were dependencies last updated?

### Data Architecture
- What is the data model?
- Where is sensitive data stored?
- How is data backed up?
- What's the disaster recovery plan?
- Is data encrypted at rest and in transit?

## Authentication Questions

### Identity
- How are users identified? (username, email, phone, wallet)
- Is there a separate identity provider?
- How are service-to-service identities managed?
- What identity verification exists? (email, phone, KYC)

### Credentials
- How are passwords stored? (algorithm, salt, iteration count)
- Where are API keys stored?
- How are secrets rotated?
- What's the key management strategy?
- Are there default/hardcoded credentials?

### Sessions
- How are sessions created?
- Where are sessions stored?
- What's the session timeout?
- How are sessions invalidated?
- Can sessions be hijacked via XSS?

### Multi-Factor
- Is MFA available/required?
- What MFA methods are supported?
- Can MFA be bypassed?
- How is MFA recovery handled?

## Authorization Questions

### Access Control Model
- What authorization model is used? (RBAC, ABAC, ReBAC)
- Where are roles/permissions defined?
- How are permissions checked?
- Is authorization checked at every level?

### Object-Level
- Can users access other users' data?
- Are ownership checks consistent?
- What about soft-deleted data?
- Are there timing attacks on authorization?

### Function-Level
- Are admin functions properly protected?
- Are there hidden/undocumented endpoints?
- What about debug/test endpoints?
- Are internal APIs protected?

### Escalation
- Can users modify their own roles?
- What prevents privilege escalation?
- How are role changes audited?
- Are there race conditions in permission checks?

## Input Handling Questions

### Validation
- Where is input validated?
- Is validation allowlist or blocklist?
- Are all input sources validated?
- What happens on validation failure?

### Data Types
- How are numbers validated? (overflow, negative, precision)
- How are strings validated? (length, encoding, special chars)
- How are dates validated? (timezone, range, format)
- How are files validated? (type, size, content)

### Injection Vectors
- SQL: Are all queries parameterized?
- Command: Are all shell commands escaped?
- XSS: Is all output encoded?
- Path: Are all file paths validated?
- Template: Is user input in templates?

## Cryptography Questions

### Algorithms
- What encryption algorithms are used?
- What hashing algorithms are used?
- Are there any deprecated algorithms? (MD5, SHA1, DES)
- Is there custom cryptography?

### Keys
- How are encryption keys generated?
- Where are keys stored?
- How are keys rotated?
- Who has access to keys?

### Implementation
- Is crypto library well-maintained?
- Are IVs/nonces properly generated?
- Is timing-safe comparison used?
- Are there padding oracle possibilities?

### TLS
- What TLS version is supported?
- Are cipher suites properly configured?
- Is certificate validation enforced?
- Is certificate pinning used?

## Business Logic Questions

### Critical Operations
- What are the most sensitive operations?
- What are the financial operations?
- What are the destructive operations?
- Are these operations properly protected?

### Race Conditions
- What operations should be atomic?
- What concurrent access is possible?
- Are there check-then-act patterns?
- How is distributed state managed?

### State Management
- What state machines exist?
- Are state transitions validated?
- Can states be skipped or repeated?
- Is state modification atomic?

### Limits
- What rate limits exist?
- What resource limits exist?
- Can limits be bypassed?
- Are limits enforced consistently?

## Error Handling Questions

### Information Disclosure
- What do error messages reveal?
- Are stack traces exposed?
- Do errors reveal timing information?
- Are internal errors exposed externally?

### Recovery
- What happens on failure?
- Are failures logged?
- Is there graceful degradation?
- Are failed operations retried?

### Edge Cases
- What about empty inputs?
- What about boundary values?
- What about malformed inputs?
- What about concurrent failures?

## Logging & Monitoring Questions

### Logging
- What events are logged?
- Are security events logged?
- Is sensitive data logged?
- Can logs be tampered with?

### Audit
- What operations are audited?
- Can audit logs be bypassed?
- How long are audits retained?
- Who can access audit logs?

### Alerting
- What triggers alerts?
- How quickly are alerts generated?
- Are alerts actionable?
- Can alerts be suppressed?

## Smart Contract Questions

(If applicable)

### Access Control
- Who can call privileged functions?
- Can ownership be transferred?
- Are there admin backdoors?
- Is there an upgrade mechanism?

### Economic
- Are there flash loan vulnerabilities?
- Is there MEV exposure?
- Are oracle prices manipulable?
- Is there economic attack surface?

### State
- Is state consistent across calls?
- Are there reentrancy risks?
- Is there proper ordering of operations?
- Are there storage collision risks?

## External Integration Questions

### Third-Party APIs
- What external APIs are called?
- How is API authentication handled?
- What data is sent to external services?
- What happens if external services fail?

### Webhooks
- Are incoming webhooks validated?
- Are webhook secrets properly handled?
- What access do webhooks grant?
- Are webhooks rate limited?

### SSRF
- Can users control URLs?
- Is URL validation implemented?
- Are internal resources protected?
- Is DNS rebinding prevented?

## Quick Assessment Template

After answering key questions, summarize:

```markdown
## Security Assessment Summary

### Strengths
1. [What's done well]
2. [What's done well]
3. [What's done well]

### Weaknesses
1. [What needs attention]
2. [What needs attention]
3. [What needs attention]

### Unknowns
1. [What needs investigation]
2. [What needs investigation]
3. [What needs investigation]

### Priority Areas
1. [Most important to test]
2. [Second priority]
3. [Third priority]
```

# CodeRecon Checklist

Comprehensive checklist for codebase reconnaissance. Copy and use during audits.

## Phase 1: Overview

### Project Basics
- [ ] Read README.md thoroughly
- [ ] Check SECURITY.md / SECURITY.txt
- [ ] Review CHANGELOG for recent security changes
- [ ] Identify project license
- [ ] Note project maturity (version, age, activity)

### Documentation
- [ ] Architecture documentation exists?
- [ ] API documentation available?
- [ ] Deployment documentation present?
- [ ] Security documentation/threat model?

### Build & Deploy
- [ ] Identify build system
- [ ] Review CI/CD configuration
- [ ] Check for automated security scanning
- [ ] Review deployment scripts
- [ ] Note environment configurations

## Phase 2: Technology Stack

### Languages & Frameworks
- [ ] Primary language identified
- [ ] Web framework identified
- [ ] Database ORM/driver identified
- [ ] Frontend framework (if applicable)
- [ ] Smart contract framework (if applicable)

### Dependencies
- [ ] Lock file present (package-lock.json, Cargo.lock, etc.)
- [ ] Review direct dependencies
- [ ] Check for known vulnerable versions
- [ ] Note cryptographic libraries used
- [ ] Identify authentication libraries

### Infrastructure
- [ ] Database type identified
- [ ] Cache system identified
- [ ] Message queue identified
- [ ] External services listed
- [ ] Cloud provider identified

## Phase 3: Architecture

### Component Structure
- [ ] Map directory structure
- [ ] Identify main entry points
- [ ] Locate configuration loading
- [ ] Find middleware/interceptors
- [ ] Map service boundaries

### Trust Boundaries
- [ ] Network boundaries identified
- [ ] Authentication boundaries mapped
- [ ] Authorization boundaries mapped
- [ ] Data access boundaries noted
- [ ] Third-party integration points

### Data Stores
- [ ] Primary database schema understood
- [ ] Sensitive data locations identified
- [ ] Encryption at rest status
- [ ] Backup/export mechanisms
- [ ] Cache data sensitivity

## Phase 4: Entry Points

### HTTP/API
- [ ] All routes enumerated
- [ ] Authentication requirements per route
- [ ] Rate limiting configuration
- [ ] Input validation mechanisms
- [ ] Response format/headers

### Other Entry Points
- [ ] CLI commands documented
- [ ] Background job triggers
- [ ] WebSocket handlers
- [ ] Message queue consumers
- [ ] Scheduled tasks

### Input Sources
- [ ] Query parameters
- [ ] Request body (JSON, form, multipart)
- [ ] Headers (custom, auth)
- [ ] Cookies
- [ ] File uploads
- [ ] URL path parameters

## Phase 5: Authentication & Authorization

### Authentication
- [ ] Auth mechanism identified (JWT, Session, API Key)
- [ ] Token/session lifecycle understood
- [ ] Password storage mechanism
- [ ] MFA implementation (if present)
- [ ] OAuth/OIDC flows (if present)
- [ ] Password reset flow
- [ ] Account lockout policy

### Authorization
- [ ] Authorization model (RBAC, ABAC, ACL)
- [ ] Role definitions located
- [ ] Permission checks implementation
- [ ] Object-level authorization
- [ ] Function-level authorization

### Session Management
- [ ] Session storage mechanism
- [ ] Session timeout configuration
- [ ] Session invalidation on logout
- [ ] Concurrent session handling
- [ ] Session fixation prevention

## Phase 6: Data Flow

### Sensitive Data
- [ ] PII data locations identified
- [ ] Credentials/secrets handling
- [ ] Financial data flows
- [ ] Authentication tokens
- [ ] API keys/secrets

### Data Processing
- [ ] Input validation points
- [ ] Data transformation logic
- [ ] Output encoding/escaping
- [ ] Sanitization functions
- [ ] Serialization/deserialization

### External Communications
- [ ] Outbound HTTP requests
- [ ] Database queries
- [ ] Message queue operations
- [ ] File system operations
- [ ] External API calls

## Phase 7: Security Controls

### Input Validation
- [ ] Schema validation present
- [ ] Type checking implemented
- [ ] Length/size limits enforced
- [ ] Format validation (regex, etc.)
- [ ] Business logic validation

### Output Handling
- [ ] HTML encoding (XSS prevention)
- [ ] SQL parameterization
- [ ] Command escaping
- [ ] Path sanitization
- [ ] Header injection prevention

### Cryptography
- [ ] Encryption algorithms identified
- [ ] Key management mechanism
- [ ] Hashing algorithms used
- [ ] Random number generation
- [ ] TLS configuration

### Error Handling
- [ ] Exception handling patterns
- [ ] Error message content
- [ ] Error logging practices
- [ ] Fallback behaviors
- [ ] Graceful degradation

## Phase 8: Logging & Monitoring

### Logging
- [ ] Logging framework identified
- [ ] Log levels configured
- [ ] Sensitive data in logs?
- [ ] Security events logged
- [ ] Audit trail implementation

### Monitoring
- [ ] Health check endpoints
- [ ] Metrics collection
- [ ] Alerting configuration
- [ ] Rate limit monitoring
- [ ] Error rate tracking

## Quick Assessment Questions

After completing the checklist, answer these questions:

1. **Attack Surface Size**
   - How many entry points exist?
   - How many trust boundaries?
   - How much user-controlled data?

2. **Security Maturity**
   - Are security controls consistently applied?
   - Is there evidence of security testing?
   - Are dependencies up to date?

3. **High-Risk Areas**
   - Where is the most sensitive data?
   - What are the most complex flows?
   - Where are the newest/least-tested features?

4. **Testing Priorities**
   - Which entry points are highest risk?
   - What security controls need verification?
   - What assumptions need validation?

## Recon Completion Criteria

You're ready to proceed when you can answer:

- [ ] What does this system do? (1-2 sentences)
- [ ] What's the tech stack? (languages, frameworks, infrastructure)
- [ ] Where does data come in? (all entry points)
- [ ] Where does data go? (all outputs/sinks)
- [ ] What are the trust boundaries?
- [ ] What security controls exist?
- [ ] What are the highest-risk areas?

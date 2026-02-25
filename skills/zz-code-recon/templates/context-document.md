# Security Context Document Template

## Project: [PROJECT NAME]

**Document Version:** 1.0
**Date:** [DATE]
**Analyst:** [NAME]

---

## 1. Executive Summary

[2-3 sentences describing what the system does and its primary security considerations]

---

## 2. Technology Stack

### Languages
| Language | Version | Usage | Notes |
|----------|---------|-------|-------|
| | | | |

### Frameworks
| Framework | Version | Purpose | Security Notes |
|-----------|---------|---------|----------------|
| | | | |

### Dependencies (Security-Critical)
| Package | Version | Purpose | Known Issues |
|---------|---------|---------|--------------|
| | | | |

### Infrastructure
| Component | Technology | Location | Notes |
|-----------|------------|----------|-------|
| Database | | | |
| Cache | | | |
| Queue | | | |
| Storage | | | |

---

## 3. Architecture

### System Diagram
```
[ASCII architecture diagram]
```

### Component Description
| Component | Purpose | Entry Points | Data Handled |
|-----------|---------|--------------|--------------|
| | | | |

### Data Flow Summary
```
[Key data flow diagram]
```

---

## 4. Trust Boundaries

### Boundary Map
```
[Trust boundary diagram]
```

### Boundary Details
| Boundary | From | To | Controls | Risks |
|----------|------|-----|----------|-------|
| B1 | Internet | Gateway | TLS, Rate limit | DDoS, Injection |
| B2 | Gateway | Services | JWT Auth | Token forgery |
| | | | | |

---

## 5. Entry Points

### HTTP/API Endpoints
| Method | Path | Auth | Input Sources | Handler |
|--------|------|------|---------------|---------|
| | | | | |

### Other Entry Points
| Type | Identifier | Auth | Input | Handler |
|------|------------|------|-------|---------|
| WebSocket | | | | |
| CLI | | | | |
| Queue | | | | |
| Cron | | | | |

---

## 6. Authentication

### Mechanism
- **Type:** [JWT / Session / API Key / etc.]
- **Implementation:** [Location/files]
- **Token Storage:** [Where stored client-side]
- **Token Lifetime:** [Expiration]

### Flows
| Flow | Endpoint | Steps | Notes |
|------|----------|-------|-------|
| Login | | | |
| Logout | | | |
| Refresh | | | |
| Reset | | | |

### Security Controls
- [ ] Secure password storage
- [ ] Token expiration
- [ ] Rate limiting
- [ ] Account lockout
- [ ] MFA support

---

## 7. Authorization

### Model
- **Type:** [RBAC / ABAC / ACL]
- **Implementation:** [Location/files]

### Roles
| Role | Permissions | Assignment |
|------|-------------|------------|
| | | |

### Enforcement Points
| Location | Check Type | Notes |
|----------|------------|-------|
| | | |

---

## 8. Data Handling

### Sensitive Data
| Data Type | Location | Protection | Notes |
|-----------|----------|------------|-------|
| Credentials | | | |
| PII | | | |
| Financial | | | |
| Tokens | | | |

### Input Validation
| Input Source | Validation | Library/Method |
|--------------|------------|----------------|
| | | |

### Output Encoding
| Output Context | Encoding | Library/Method |
|----------------|----------|----------------|
| HTML | | |
| JSON | | |
| SQL | | |
| Command | | |

---

## 9. Cryptography

### Usage
| Purpose | Algorithm | Key Location | Notes |
|---------|-----------|--------------|-------|
| Password hash | | | |
| Token signing | | | |
| Data encryption | | | |
| TLS | | | |

### Key Management
- **Generation:** [How keys are generated]
- **Storage:** [Where keys are stored]
- **Rotation:** [Rotation policy]

---

## 10. Critical Functions

### Function: [NAME]
- **Location:** `path/file:line`
- **Purpose:** [Description]
- **Security Notes:** [Considerations]

### Function: [NAME]
- **Location:** `path/file:line`
- **Purpose:** [Description]
- **Security Notes:** [Considerations]

[Repeat for all security-critical functions]

---

## 11. Security Controls Summary

| Control | Status | Implementation | Notes |
|---------|--------|----------------|-------|
| Authentication | | | |
| Authorization | | | |
| Input Validation | | | |
| Output Encoding | | | |
| Encryption (transit) | | | |
| Encryption (rest) | | | |
| Rate Limiting | | | |
| Logging | | | |
| Error Handling | | | |

---

## 12. Testing Coverage

### Security Testing
| Test Type | Coverage | Tool/Method | Last Run |
|-----------|----------|-------------|----------|
| SAST | | | |
| DAST | | | |
| Dependency Scan | | | |
| Penetration Test | | | |

### Unit Tests
- **Coverage:** [%]
- **Security Tests:** [Count/Description]

---

## 13. High-Risk Areas

### Risk 1: [Title]
- **Location:** [Files/Components]
- **Concern:** [Why this is high risk]
- **Recommendation:** [What to focus on]

### Risk 2: [Title]
- **Location:** [Files/Components]
- **Concern:** [Why this is high risk]
- **Recommendation:** [What to focus on]

### Risk 3: [Title]
- **Location:** [Files/Components]
- **Concern:** [Why this is high risk]
- **Recommendation:** [What to focus on]

---

## 14. Open Questions

- [ ] [Question 1 that needs investigation]
- [ ] [Question 2 that needs investigation]
- [ ] [Question 3 that needs investigation]

---

## 15. Recommendations

### Immediate Actions
1. [Most urgent recommendation]
2. [Second priority]
3. [Third priority]

### Future Improvements
1. [Longer-term improvement]
2. [Longer-term improvement]

---

## Appendix A: File Index

| File/Directory | Purpose | Security Relevance |
|----------------|---------|-------------------|
| | | |

## Appendix B: External Resources

- [Link to official documentation]
- [Link to relevant security advisories]
- [Link to related audits/reports]

---

**Document End**

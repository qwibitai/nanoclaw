# Variant Analysis Report Template

## Engagement Information

| Field | Value |
|-------|-------|
| Project | [PROJECT_NAME] |
| Date | [DATE] |
| Analyst | [ANALYST_NAME] |
| Original Finding | [FINDING_ID] |

---

## Original Vulnerability

### Summary
[Brief description of the original finding]

### Location
```
File: [path/to/file.ext]
Line: [LINE_NUMBER]
Function: [function_name]
```

### Code Snippet
```[language]
// Original vulnerable code
```

### Root Cause Analysis
[Explain WHY this vulnerability exists - the underlying pattern or mistake]

### Impact
[What can an attacker achieve by exploiting this?]

---

## Pattern Extraction

### Abstract Pattern
```
SOURCE: [Where does attacker-controlled data enter?]
   ↓
TRANSFORM: [How is data processed?]
   ↓
SINK: [Where does data cause harm?]

MISSING: [What validation/sanitization is absent?]
```

### Search Pattern

**Regex:**
```
[regex pattern]
```

**Semgrep Rule (if applicable):**
```yaml
rules:
  - id: variant-[finding-id]
    patterns:
      - pattern: |
          [pattern]
    message: "[message]"
    languages: [[languages]]
    severity: [severity]
```

---

## Variant Discovery Results

### Search Methodology
1. [Search method 1 - e.g., grep for pattern X]
2. [Search method 2 - e.g., Semgrep rule scan]
3. [Search method 3 - e.g., Manual review of module Y]

### Raw Matches
```
[tool output showing all matches]
```

### Validated Variants

#### Variant 1: [Short Description]

| Attribute | Value |
|-----------|-------|
| File | `path/to/file.ext` |
| Line | [LINE] |
| Severity | [Critical/High/Medium/Low] |
| Status | [Confirmed/Suspected/False Positive] |

**Code:**
```[language]
// Variant code
```

**Analysis:**
[Why this is a true positive - explain the data flow and exploitability]

---

#### Variant 2: [Short Description]

| Attribute | Value |
|-----------|-------|
| File | `path/to/file2.ext` |
| Line | [LINE] |
| Severity | [Critical/High/Medium/Low] |
| Status | [Confirmed/Suspected/False Positive] |

**Code:**
```[language]
// Variant code
```

**Analysis:**
[Why this is a true positive]

---

### False Positives

| Location | Reason for FP |
|----------|---------------|
| `file.ext:123` | [Why this match is not vulnerable] |
| `file2.ext:456` | [Why this match is not vulnerable] |

---

## Summary

### Statistics

| Category | Count |
|----------|-------|
| Total Matches | [N] |
| Confirmed Variants | [N] |
| Suspected (needs review) | [N] |
| False Positives | [N] |

### Severity Distribution

| Severity | Count |
|----------|-------|
| Critical | [N] |
| High | [N] |
| Medium | [N] |
| Low | [N] |

---

## Remediation

### Systemic Fix
[Recommend an architectural or framework-level fix that addresses all variants]

### Individual Fixes
[If no systemic fix is possible, provide specific fix guidance for each variant]

### Prevention
[How to prevent this class of vulnerability in future development]

---

## Appendix

### All Findings Table

| # | Location | Severity | Status | Description |
|---|----------|----------|--------|-------------|
| 1 | `file1.ext:100` | High | Confirmed | [Brief desc] |
| 2 | `file2.ext:200` | Medium | Confirmed | [Brief desc] |
| 3 | `file3.ext:300` | Low | Suspected | [Brief desc] |

### Search Commands Used

```bash
# Command 1
[command]

# Command 2
[command]
```

### References
- [Link to original finding/ticket]
- [Relevant documentation]
- [Related CVEs or security advisories]

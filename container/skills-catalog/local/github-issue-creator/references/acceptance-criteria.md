# GitHub Issue Creator Acceptance Criteria

**Skill**: `github-issue-creator`
**Purpose**: Transform raw notes, error logs, voice dictation, or screenshots into structured GitHub issues
**Focus**: Issue format, structured sections, appropriate severity classification

---

## 1. Issue Structure

### 1.1 ✅ CORRECT: Complete Issue Template

```markdown
## Summary
[One-line description of the issue]

## Environment
- **Product/Service**: [Name of product]
- **Region/Version**: [Version or region]
- **Browser/OS**: [If relevant]

## Reproduction Steps
1. [Step 1]
2. [Step 2]
3. [Step 3]

## Expected Behavior
[What should happen]

## Actual Behavior
[What actually happens]

## Error Details
```
[Error message/code if applicable]
```

## Visual Evidence
[Reference to attached screenshots/GIFs]

## Impact
[Severity: Critical/High/Medium/Low + brief explanation]

## Additional Context
[Any other relevant details]
```

### 1.2 ✅ CORRECT: Minimal Bug Report

```markdown
## Summary
404 error when accessing user profile page

## Reproduction Steps
1. Login to application
2. Click on "Profile" in navigation
3. Observe error

## Expected Behavior
User profile page loads successfully

## Actual Behavior
Returns 404 Not Found error

## Impact
**High** - Users cannot access their profile
```

### 1.3 ❌ INCORRECT: Missing Required Sections

```markdown
# Bug Report

There's a bug in the app where clicking profile doesn't work.
Please fix.
```

### 1.4 ❌ INCORRECT: Vague Description

```markdown
## Summary
Something is broken

## Reproduction Steps
1. Use the app
2. It breaks
```

---

## 2. Summary Section

### 2.1 ✅ CORRECT: Clear, Specific Summaries

```markdown
## Summary
Agent deployment fails silently - no error displayed, agent disappears from list
```

```markdown
## Summary
403 PERMISSION_DENIED error when publishing to Teams channel
```

```markdown
## Summary
API response time degrades to 30+ seconds after 1000 concurrent users
```

### 2.2 ❌ INCORRECT: Vague Summaries

```markdown
## Summary
It doesn't work
```

```markdown
## Summary
Bug
```

```markdown
## Summary
Please help
```

---

## 3. Reproduction Steps

### 3.1 ✅ CORRECT: Clear, Numbered Steps

```markdown
## Reproduction Steps
1. Navigate to Azure Portal > AI Foundry
2. Click "Create new agent"
3. Configure agent with name "test-agent"
4. Click "Deploy"
5. Wait for deployment to complete
6. Check agent list
```

### 3.2 ✅ CORRECT: Steps with Expected Results

```markdown
## Reproduction Steps
1. POST to `/api/agents` with valid payload → Should return 201
2. GET `/api/agents/{id}` → Should return agent details
3. DELETE `/api/agents/{id}` → Returns 500 instead of 204
```

### 3.3 ❌ INCORRECT: Unclear Steps

```markdown
## Reproduction Steps
- Try to do the thing
- It doesn't work
```

### 3.4 ❌ INCORRECT: Missing Prerequisites

```markdown
## Reproduction Steps
1. Click deploy
2. See error
```

---

## 4. Impact/Severity Classification

### 4.1 ✅ CORRECT: Severity with Justification

```markdown
## Impact
**Critical** - Production service down, affecting all customers in West US region
```

```markdown
## Impact
**High** - Users cannot complete checkout, no workaround available
```

```markdown
## Impact
**Medium** - Feature partially working, users can use alternative endpoint
```

```markdown
## Impact
**Low** - Minor UI alignment issue on mobile, no functional impact
```

### 4.2 Severity Guidelines

| Severity | Definition |
|----------|------------|
| Critical | Service down, data loss, security issue |
| High | Major feature broken, no workaround |
| Medium | Feature impaired, workaround exists |
| Low | Minor inconvenience, cosmetic |

### 4.3 ❌ INCORRECT: No Severity Classification

```markdown
## Impact
This is bad.
```

### 4.4 ❌ INCORRECT: Wrong Severity Level

```markdown
## Impact
**Critical** - Button color is slightly off
```

---

## 5. Error Details

### 5.1 ✅ CORRECT: Formatted Error Messages

```markdown
## Error Details
```
Error: PERMISSION_DENIED
Code: 403
RequestId: abc-123-def-456
Timestamp: 2024-01-15T10:30:00Z
```
```

### 5.2 ✅ CORRECT: Stack Trace

```markdown
## Error Details
```python
Traceback (most recent call last):
  File "agent.py", line 42, in create_agent
    response = client.agents.create(...)
azure.core.exceptions.HttpResponseError: (403) Permission denied
```
```

### 5.3 ❌ INCORRECT: No Formatting

```markdown
## Error Details
Error: PERMISSION_DENIED Code: 403 RequestId: abc-123
```

---

## 6. Visual Evidence

### 6.1 ✅ CORRECT: Inline Image References

```markdown
## Visual Evidence
![Error dialog showing 403 permission denied](error-screenshot.png)

![Network tab showing failed request](network-tab.gif)
```

### 6.2 ✅ CORRECT: Descriptive References

```markdown
## Visual Evidence
- Screenshot: Error message displayed after clicking Deploy
- GIF: Full reproduction showing the steps and error
```

### 6.3 ❌ INCORRECT: No Alt Text

```markdown
## Visual Evidence
![](image.png)
```

---

## 7. Environment Section

### 7.1 ✅ CORRECT: Complete Environment Info

```markdown
## Environment
- **Product/Service**: Azure AI Foundry
- **Region/Version**: westus2 / v2.1.0
- **Browser/OS**: Chrome 120 / macOS 14.2
- **SDK Version**: azure-ai-agents 1.0.0b1
```

### 7.2 ✅ CORRECT: Minimal but Relevant

```markdown
## Environment
- **Product/Service**: Copilot Studio → Teams integration
- **Region/Version**: Production / US region
```

### 7.3 ❌ INCORRECT: Missing Environment

```markdown
## Environment
Unknown
```

---

## 8. Sensitive Data Handling

### 8.1 ✅ CORRECT: Placeholder for Sensitive Data

```markdown
## Error Details
```
User ID: [USER_ID]
API Key: [REDACTED]
Project: [PROJECT_NAME]
```
```

### 8.2 ✅ CORRECT: Anonymized Examples

```markdown
## Reproduction Steps
1. Login as user `test@[DOMAIN].com`
2. Access project `[PROJECT_NAME]`
```

### 8.3 ❌ INCORRECT: Exposed Sensitive Data

```markdown
## Error Details
API Key: sk-1234567890abcdef
User Email: john.doe@company.com
```

---

## 9. File Naming Convention

### 9.1 ✅ CORRECT: Descriptive File Names

```
issues/
├── 2024-01-15-agent-deployment-fails-silently.md
├── 2024-01-16-teams-permission-denied.md
└── 2024-01-17-api-timeout-high-load.md
```

### 9.2 ❌ INCORRECT: Generic File Names

```
issues/
├── bug.md
├── issue.md
└── problem.md
```

---

## 10. Transformation Examples

### 10.1 ✅ CORRECT: Voice Dictation Transformation

**Input:**
> so I was trying to deploy the agent and it just failed silently no error nothing the workflow ran but then poof gone from the list had to refresh and try again three times

**Output:**
```markdown
## Summary
Agent deployment fails silently - no error displayed, agent disappears from list

## Environment
- **Product/Service**: Azure AI Foundry
- **Region/Version**: [REGION]

## Reproduction Steps
1. Navigate to agent deployment
2. Configure and deploy agent
3. Observe workflow completes
4. Check agent list

## Expected Behavior
Agent appears in list with deployment status, errors shown if deployment fails

## Actual Behavior
Agent disappears from list. No error message. Requires page refresh and retry.

## Impact
**High** - Blocks agent deployment workflow, no feedback on failure cause

## Additional Context
Required 3 retry attempts before successful deployment
```

### 10.2 ✅ CORRECT: Error Log Transformation

**Input:**
> Error: PERMISSION_DENIED when publishing to Teams channel. Code: 403. Was working yesterday.

**Output:**
```markdown
## Summary
403 PERMISSION_DENIED error when publishing to Teams channel

## Environment
- **Product/Service**: Copilot Studio → Teams integration
- **Region/Version**: [REGION]

## Reproduction Steps
1. Configure agent for Teams channel
2. Attempt to publish

## Expected Behavior
Agent publishes successfully to Teams channel

## Actual Behavior
Returns `PERMISSION_DENIED` with code 403

## Error Details
```
Error: PERMISSION_DENIED
Code: 403
```

## Impact
**High** - Blocks Teams integration, regression from previous working state

## Additional Context
Was working yesterday - possible permission/config change or service regression
```

---

## 11. Anti-Patterns Summary

| Anti-Pattern | Impact | Fix |
|--------------|--------|-----|
| Vague summary | Hard to triage | Be specific about what failed |
| Missing repro steps | Can't reproduce | Number each step clearly |
| No severity | Hard to prioritize | Add Impact section with severity |
| Exposed secrets | Security risk | Use [PLACEHOLDER] syntax |
| Unformatted errors | Hard to read | Use code blocks |
| Generic file names | Hard to find | Use `YYYY-MM-DD-description.md` |

---

## 12. Checklist for Issue Creation

- [ ] Summary is one clear sentence describing the problem
- [ ] Environment section includes relevant product/service info
- [ ] Reproduction steps are numbered and clear
- [ ] Expected vs Actual behavior clearly stated
- [ ] Error details in code blocks with proper formatting
- [ ] Screenshots/GIFs referenced with descriptive alt text
- [ ] Impact includes severity (Critical/High/Medium/Low) with justification
- [ ] No sensitive data exposed (use placeholders)
- [ ] File saved with `YYYY-MM-DD-description.md` naming convention

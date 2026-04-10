---
name: health-check
description: Check current session health and get recommendations for session management
user-invocable: true
---

# Health Check Command

Use this command to check the current session health and get recommendations for session management.

## Usage

```
/health-check
```

## Description

This command provides:

- Current message count and session status
- Memory usage assessment
- Recommendations for session optimization
- Suggestions for when to start a new session

## Health Status Indicators

- **Green**: Session is healthy, continue working
- **Yellow**: Session is approaching limits, consider wrapping up current task
- **Red**: Session should be concluded, create handover document

## Example Output

```
Session Health: 🟡 Yellow
Messages: 42/50
Recommendation: Complete current task and create handover
```

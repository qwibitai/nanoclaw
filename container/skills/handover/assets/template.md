# Session Handover Document

**Generated**: {{TIMESTAMP}}
**Session ID**: {{SESSION_ID}}

## Session Summary

### Health Status
- **Current Status**: {{HEALTH_STATUS}}
- **Message Count**: {{MESSAGE_COUNT}}/50
- **Recommendation**: {{HEALTH_RECOMMENDATION}}

### Operating Context
- **Mode**: {{CURRENT_MODE}}
- **Scope**: {{CURRENT_SCOPE}}
- **Branch**: {{GIT_BRANCH}}

## Task Progress

### Current Task
- **JIRA ID**: {{JIRA_ID}}
- **Title**: {{TASK_TITLE}}
- **Phase**: {{CURRENT_PHASE}}
- **Progress**: {{PROGRESS}}%

### Completed Items
{{COMPLETED_TODOS}}

### In Progress
{{IN_PROGRESS_TODOS}}

### Pending Items
{{PENDING_TODOS}}

## Technical Context

### Current Working Files
- **Last File**: {{CURRENT_FILE}}
- **Last Function**: {{CURRENT_FUNCTION}}
- **Last Command**: {{LAST_COMMAND}}

### Code Changes This Session
- See: `claude_changes_{{SESSION_DATE}}.txt`
- Key changes:
{{KEY_CHANGES_SUMMARY}}

## To Resume This Session

1. **Load Session State**
   ```
   Check .claude/session/current-session.yaml
   ```

2. **Verify Git Branch**
   ```bash
   git checkout {{GIT_BRANCH}}
   git status
   ```

3. **Continue From**
   - File: {{RESUME_FILE}}
   - Task: {{RESUME_TASK}}
   - Next steps: {{NEXT_STEPS}}

## Important Notes
{{SESSION_NOTES}}

## Blockers/Issues
{{BLOCKERS_IF_ANY}}

---
*This handover was generated to ensure seamless continuation in a new conversation.*

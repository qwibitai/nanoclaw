---
name: workflow-steps
description: Report step-by-step progress for multi-step workflows. Use when executing a workflow with numbered steps, or when you plan and execute a multi-step task.
---

# Workflow Step Progress

When executing multi-step work, report progress after each step using the `send_message` tool with this format:

```
[STEP:1/4:done] Pulled latest from main
[STEP:2/4:running] Running test suite
[STEP:3/4:pending] Push to production
[STEP:4/4:pending] Report deploy status
```

## Format

`[STEP:{current}/{total}:{status}] {description}`

**Statuses:** `pending`, `running`, `done`, `failed`

## Rules

- Send ALL steps in every progress update (not just the current one)
- Mark completed steps as `done`, current step as `running`, future steps as `pending`
- On failure: mark the step as `failed`, stop execution, describe the error
- Send progress via `send_message` after each step completes
- You can include additional text after the step block — it renders as normal chat

## Example: Success

```
[STEP:1/3:done] Cloned repository
[STEP:2/3:done] Tests passed (142/142)
[STEP:3/3:running] Creating pull request
```

## Example: Failure

```
[STEP:1/3:done] Cloned repository
[STEP:2/3:failed] Tests failed: 3 errors in auth module
[STEP:3/3:pending] Create pull request

Test failures:
- test_login_redirect: AssertionError
- test_token_refresh: TimeoutError
- test_logout: 404 response
```

## Agent-Planned Workflows

When a user gives you a complex task without predefined steps, you can plan your own steps and report them the same way. Create your step list, then report progress as you execute.

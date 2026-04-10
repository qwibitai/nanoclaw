---
name: add-codex-agent
description: Add or maintain a Codex-backed coding-agent path in this NanoClaw fork so the main control group can trigger host-side Codex work for coding tasks.
---

# Add Codex Agent

Use this skill when the user wants NanoClaw to spawn Codex for coding work.

## What This Skill Enables

- Adds a host-side Codex execution path to the NanoClaw message loop
- Keeps Codex execution outside the normal container worker when appropriate
- Documents the expected trigger command and runtime behavior

## Recommended Trigger

Use a main-group command such as:

```text
/codex fix the failing dashboard route
```

## Workflow

1. Verify the host has the `codex` CLI installed and logged in.
2. Keep Codex spawning on the host side, not inside the normal chat-model worker, unless there is a strong reason to containerize it.
3. Restrict Codex execution to trusted contexts such as the main group.
4. Return Codex’s final response back into the chat after completion.
5. Run typecheck/tests after changes.

## Constraints

- Do not hardcode authentication.
- Do not expose Codex execution broadly without an explicit trigger.
- If Codex is not installed or not logged in, surface a clear error back to the user.

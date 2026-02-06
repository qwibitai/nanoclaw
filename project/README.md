# Agent Working Directory

This is the agent's sandboxed working directory inside containers.

**Container path:** `/project/`  
**Host path:** `~/nanoclaw/project/`

Use this directory for:
- User-requested code generation
- File creation and experiments
- Any work that doesn't involve NanoClaw system files

The agent cannot access NanoClaw source code from here - only system data, groups, and skills.

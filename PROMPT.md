# Claude Code Prompt Templates

## Fix Bug

Task: Fix bug

File:
<file>

Function:
<function>

Error:
<error>

Instructions:
Follow AI_CONTEXT.md and AI_RULES.md
Return unified diff only


---

## Implement Feature

Task: Implement feature

File:
<file>

Feature:
<description>

Constraints:
- max 60 lines
- minimal dependencies

Instructions:
Follow AI_CONTEXT.md and AI_RULES.md
Return code only


---

## Refactor

Task: Refactor

File:
<file>

Goal:
<goal>

Instructions:
Follow AI_CONTEXT.md and AI_RULES.md
Return unified diff
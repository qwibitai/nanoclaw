# Skill Authoring Guide

NanoClaw uses skills to keep optional capabilities out of the core repo.

## When A Change Should Be A Skill

Prefer a skill when the change adds:

- a new channel
- a new external integration
- a workflow that only some forks need
- repo-specific policies or personas
- extra UI or notification behavior

Prefer a core change when the work improves:

- correctness
- security
- deploy safety
- observability
- scheduler reliability
- session lifecycle handling

## What A Good Skill Should Do

- Explain the exact repo transformation Claude should make.
- State dependencies, new files, and environment variables clearly.
- Keep the target fork coherent after the change is applied.
- Include validation steps the skill should run after editing.

## Recommended Structure

1. State the feature and the expected user-visible behavior.
2. Define which files should be created or modified.
3. Define required dependencies and configuration.
4. Define post-change validation commands.
5. Define rollback guidance when the change conflicts with local customizations.

## Validation Checklist

- Run the skill against a fresh clone.
- Run the repo validation commands it changes.
- Verify the skill does not silently expand core scope beyond the intended feature.
- Document whether the skill is safe to stack with other channel or runtime skills.

## Core Boundary Reminder

Do not submit a core PR for feature growth that belongs in a skill. If the change mostly expands capability rather than hardens the harness, it probably belongs outside core.

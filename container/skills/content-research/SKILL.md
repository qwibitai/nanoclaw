---
name: content-research
description: Build structured study assets from source registries when package content is thin.
allowed-tools: ["Bash(agent-browser:*)", "Read", "Write", "Edit", "WebSearch", "WebFetch"]
---

# Content Research Workflow

Use this workflow when learner onboarding is active and you need content for a topic that is not fully covered in packaged files.

## Inputs

Read these first:

- /workspace/group/WHO_I_AM.md
- /workspace/group/STUDY_PLAN.md
- /workspace/group/RESOURCE_LIST.md
- /workspace/project/exams/source-registry.json (if present)
- /workspace/project/exams/{slug}/sources.json (if present)

## Output Location

Write reusable assets under:

- /workspace/group/content/plans/
- /workspace/group/content/lessons/
- /workspace/group/content/quizzes/

The host runtime prefers these group-local assets over static package assets.

## Asset Quality Rules

Plan JSON requirements:

- Must include phases[]
- At least one phase must include a non-empty focus[] list

Lesson markdown requirements:

- Non-empty content
- Include objective, 2-5 key points, and one clear next action

Quiz JSON requirements:

- Must include topic as a non-empty string
- Must include questions[] with at least one question
- Each question must include id and answerIndex
- answerIndex must be 0..3

## Research Steps

1. Identify learner current focus from STUDY_PLAN.md.
2. Select source candidates from source registries.
3. Use browser/search to collect 2-3 reliable references for the exact topic.
4. Build one compact lesson and one compact quiz.
5. Save outputs as topic-scoped files, for example:
   - /workspace/group/content/lessons/polity-federalism.md
   - /workspace/group/content/quizzes/polity-federalism.json
6. Keep content concise and exam-oriented.

## Guardrails

- Prefer official or educational sources over random blogs.
- Do not overwrite existing high-quality files unless the learner explicitly asks to refresh content.
- If source quality is weak, state that explicitly in RESOURCE_LIST.md notes instead of fabricating certainty.

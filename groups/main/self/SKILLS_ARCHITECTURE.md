# Skills Architecture

How skills load and when to use auto-loading vs manual invocation.

## Two Types of Skills

### Auto-Loading Skills (Reference)

**Purpose**: Maintain consistency without user needing to remember

**Characteristics**:
- Load automatically when task matches their domain
- Provide baseline context (voice, anti-patterns, style guidelines)
- Always active in background
- User never invokes explicitly

**Examples**:
- `voice-guide` - How to communicate
- `writing-anti-patterns` - What to avoid in writing
- `style-checklist` - Quality standards for responses
- `memory-routing` - How to store different types of information

**When to create auto-loading skills**:
- Rules that apply to ALL tasks of a certain type
- Quality gates that should never be skipped
- Voice/style guidelines
- Safety/privacy constraints

**Manifest configuration**:
```yaml
name: voice-guide
description: Reek's communication voice and style guidelines
auto_load: true
triggers:
  - writing
  - communication
  - content
```

### Manual Invocation Skills (Task)

**Purpose**: Execute specialized workflows with precise quality gates

**Characteristics**:
- Triggered by slash command: `/skill-name`
- Becomes the complete instruction set for that task
- Different workflows have different quality gates
- User explicitly chooses when to use

**Examples**:
- `/write-blog` - Multi-pass blog writing workflow
- `/topic-research` - Research with evidence collection
- `/meeting-prep` - Compile brief from contacts + interactions
- `/weekly-review` - Run metrics + stale contacts + goal check

**When to create manual skills**:
- Multi-step workflows with specific sequence
- Tasks with domain-specific quality gates
- Specialized processes user wants to invoke by name
- Workflows that reference multiple modules

**Manifest configuration**:
```yaml
name: write-blog
description: Seven-section blog post with multi-pass editing
invocation: manual
command: /write-blog
```

## Why Separate Them?

**Problem without separation**:
- Auto-loading everything → context bloat, lost-in-middle effect
- Manual everything → user forgets critical guidelines

**Solution: Layered loading**
- Auto-loading provides foundation (voice, safety, memory routing)
- Manual provides specialized execution (workflow-specific quality gates)

**Example: Writing a blog post**

Auto-loaded (happens automatically):
- Voice profile (tone, banned words)
- Writing anti-patterns (structural traps to avoid)
- Memory routing (where to store research vs drafts)

Manually invoked with `/write-blog`:
- 7-section template (Hook, Core Concept, Framework, Practical Application, Failure Modes, Getting Started, Closing)
- Word count targets per section (2,000-3,500 total)
- 4-pass editing process (structure → voice → evidence → read-aloud)
- Quality checkpoints every 500 words

## Single Source of Truth

**Critical principle: Skills reference, never duplicate**

**Bad (duplicates content)**:
```yaml
# In /write-blog skill
Voice guidelines:
- Use active voice
- Avoid corporate jargon
- [50 more lines copied from voice.yaml]
```

**Good (references source)**:
```yaml
# In /write-blog skill
Context to load:
- self/voice.yaml (how to write)
- self/writing-anti-patterns.md (what to avoid)
- templates/blog-7-section.md (structure)
```

This way:
- Update voice once, applies everywhere
- Skills stay focused on workflow, not content
- No sync issues between duplicated rules

## Progressive Loading Pattern

When user invokes `/write-blog "topic"`:

**Level 1: Skill file loads** (defines what to load)
```markdown
# /write-blog

Multi-pass blog writing workflow.

## Context to load:
1. self/voice.yaml
2. templates/blog-7-section.md
3. Check memory/research/ for existing topic research

## Workflow:
[7-step process with quality gates]
```

**Level 2: Referenced files load** (actual content/templates)
- voice.yaml (5-axis scores, banned words)
- blog-7-section.md (template structure)
- Any existing research on topic

**Level 3: Data loads only if needed**
- memory/logs/posts.jsonl (to avoid repeating recent topics)
- memory/research/{topic}.md (if exists)

## Implementation in NanoClaw

### Auto-Loading Configuration

Skills with `auto_load: true` in manifest get loaded when:
1. Task type matches their triggers
2. CLAUDE.md references them in routing rules
3. They're listed in self/methodology.md as always-active

### Manual Invocation Flow

1. User types `/write-blog context engineering`
2. System finds `write-blog` skill
3. Skill's manifest defines what context to load
4. Context loads in order (voice → template → data)
5. Skill workflow executes with full context

## Quality Gates

**Auto-loading skills define baseline quality**:
- Voice consistency (check banned words)
- Structural patterns (avoid traps)
- Memory routing (right info → right place)

**Manual skills define workflow-specific quality**:
- Blog: Does hook grab attention? Is evidence cited?
- Research: Are sources graded HIGH/MEDIUM/LOW?
- Meeting prep: Are action items identified?

## Future Enhancement: Skill Composition

Allow manual skills to invoke other skills as sub-steps:

```yaml
# /content-pipeline skill
steps:
  - /topic-research  # Research phase
  - /write-blog      # Draft phase
  - /create-thread   # Promotion phase
```

Each step has its own quality gates, but the pipeline ensures they run in order.

## Summary

| Aspect | Auto-Loading | Manual Invocation |
|--------|--------------|-------------------|
| **Trigger** | Automatic (task type) | Explicit (slash command) |
| **Purpose** | Consistency & quality baseline | Specialized workflow execution |
| **When** | Every relevant task | When user chooses |
| **Examples** | Voice, anti-patterns, safety | /write-blog, /research, /review |
| **Scope** | Broad (all writing tasks) | Narrow (specific workflow) |
| **Context** | Light (guidelines only) | Heavy (templates + data) |

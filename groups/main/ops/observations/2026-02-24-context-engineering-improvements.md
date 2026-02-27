# Context Engineering Improvements

**Date**: 2026-02-24
**Inspired by**: Muratcan Koylan's "The File System Is the New Database" article

## What We Implemented

Adopted five key patterns from Muratcan's Personal Brain OS architecture to enhance NanoClaw's context engineering.

### 1. JSONL Episodic Memory System ✅

**What**: Append-only logs for experiences, decisions, failures, and interactions

**Files created**:
- `memory/logs/experiences.jsonl` - Key moments with emotional weight (1-10)
- `memory/logs/decisions.jsonl` - Decisions with reasoning, alternatives, outcomes
- `memory/logs/failures.jsonl` - Root cause analysis and prevention steps
- `memory/logs/interactions.jsonl` - Contact communication history with sentiment
- `memory/logs/README.md` - Schema documentation and usage guide

**Why it matters**:
- Stores judgment, not just facts
- Append-only prevents catastrophic data loss by AI agents
- Enables pattern recognition from past experiences
- JSONL format: stream-friendly, one valid JSON per line

**Usage**:
```bash
echo '{"id":"dec_001","date":"2026-02-24","decision":"..."}' >> decisions.jsonl
grep '"contact_id":"admin"' interactions.jsonl
```

### 2. Structured Voice Profile ✅

**What**: Voice encoded as data instead of adjective descriptions

**File created**: `self/voice.yaml`

**Structure**:
- **5-axis scoring** (1-10): Formal/Casual (6), Technical/Simple (7), etc.
- **Banned words** (3 tiers): Never/Sparingly/Context-dependent
- **Structural patterns to avoid**: Forced rule of three, excessive hedging, corporate speak
- **Quality checkpoints**: Lead with answer, check banned words, be specific

**Why it matters**:
- Numeric scales tell AI exactly where to land on spectrum
- Easier to define what you're NOT than what you are
- Agent checks drafts against banned patterns
- Prevents generic AI voice, produces authentic output

**Example**:
```yaml
technical_simple: 7  # Moderately technical - explain clearly but don't dumb down

banned_always:
  - "leverage"
  - "synergy"
  - "robust"
```

### 3. Cross-Module Reference System ✅

**What**: Flat-file relational model for knowledge graph traversal

**File created**: `memory/CROSS_REFERENCES.md`

**ID schemes**:
- `contact_id` in interactions.jsonl → users/{id}.md
- `decision_id` in failures.jsonl → decisions.jsonl
- Tags enable topic-based queries

**Why it matters**:
- Modules isolated for loading, connected for reasoning
- AI can JOIN data across files like SQL, but with flat files
- No database required, everything Git-versionable
- Maximum 2 hops to any information

**Example traversal**: "Prepare for meeting with Sarah"
1. Find Sarah in users/sarah.md
2. Filter interactions.jsonl by contact_id=sarah
3. Check todos.md for pending items
4. Compile brief

### 4. Auto-Loading vs Manual Skills Architecture ✅

**What**: Two skill types solving different problems

**File created**: `self/SKILLS_ARCHITECTURE.md`

**Auto-loading skills** (consistency):
- Load automatically when task type matches
- Examples: voice-guide, writing-anti-patterns
- Solves: "Don't have to remember to say 'use my voice' every time"

**Manual invocation skills** (precision):
- Slash commands: `/write-blog`, `/topic-research`, `/meeting-prep`
- Different workflows, different quality gates
- Solves: "Research task needs different gates than blog post"

**Single source of truth**:
- Skills reference modules, never duplicate content
- Update voice.yaml once, applies everywhere

**Why it matters**:
- Auto-loading = baseline quality
- Manual = specialized execution
- Prevents context bloat while ensuring consistency

### 5. Progressive Disclosure Routing ✅

**What**: Three-level architecture for context loading

**File created**: `self/ROUTING.md`

**Three levels**:
1. **Routing** (this file) - Always loaded, maps task → module
2. **Module context** - Loaded only when module relevant (40-100 lines)
3. **Actual data** - Loaded only when task requires it

**Task categories with routing rules**:
- Communication → voice.yaml + identity.md
- Memory → index.md + methodology.md → search memory/*.md
- Content creation → voice.yaml + templates → research/{topic}.md
- Planning → goals.md + reminders.md → decisions.jsonl

**Why it matters**:
- Language models have U-shaped attention curve (remember first/last, lose middle)
- Scoped loading prevents conflicting instructions
- ~2,000 tokens relevant context vs. ~10,000 if everything loaded
- Maximum 2 hops to any information

**Example**: Write blog post
- Load: voice.yaml, blog template, topic research
- Skip: interactions.jsonl, admin docs, other templates

## Memory Notes Created

Captured 6 key concepts from Muratcan's article:

1. [[Progressive disclosure uses three-level architecture for AI context]]
2. [[JSONL format prevents agent data loss through append-only design]]
3. [[Voice profiles should be structured data not adjectives]]
4. [[Episodic memory stores judgment not just facts]]
5. [[Cross-module references enable knowledge graph traversal without loading entire system]]
6. [[Auto-loading versus manual invocation skills solve different problems]]

## Files Created

### New Infrastructure
- `memory/logs/` directory with 4 JSONL files + README
- `self/voice.yaml` - Structured voice profile
- `self/SKILLS_ARCHITECTURE.md` - Skills loading patterns
- `self/ROUTING.md` - Task routing and module loading
- `memory/CROSS_REFERENCES.md` - ID linking documentation

### Memory Notes
- 6 new notes in `memory/`
- Updated `memory/index.md` with new "Context Engineering" topic section

## Impact

**Before**:
- Memory as markdown notes only
- Voice as prose descriptions in CLAUDE.md
- No systematic episodic memory (decisions, failures, experiences)
- Skills existed but no loading architecture documented
- Routing implicit, not explicit

**After**:
- Episodic memory with JSONL logs (append-only safety)
- Voice as structured data (5-axis + banned words)
- Cross-module references enable knowledge graph traversal
- Clear distinction between auto-loading and manual skills
- Explicit routing rules with progressive disclosure pattern

**Key principles adopted**:
1. Context engineering > Prompt engineering
2. Append-only is non-negotiable (safety)
3. It's easier to define what you're NOT than what you are (voice)
4. Store judgment, not just facts (episodic memory)
5. Modules isolated for loading, connected for reasoning
6. Maximum 2 hops to any information (progressive disclosure)

## Next Steps

**To fully realize this architecture**:

1. **Create content templates** in `templates/`
   - blog-7-section.md (Hook, Core Concept, Framework, etc.)
   - thread.md (Twitter/LinkedIn thread formatting)
   - research.md (Evidence collection structure)

2. **Build manual skills**:
   - `/write-blog` - Multi-pass blog workflow
   - `/topic-research` - Structured research with source grading
   - `/meeting-prep` - Compile brief from contacts + interactions + todos
   - `/weekly-review` - Metrics + stale contacts + goal check

3. **Populate JSONL logs**:
   - Start logging interactions (sentiment tracking)
   - Capture key decisions with reasoning
   - Record failures with root cause analysis
   - Log significant experiences with emotional weight

4. **Expand cross-references**:
   - Create contacts.jsonl with `can_help_with` / `you_can_help_with` fields
   - Add posts.jsonl for content tracking
   - Build ideas.jsonl with scoring system
   - Implement meetings.jsonl with attendees and outcomes

5. **Auto-loading implementation**:
   - Configure which skills auto-load for which task types
   - Test attention budget with various loading combinations
   - Measure context token usage before/after

## Lessons Applied

From Muratcan's "mistakes and learnings":

✅ **Simpler schemas better** - Our JSONL schemas have 8-10 essential fields, not 15+
✅ **Front-load critical rules** - voice.yaml puts banned words and scales at top
✅ **Module boundaries = loading decisions** - Explicit routing prevents over/under-loading
✅ **Append-only non-negotiable** - JSONL prevents agent from destroying historical data

## Conclusion

We've implemented the foundational architecture for context engineering inspired by Muratcan's Personal Brain OS. The system now has:

- **Durable episodic memory** (JSONL logs)
- **Structured voice** (data, not adjectives)
- **Knowledge graph** (cross-module references)
- **Layered skills** (auto-loading vs manual)
- **Progressive disclosure** (route → module → data)

This positions NanoClaw to operate as a true personal OS with persistent judgment, not just persistent facts.

**Status**: Architecture complete, ready for population and skill development.

# Article: The File System Is the New Database

**Source**: https://x.com/koylanai/status/2025286163641118915
**Author**: Muratcan Koylan (@koylanai)
**Date**: February 21, 2026
**Read**: February 24, 2026

## Summary

Muratcan Koylan built "Personal Brain OS" - a file-based operating system for AI agents with 80+ files, 11 modules, zero dependencies. The article addresses the fundamental problem of AI assistants lacking persistent context: users repeatedly explain who they are, their goals, and preferences in every conversation, with models forgetting mid-session.

The solution uses a Git repository with markdown, YAML, and JSONL files that both humans and language models read natively. The architecture implements progressive disclosure (3-level context loading), episodic memory (stores judgment not just facts), and a skills system based on Anthropic standards.

Key insight: This is context engineering, not prompt engineering. Instead of optimizing individual prompts, design information architecture so the AI has the right context for every decision.

## Key Learnings

### Tier 1: Immediately Applicable ✅

1. **JSONL for append-only episodic memory**
   - Created: `memory/logs/` with experiences, decisions, failures, interactions
   - Format prevents catastrophic data loss by AI agents
   - Implemented: Full JSONL logging system with schemas

2. **Voice profile as structured data**
   - Created: `self/voice.yaml` with 5-axis scoring and banned words
   - Numeric scales tell AI exactly where to land
   - Implemented: Complete voice profile with quality checkpoints

3. **Cross-module references for knowledge graph**
   - Created: `memory/CROSS_REFERENCES.md` documenting ID linking
   - Flat-file relational model enables traversal without database
   - Implemented: Reference system with consistent ID schemes

4. **Auto-loading vs manual skills distinction**
   - Created: `self/SKILLS_ARCHITECTURE.md`
   - Two skill types solve different problems (consistency vs precision)
   - Implemented: Architecture documented, ready for skill development

5. **Progressive disclosure routing**
   - Created: `self/ROUTING.md` with task-based module loading
   - 3 levels: Route → Module → Data (max 2 hops)
   - Implemented: Full routing table with decision logic

### Tier 2: Strategic Value 📋

1. **Module boundaries as loading decisions**
   - Principle: Every boundary determines what loads when
   - Applied to: Routing decisions in ROUTING.md
   - Impact: Prevents context bloat and attention dilution

2. **Quality gates in templates**
   - Pattern: Checkpoints every 500 words, multi-pass editing
   - Queued for: Future content templates
   - Application: /write-blog skill development

3. **Schema-first JSONL design**
   - Pattern: First line defines schema with _schema, _version, _description
   - Applied to: All JSONL logs in memory/logs/
   - Benefit: AI knows structure before reading data

4. **Single source of truth for skills**
   - Pattern: Skills reference modules, never duplicate content
   - Applied to: SKILLS_ARCHITECTURE.md documentation
   - Benefit: Update once, applies everywhere

### Tier 3: Reference Knowledge 📚

1. **Format-function mapping**
   - JSONL for logs (append-only, stream-friendly)
   - YAML for config (hierarchical, comments)
   - Markdown for narrative (LLM-native, universal rendering)

2. **U-shaped attention curve**
   - Language models remember first and last tokens, lose middle
   - Every token competes for attention
   - Informs progressive disclosure design

3. **Personal CRM patterns**
   - Contacts organized into circles with maintenance cadences
   - `can_help_with` / `you_can_help_with` fields for intro matching
   - Sentiment tracking (positive/neutral/needs_attention)

4. **Content pipeline stages**
   - Idea → Research → Outline → Draft → Edit → Publish → Promote
   - Scoring system for ideas (15+ score to proceed)
   - Batch creation workflow

## Memory Notes Created

1. [[Progressive disclosure uses three-level architecture for AI context]]
2. [[JSONL format prevents agent data loss through append-only design]]
3. [[Voice profiles should be structured data not adjectives]]
4. [[Episodic memory stores judgment not just facts]]
5. [[Cross-module references enable knowledge graph traversal without loading entire system]]
6. [[Auto-loading versus manual invocation skills solve different problems]]

## Changes Applied

### New Infrastructure
- **memory/logs/** directory with 4 JSONL files + README
  - experiences.jsonl (emotional weight 1-10)
  - decisions.jsonl (reasoning + alternatives + outcomes)
  - failures.jsonl (root cause + prevention)
  - interactions.jsonl (contact history + sentiment)

- **self/voice.yaml** - Structured voice profile
  - 5-axis scoring system (1-10 scales)
  - 3-tier banned words list
  - Structural patterns to avoid
  - Quality checkpoints

- **self/SKILLS_ARCHITECTURE.md** - Skills loading patterns
  - Auto-loading vs manual invocation
  - Single source of truth principle
  - Progressive loading examples

- **self/ROUTING.md** - Task routing and module loading
  - Decision table for common requests
  - Module boundaries documentation
  - Context budget management

- **memory/CROSS_REFERENCES.md** - ID linking documentation
  - Foreign key patterns
  - Traversal examples
  - Implementation guidelines

### Documentation
- Created: `ops/observations/2026-02-24-context-engineering-improvements.md`
- Updated: `memory/index.md` with new "Context Engineering" topic section
- Added: 6 memory notes with wiki-style links

## Principles Adopted

1. **Context engineering > Prompt engineering**
   - Design information architecture, not individual prompts
   - Structure determines what AI can access and when

2. **Append-only is non-negotiable**
   - Safety mechanism against data loss
   - JSONL format enforces this at file level

3. **Define what you're NOT**
   - Easier than defining what you are
   - Banned words list more effective than style descriptions

4. **Store judgment, not just facts**
   - Episodic memory captures reasoning and tradeoffs
   - Decisions logged with alternatives and frameworks used

5. **Modules isolated for loading, connected for reasoning**
   - Isolation prevents context bloat
   - Cross-references enable knowledge graph traversal

6. **Maximum 2 hops to any information**
   - Progressive disclosure: Route → Module → Data
   - Prevents lost-in-middle effect

## Implementation Metrics

- **Files created**: 10 (5 JSONL logs, 4 documentation files, 1 observation)
- **Memory notes created**: 6
- **Lines of documentation**: ~1,500
- **New concepts integrated**: 12 (Tier 1 + Tier 2)
- **Architecture patterns adopted**: 5

## Next Steps

1. **Populate JSONL logs** with historical data
   - Log past decisions with reasoning
   - Record significant experiences
   - Document failures and learnings

2. **Build manual skills** following architecture
   - /write-blog (7-section template, multi-pass editing)
   - /topic-research (evidence collection, source grading)
   - /meeting-prep (contacts + interactions → brief)
   - /weekly-review (metrics + goals + stale contacts)

3. **Create content templates** in templates/
   - blog-7-section.md
   - thread.md (Twitter/LinkedIn)
   - research.md (structured evidence collection)

4. **Expand cross-references** with new JSONL files
   - contacts.jsonl (full CRM)
   - posts.jsonl (published content)
   - ideas.jsonl (content pipeline)
   - meetings.jsonl (attendees + outcomes)

## Related Research

- [[Ars Contexta provides research-backed agent memory architecture]] - Original inspiration for three-space architecture
- Future: Read Muratcan's other articles on context engineering
- Future: Study Anthropic's Skills documentation for skill system

## Source Material

Full article archived via screenshot: `/home/node/.agent-browser/tmp/screenshots/screenshot-2026-02-24T18-29-53-474Z-dt49w9.png`

Twitter engagement:
- 117 replies
- 817 retweets
- 5.3K likes
- 1.9M views

Author: Muratcan Koylan, Context Engineer at Sully.ai, GitHub: https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering

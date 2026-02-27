# Memory Architect

Architect your agent's second brain - a persistent memory system that remembers across sessions.

_Powered by [Ars Contexta](https://github.com/agenticnotetaking/arscontexta) methodology_

## Usage

```
/memory-architect
```

This skill analyzes the Ars Contexta repository and adapts its research-backed memory architecture to your specific nanoclaw instance, user context, and platform constraints.

## What It Does

This is an **installation skill** that:

1. **Fetches Ars Contexta**: Clones the repository to analyze the methodology
2. **Reads the research**: Studies the 249 research claims, 15 kernel primitives, and three-space architecture
3. **Analyzes your context**:
   - Current group configuration (WhatsApp, iMessage, etc.)
   - Existing memory structure (if any)
   - User preferences and communication style
   - Platform constraints (nanoclaw vs Claude Code)
4. **Makes informed decisions**: Determines which features to implement based on your needs
5. **Proposes adaptation**: Shows what will be created and why
6. **Implements the system**: Creates the three-space architecture, skills, and documentation
7. **Validates**: Checks that all components work together

## The Ars Contexta Methodology

Ars Contexta provides:
- **Three-space separation**: self/ (agent identity), memory/ (knowledge graph), ops/ (temporal scaffolding)
- **Discovery-first design**: Every memory optimized for future findability
- **Session rhythm**: Orient → Work → Persist cycle
- **Processing pipeline**: Record → Reduce → Reflect → Reweave → Verify → Rethink
- **Research backing**: 249 interconnected claims from cognitive science, PKM research, agent architecture

## Adaptation Philosophy

Unlike templating, this skill **derives** your memory architecture:

**It considers:**
- Your platform (WhatsApp bot vs desktop agent)
- Your domain (personal assistant, research, work, etc.)
- Your users (single user vs multiple groups)
- Your constraints (no filesystem hooks in nanoclaw)
- Your existing setup (preserve what works)

**It adapts:**
- Vocabulary (notes/ vs reflections/ vs decisions/)
- Automation level (full hooks vs manual skills)
- Memory structure (flat vs topic-organized)
- Processing intensity (lightweight vs comprehensive)

## Installation Flow

### Phase 1: Understanding (Conversational)

The skill asks questions to understand your needs:

```
📖 Let's build your second brain!

First, a few questions to understand how you work:

1. What's your primary use case?
   - Personal assistant (tasks, reminders, preferences)
   - Knowledge work (research, notes, synthesis)
   - Team coordination (projects, decisions, tracking)
   - Other...

2. How do you prefer to capture information?
   - Conversational (just talk, agent extracts)
   - Explicit (/remember commands)
   - Mixed approach

3. How much automation do you want?
   - High (agent decides what to remember)
   - Medium (agent suggests, you approve)
   - Low (you explicitly tell agent)

[2-3 more questions based on responses...]
```

### Phase 2: Analysis (Behind the scenes)

The skill:
1. Clones Ars Contexta repo to temporary location
2. Reads kernel primitives, three-space architecture, methodology
3. Analyzes your current group structure
4. Maps your responses to Ars Contexta's configuration dimensions
5. Determines which features apply to your context

### Phase 3: Proposal (Review before implementation)

Shows you what will be created:

```
📋 Proposed Memory Architecture

Based on your responses, here's what I'll create:

*Three-Space Structure*
✓ self/ - Your identity, methodology, goals
✓ memory/ - Knowledge graph (notes → reflections)
✓ ops/ - Sessions, observations, reminders

*Processing Skills*
✓ /remember - Extract insights from conversations
✓ /reflect - Find connections across memories
✓ /review - Session end capture

*Documentation*
✓ Updated CLAUDE.md with session rhythm
✓ memory/index.md (hub MOC)
✓ Initial user profile

*Adaptations for WhatsApp/nanoclaw:*
• No filesystem hooks (manual /review instead)
• Conversational memory capture (high automation)
• WhatsApp-friendly formatting throughout
• Lightweight structure (personal assistant domain)

Proceed with installation? (yes/no/customize)
```

### Phase 4: Implementation

Creates all files with progress updates:

```
⏳ Installing second brain...

→ Creating three-space architecture ✓
→ Building self/ space (identity, methodology, goals) ✓
→ Creating memory/ structure with index ✓
→ Setting up ops/ (sessions, observations, reminders) ✓
→ Installing processing skills ✓
→ Updating CLAUDE.md documentation ✓
→ Creating initial user profile ✓

✓ Installation complete!
```

### Phase 5: Validation

Runs checks:
- All directories exist
- Core files have required content
- Skills are accessible
- CLAUDE.md properly documents system
- Sample memory note validates format

## What Gets Created

### Directory Structure

```
/workspace/group/
├── self/
│   ├── identity.md       # Who you are
│   ├── methodology.md    # How you work
│   └── goals.md          # Current context
├── memory/
│   ├── index.md          # Hub MOC
│   ├── users/            # User profiles
│   └── [notes].md        # Atomic knowledge
└── ops/
    ├── reminders.md      # Time-bound actions
    ├── sessions/         # Session logs
    └── observations/     # Friction capture
```

### Processing Skills

Located in `~/.claude/skills/`:
- `/remember` - Memory extraction
- `/reflect` - Connection finding
- `/review` - Session end review

### Documentation

- Updated `CLAUDE.md` with memory system section
- Initial memory notes demonstrating format
- User profile(s) for existing users

## Post-Installation

After installation, the skill provides:

```
🎉 Your second brain is ready!

*Next steps:*

1. Run /review to practice the session rhythm
2. Try /remember to capture something from our conversation
3. Check memory/index.md to see your knowledge hub

*Learning resources:*
• Ars Contexta repo: [link]
• Your methodology: self/methodology.md
• Session rhythm: see CLAUDE.md

*Tips:*
• Before creating memory, ask: "How will I find this later?"
• Use /reflect weekly to surface connections
• Let /review guide session handoffs
```

## Re-running / Updates

If you run `/second-brain` on an existing installation:
- Detects existing structure
- Offers to upgrade or customize
- Preserves all existing content
- Only adds/updates based on new Ars Contexta research

## Advanced Options

```
/second-brain --domain=research    # Override domain detection
/second-brain --vocabulary=custom  # Use custom vocabulary
/second-brain --dry-run           # Show proposal without installing
/second-brain --upgrade           # Update from Ars Contexta latest
```

## Why This Approach

**Derivation over templating:**
- Each nanoclaw instance has unique needs
- Research principles are universal, implementation varies
- Context-aware adaptation beats one-size-fits-all

**Preserve user intent:**
- Asks before creating anything
- Shows what and why before implementation
- Validates that installation succeeded

**Respect platform constraints:**
- Nanoclaw ≠ Claude Code (no hooks, different UX)
- WhatsApp ≠ desktop (formatting, interaction patterns)
- Adapts automation to fit capabilities

## Operational Notes

- Installation is idempotent (safe to re-run)
- Uses progress indicators throughout
- Cleans up temporary files (Ars Contexta clone)
- Creates feature branch for changes (optional)
- Prompts for git commit after success

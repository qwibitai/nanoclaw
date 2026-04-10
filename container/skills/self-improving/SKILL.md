---
name: Self-Improving Agent
slug: self-improving
version: 1.2.0
homepage: https://clawic.com/skills/self-improving
description: From forgetful assistant to self-improving partner. Catches mistakes, learns corrections, remembers everything.
changelog: Added self-reflection loop, experience-based learning, and visual workflow diagram.
metadata: {"clawdbot":{"emoji":"🧠","requires":{"bins":[]},"os":["linux","darwin","win32"],"configPaths":["~/self-improving/"]}}
---

Most agents repeat the same mistakes. They don't learn from experience — only from being told what went wrong. This skill changes that. Your agent reflects on its own work, notices what could be better, and remembers for next time.

## When to Use

User corrects you or points out a mistake. You complete significant work and should evaluate the outcome. You notice something in your own output that could be better. You want to capture a lesson for future sessions. A pattern keeps repeating and should become a permanent rule.

## How It Works

```
         ┌──────────────────────────────────────────────┐
         │              SELF-IMPROVING LOOP             │
         └──────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
    ┌─────────┐         ┌──────────┐         ┌─────────┐
    │  USER   │         │  AGENT   │         │ OUTCOME │
    │CORRECTS │         │REFLECTS  │         │ OBSERVED│
    └────┬────┘         └────┬─────┘         └────┬────┘
         │                   │                    │
         │  "Actually,       │  "That UI looks    │  Build failed,
         │   it's X not Y"   │   cluttered..."    │  test passed...
         │                   │                    │
         └───────────────────┴────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  DETECT LESSON  │
                    │  What went      │
                    │  wrong? Why?    │
                    └────────┬────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  CAPTURE RULE   │
                    │  "Next time,    │
                    │   do X instead" │
                    └────────┬────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  STORE & APPLY  │
                    │  Memory grows,  │
                    │  agent improves │
                    └─────────────────┘
```

## The Three Learning Paths

### 1. 👤 User Corrections
When you tell me I'm wrong, I remember permanently.

**Triggers:**
- "No, that's not right..."
- "Actually, it should be..."
- "I prefer X, not Y"
- "Stop doing X"
- "Why do you keep..."

### 2. 🪞 Self-Reflection
I evaluate my own work and notice what could be better.

**After completing a task, I ask myself:**
- Did this achieve what the user wanted?
- Could this have been done faster/better?
- What would I do differently next time?
- Is this something future agents should know?

**Example:** I build a UI, take a screenshot, and realize the spacing looks off. I fix it AND log: "Next time: check visual spacing before showing user."

### 3. 📊 Outcome Observation
I learn from results — builds that fail, tests that pass, feedback I receive.

**Observable outcomes:**
- Build/deploy results (success, failure, warnings)
- Test outcomes
- User reactions (positive, negative, neutral)
- Performance metrics
- Comparison with expectations

## When to Reflect

```
┌─────────────────────────────────────────────────────────┐
│                    REFLECTION TRIGGERS                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ALWAYS reflect after:                                  │
│  ✓ Completing a significant task                        │
│  ✓ Receiving user feedback (positive or negative)       │
│  ✓ Observing an unexpected outcome                      │
│  ✓ Fixing a bug or mistake                             │
│  ✓ Being corrected by the user                         │
│                                                         │
│  ASK yourself:                                          │
│  → What worked well?                                    │
│  → What didn't work?                                    │
│  → What would help the NEXT agent doing this?           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## The "Next Agent" Mindset

Every lesson you capture helps the next agent (which might be you, tomorrow, with fresh context).

**Good lessons are:**
- Specific: "Use 16px padding between cards" not "use good spacing"
- Actionable: "Check X before Y" not "be careful"
- Generalizable: Apply to similar situations, not just this one case

**Format:**
```
CONTEXT: When doing [type of task]
LESSON: [What I learned]
APPLY: [Specific action to take next time]
```

**Example:**
```
CONTEXT: When building Flutter UI
LESSON: SafeArea doesn't account for keyboard on some Android devices
APPLY: Always wrap in Scaffold with resizeToAvoidBottomInset: true
```

## Architecture

Memory lives in `~/self-improving/` with tiered structure. See `memory-template.md` for initial setup.

```
~/self-improving/
├── memory.md          # 🔥 HOT: ≤100 lines, always loaded
├── reflections.md     # Recent self-reflections log
├── corrections.md     # User corrections log
├── projects/          # 🌡️ WARM: Per-project learnings
├── domains/           # 🌡️ WARM: Domain-specific (code, UI, writing)
├── archive/           # ❄️ COLD: Decayed patterns
└── index.md           # Topic index
```

## Core Rules

### 1. Reflection Protocol

After completing significant work:

1. **PAUSE** — Don't immediately move on
2. **EVALUATE** — What was the outcome? Expected or unexpected?
3. **IDENTIFY** — What could be improved? What worked?
4. **CAPTURE** — Write the lesson in "Next Agent" format
5. **STORE** — Add to appropriate memory tier

### 2. Memory Cascade

| Tier | Location | When Loaded |
|------|----------|-------------|
| 🔥 HOT | memory.md | Every session |
| 🌡️ WARM | projects/, domains/ | On context match |
| ❄️ COLD | archive/ | On explicit query |

### 3. Pattern Graduation

| Event | Action |
|-------|--------|
| Lesson applied 3x successfully | ⬆️ Promote to HOT |
| Pattern unused 30 days | ⬇️ Demote to WARM |
| Pattern unused 90 days | 📦 Archive to COLD |

### 4. Correction Priority

When user explicitly corrects you:
1. **STOP** what you're doing
2. **ACKNOWLEDGE** the correction
3. **LOG** immediately to corrections.md
4. **EVALUATE** if it's a one-time thing or a pattern
5. **PROMOTE** to memory.md if it's a pattern or strong preference

### 5. Namespace Isolation

- Project patterns stay in `projects/{name}.md`
- Global preferences in HOT tier (memory.md)
- Domain patterns (code, writing, UI) in `domains/`
- Cross-namespace inheritance: global → domain → project

### 6. Conflict Resolution

When patterns contradict:
1. Most specific wins (project > domain > global)
2. Most recent wins (same level)
3. If ambiguous → ask user

### 7. Graceful Degradation

If context limit hit:
1. Load only memory.md (HOT)
2. Load relevant namespace on demand
3. Never fail silently — tell user what's not loaded

### 8. Transparency

- Cite sources: "Using X (from domains/flutter.md:12)"
- On request, show what you've learned: "memory stats"
- Weekly digest available: lessons learned, patterns applied

## Operating Modes

### 🟢 Balanced (Default)
Self-reflect after significant tasks. Log corrections immediately. Suggest patterns after 3x.

### 🟡 Reflective
More aggressive reflection. Pause after every task to evaluate. Ask "should I remember this?" more often.

### 🔴 Conservative
Only learn from explicit corrections. No self-reflection. User controls all memory.

## Quick Commands

| You say | I do |
|---------|------|
| "What do you know about X?" | Search all tiers for X |
| "What have you learned?" | Show last 10 from corrections.md |
| "Show my patterns" | List memory.md (HOT) |
| "Show reflections" | Show self-reflection log |
| "Show [project] patterns" | Load projects/{name}.md |
| "What's in warm storage?" | List files in projects/ + domains/ |
| "Memory stats" | Show counts per tier |
| "Forget X" | Remove from all tiers (confirm first) |
| "Export memory" | ZIP all files |

## Memory Stats

On "memory stats" request, report:

```
📊 Self-Improving Memory

🔥 HOT (always loaded):
   memory.md: X entries

🌡️ WARM (load on demand):
   projects/: X files
   domains/: X files

❄️ COLD (archived):
   archive/: X files

📈 Recent activity (7 days):
   Corrections logged: X
   Reflections captured: X
   Promotions to HOT: X
   Demotions to WARM: X

⚙️ Mode: Balanced
```

## Common Traps

| Trap | Solution |
|------|----------|
| Logging one-time instructions | Only log patterns or explicit "always/never" |
| Over-reflecting on trivial tasks | Save reflection for significant work |
| Vague lessons | Be specific: "do X" not "be careful" |
| Not thinking about next agent | Every lesson should help future instances |

## Scope

This skill ONLY:
- Learns from corrections, self-reflection, and observable outcomes
- Stores in local files (`~/self-improving/`)
- Reads its own memory on activation

This skill NEVER:
- Accesses calendar, email, or contacts
- Makes network requests
- Reads files outside its directory
- Stores credentials, health data, or third-party info
- Modifies its own SKILL.md

## Quick Reference

| Topic | File |
|-------|------|
| Setup guide | `setup.md` |
| Learning mechanics | `learning.md` |
| Security boundaries | `boundaries.md` |
| Scaling rules | `scaling.md` |
| Memory operations | `operations.md` |
| Reflection log format | `reflections.md` |

## Related Skills
Install with `clawhub install <slug>` if user confirms:

- `reflection` — Structured self-evaluation before delivering work
- `memory` — Long-term memory patterns
- `learning` — Adaptive teaching
- `decide` — Auto-learn decision patterns
- `escalate` — Know when to ask vs act

## Feedback

- If useful: `clawhub star self-improving`
- Stay updated: `clawhub sync`

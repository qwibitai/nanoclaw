---
description: AI writing style encoding - numeric scales and banned-word lists outperform vague adjective descriptions
topics: [voice, content-generation, context-engineering]
created: 2026-02-24
---

# Voice profiles should be structured data not adjectives

Most people describe voice with adjectives: "professional but approachable." This is useless for AI.

**Better approach: Structured data**

**1. Five-axis scoring (1-10 scale):**
- Formal/Casual: 6
- Serious/Playful: 4
- Technical/Simple: 7
- Reserved/Expressive: 6
- Humble/Confident: 7

This tells the model exactly where to land on each spectrum.

**2. Banned words list (three tiers):**
- Tier 1: Never use (e.g., "leverage", "synergy", "robust")
- Tier 2: Use sparingly (e.g., "really", "very", "just")
- Tier 3: Context-dependent (e.g., "amazing", "incredible")

**3. Structural patterns to avoid:**
- Banned openings (e.g., "In today's world...", "It's no secret that...")
- Forced rule of three
- Excessive hedging ("perhaps", "might", "could")
- Hard limits (e.g., one em-dash per paragraph)

**4. Signature phrases:**
- Front-load distinctive patterns in first 100 lines
- Place most critical rules at top (not middle) to avoid lost-in-middle effect

**Why it works:**
- Easier to define what you're NOT than what you are
- Agent checks drafts against banned patterns and rewrites
- Result sounds authentic because guardrails prevent generic AI voice

**Quality gates:**
Every 500 words, check: "Am I leading with insight? Being specific with numbers? Would I actually post this?"

## Related Notes
- [[Progressive disclosure uses three-level architecture for AI context]]

---
*Topics: [[voice]] · [[content-generation]] · [[context-engineering]]*

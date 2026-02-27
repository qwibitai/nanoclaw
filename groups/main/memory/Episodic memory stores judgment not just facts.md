---
description: Memory architecture - encode decision reasoning and failure patterns alongside facts for AI to reference tradeoffs
topics: [memory, knowledge-management, ai-agents]
created: 2026-02-24
---

# Episodic memory stores judgment not just facts

Most "second brain" systems store facts. Better systems store judgment.

**Three append-only logs:**

**1. Experiences (experiences.jsonl)**
- Key moments with emotional weight scores (1-10)
- What happened and why it mattered
- Captures context that influenced future decisions

**2. Decisions (decisions.jsonl)**
- Decision made + reasoning
- Alternatives considered
- Outcomes tracked over time
- **Example:** "Joined Sully.ai as Context Engineer vs Antler Canada's $250K investment"
  - Priority order: Learning > Impact > Revenue > Growth
  - Framework: Can I touch everything? Will I learn at edge of capability? Do I respect founders?

**3. Failures (failures.jsonl)**
- What went wrong
- Root cause analysis
- Prevention steps for next time
- **Most valuable log** - encodes pattern recognition acquired through pain

**Why it works:**
- Facts tell agent what happened
- Episodic memory tells agent what mattered and how you think about tradeoffs
- When similar decision arises, agent references your past reasoning instead of generating generic advice
- Judgment patterns are reusable across contexts

**Difference:**
- AI with files: knows your calendar
- AI with episodic memory: knows why you prioritize certain meetings

## Related Notes
- [[JSONL format prevents agent data loss through append-only design]]

---
*Topics: [[memory]] · [[knowledge-management]] · [[ai-agents]]*

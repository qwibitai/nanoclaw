---
description: Context loading pattern - route to module to data prevents attention dilution and lost-in-middle effect
topics: [context-engineering, architecture, ai-agents]
created: 2026-02-24
---

# Progressive disclosure uses three-level architecture for AI context

Instead of loading all context upfront, use three levels to manage AI attention budget:

**Level 1: Routing**
- Lightweight routing file (e.g., SKILL.md, CLAUDE.md)
- Always loaded, tells AI which module is relevant
- "This is a content task → load brand module"

**Level 2: Module Context**
- Module-specific instructions (40-100 lines)
- Loaded only when that module is needed
- Contains file inventory, workflows, behavioral rules

**Level 3: Actual Data**
- JSONL logs, YAML configs, research documents
- Loaded only when task requires them
- Read line-by-line or on-demand

**Why it works:**
- Language models have U-shaped attention curve (remember first and last, lose middle)
- Every token competes for model attention
- Scoped loading prevents conflicting instructions across modules
- Maximum of two hops to any piece of information

**Example workflow:**
User asks to write blog post → Level 1 routes to content module → Level 2 loads content workflow + voice guide → Level 3 loads specific templates/research only if needed

## Related Notes
- [[Ars Contexta provides research-backed agent memory architecture]]
- [[CLAUDE.md should be under 100 lines with progressive disclosure]]

---
*Topics: [[context-engineering]] · [[architecture]] · [[ai-agents]]*

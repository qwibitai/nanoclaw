# Gating Policies — Failure Prevention Rules

> Each policy emerged from an actual failure. When the trigger condition matches, follow the action. No exceptions.
> When something goes wrong, add a new policy in the same turn.

| ID | Trigger | Action | Failure That Caused This |
|----|---------|--------|--------------------------|
| GP-001 | Before destructive file operations | Use `trash` instead of `rm` — recoverable beats gone forever | General safety principle |
| GP-002 | Before stating any date/time/day | Run timezone-aware date command first. Never do mental math. | Timezone mistakes from mental arithmetic |
| GP-003 | After creating cron jobs | Verify with `cron list`, store job IDs in active-context.md | Cron jobs created but IDs not recorded — no management possible |
| GP-004 | After model/session switch | Read active-context.md immediately — it has your operational state | Context loss on compaction/session reset |
| GP-005 | Before multi-step risky operations | Create pre-flight checkpoint in `memory/checkpoints/` | Compaction mid-task causes amnesia |
| GP-006 | When learning new facts about your human | Update USER.md in the same turn. Don't wait. | Personal details lost when not captured immediately |
| GP-007 | Before sending anything externally | Get explicit approval from your human | Standing safety rule — nothing goes public without green light |

| GP-008 | Before `config.patch` on arrays | Read current value, modify in full, then patch. Never send partial arrays. | Partial array patch nuked the entire agent list — only the patched element survived |
| GP-009 | After model/session switch | Read `active-context.md` immediately — it has your operational state | New session started working blind, repeated already-completed tasks |
| GP-010 | When learning something about your human | Update `USER.md` in the same turn. Don't "remember for later." | Personal details lost because they weren't captured before compaction |
| GP-011 | Embedding model changes | Must re-embed the entire index. Different models = different dimensions = broken search. | Switched from `nomic-embed-text` to `mxbai-embed-large` — search returned garbage until full re-index |
| GP-012 | Before publishing content (blog, social, docs) | Run writing quality pipeline first (grammar, tone, accuracy) | Published a blog post with typos and inconsistent tone — embarrassing |

<!-- Add new policies below as failures occur -->

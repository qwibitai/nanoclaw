# Horizon: Autonomous Kaizen

*The system that improves itself faster than problems accumulate is the system that wins.*

## Taxonomy

| Level | Name | Description |
|-------|------|-------------|
| L0 | No process | Fix bugs as they come. No reflection, no backlog. |
| L1 | Manual reflection | Humans notice problems and file issues. Improvement is ad-hoc. |
| L2 | Prompted reflection | Agents reflect at checkpoints (case completion, PR merge). Reflection is text — may or may not produce action. |
| L3 | Enforced reflection | Hooks gate on reflection happening. Agent cannot stop without reflecting. But no check on quality or actionability. |
| L4 | Actionable reflection | Reflection must produce filed issues, not just prose. Enforced by MCP tools and post-merge gates. |
| L5 | Meta-reflection | System reflects on its own prompts and processes. Skills ask "are we asking the right questions?" Kaizen about kaizen is routine, not exceptional. |
| L6 | Autonomous work selection | System selects its own next improvement from the backlog without human prompting. Balances momentum, diversity, and priority autonomously. |
| L7 | Autonomous implementation | Improvements ship without human approval for routine cases. Human approves scope (accept-case), system executes and merges. Escalation to human only for genuine judgment calls. |
| L8 | Self-modifying process | The improvement process modifies its own prompts, hooks, and skills based on accumulated meta-reflections. The taxonomy itself evolves. |

## You Are Here

**L3–L4**, with L5 just beginning.

- **L3 (achieved):** `enforce-post-merge-stop.sh` gates on `/kaizen` running. Agent cannot stop without reflecting.
- **L4 (in progress):** `kaizen-reflect.sh` and MCP enforcement (#57, #108) require that reflections produce filed issues, not just prose. PR #157 pending.
- **L5 (just started):** This PR adds mandatory meta-reflection questions to the kaizen skill. No enforcement yet — L1 instructions only.
- **L6 (partial):** `/pick-work` skill exists but requires human to trigger it. No autonomous scheduling.

## Next Steps (visible from here)

1. **Complete L4** — merge #157 (enforce actionable reflections), verify that reflections consistently produce issues
2. **L5 enforcement** — after accumulating meta-reflection data from several cases, assess whether a hook should enforce meta-reflection quality (L2 for L5)
3. **L6 exploration** — what would it take for the system to autonomously run `/pick-work` → `/accept-case` on a schedule?

## What We Can't See Yet

L7+ is fog. We know the direction (more autonomy, less human intervention) but not the mechanism. That's fine — the taxonomy tells us where to walk. When we reach L6, L7 will come into focus.

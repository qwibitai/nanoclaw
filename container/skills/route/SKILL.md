---
name: route
description: Intelligent task router — classifies incoming tasks and routes simple ones to a lightweight model, complex ones to a capable model, and web/browser tasks to agent-browser. Use this skill to minimize token usage across workflows. Trigger when the user sends a task that could be routed, or when explicitly asked to /route something.
allowed-tools: Agent, Bash
---

# /route — Intelligent Task Router

Route tasks to the appropriate model or tool to minimize token usage. Simple tasks are handled cheaply, complex ones escalate to a capable model, and web tasks go to agent-browser.

## Step 1: Classify the task

Analyze the incoming task and assign ONE of these labels:

| Label | Criteria | Examples |
|---|---|---|
| `SIMPLE` | Factual Q&A, greetings, short lookups, formatting, yes/no decisions | "What time is it in Tokyo?", "Summarize this in 1 line", "Translate this word" |
| `COMPLEX` | Multi-step reasoning, code generation, debugging, long-form writing, analysis of large context | "Refactor this module", "Debug this error", "Write a detailed plan for..." |
| `BROWSER` | Tasks requiring live web data, form filling, screenshots, URL fetching | "Check the current price of...", "Open this URL and extract...", "Search the web for..." |
| `TOOL` | Scheduled tasks, MCP operations, file ops, git commands | "Schedule this to run daily", "List my tasks", "Commit these changes" |

**Classify silently** — do not output the label to the user unless asked.

## Step 2: Compress context (always do this before spawning agents)

Before routing to any agent, compress the conversation history:
- Keep only the last 3-5 turns relevant to the current task
- Summarize older history into 1-2 sentences max
- Strip system noise, tool outputs that are no longer relevant
- Pass only: compressed summary + current task

```
CONTEXT TEMPLATE:
---
Prior context (summary): <2 sentence summary of relevant history>
Current task: <verbatim user request>
---
```

## Step 3: Route based on classification

### SIMPLE → Handle inline (no subagent needed)
Answer directly using your current model. Keep response concise.

### COMPLEX → Spawn a capable subagent
```
Agent(
  model: "sonnet",          // or "opus" for maximum reasoning
  prompt: compressed_context + task
)
```
Return the subagent's result directly to the user.

### BROWSER → Delegate to agent-browser
Use the agent-browser skill for any live web interaction:
```
Skill("agent-browser", args: task_description)
```

### TOOL → Execute directly
Use MCP tools or Bash for operational tasks:
- Scheduling: `mcp__nanoclaw__schedule_task`
- Task management: `mcp__nanoclaw__list_tasks`, `cancel_task`, `pause_task`
- File/git ops: Bash tool

## Step 4: Return result

- For SIMPLE: respond inline
- For COMPLEX: return the subagent output, no wrapper needed
- For BROWSER: return the agent-browser result
- For TOOL: confirm action taken

## Routing decision heuristics

When in doubt, use these rules:
- **Shorter is simpler** — if you can answer in <50 tokens, it's SIMPLE
- **Code = COMPLEX** — any code writing, debugging, or review → COMPLEX
- **Live data = BROWSER** — anything requiring current/real-time information
- **Unsure between SIMPLE and COMPLEX?** → Route to COMPLEX (misrouting up is safer than down)

## Token budget awareness

| Route | Approximate cost | When to use |
|---|---|---|
| SIMPLE (inline) | ~100-500 tokens | Most Q&A, quick tasks |
| COMPLEX (sonnet) | ~2k-20k tokens | Code, analysis, long-form |
| BROWSER | Variable | Live web only |
| TOOL | Minimal | Operational only |

Target: 60-70% of tasks should be SIMPLE or TOOL to maximize savings.

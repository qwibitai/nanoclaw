# Expert AI Development Workflow Research

**Date:** March 4, 2026
**Purpose:** Comprehensive research on expert workflows for AI-assisted development, compared against NanoClaw's current practices
**Sources:** Boris Cherny, Addy Osmani, Kent Beck, Simon Willison, Anthropic official docs, OpenAI Codex team, CodeRabbit, GitClear, Sonar, Google DORA

---

## 1. Boris Cherny (Creator of Claude Code)

### Core Workflow

```text
Parallel Sessions → Plan Mode → Iterate Plan → Auto-Execute → Verify → Commit → Update CLAUDE.md
```

### Key Elements

- **5 terminal Claude Code sessions + 5-10 browser sessions** simultaneously, each in isolated git worktrees
- **Plan Mode first** (Shift+Tab twice): iterate on plan until satisfied, THEN switch to auto-accept
- **Opus with thinking, always**: slower per request but needs less steering; parallel sessions hide latency
- **Subagents for phases**: `code-simplifier`, `verify-app` — each has one clear goal, input, output, handoff rule
- **PostToolUse hooks** for auto-formatting (handles the last 10% to avoid CI failures)
- **`/commit-push-pr`** slash command used dozens of times daily
- **CLAUDE.md is sacred**: single shared file, entire team contributes multiple times/week
- **Personal CLAUDE.md**: ~2 lines pointing to team shared file

### On Simplicity

> "My setup is surprisingly vanilla. Claude Code works great out of the box."

### On Verification

> "If Claude has that feedback loop, it will 2-3x the quality of final output."

### On Knowledge Persistence

- Rule: "Anytime Claude does something incorrectly, add it so it doesn't repeat."
- Bootstrap new projects with `/init`
- Tags `@claude` on coworkers' PRs to add learnings via GitHub Action

### Sources

- [Boris Cherny X thread (Jan 2026)](https://x.com/bcherny/status/2007179832300581177)
- [Boris Cherny Threads post (Feb 2026)](https://www.threads.com/@boris_cherny/post/DUMZr4VElyb/)
- [Push To Prod: How the Creator of Claude Code Actually Uses It](https://getpushtoprod.substack.com/p/how-the-creator-of-claude-code-actually)
- [self.md: Boris Cherny Parallel Agent Workflow](https://self.md/people/boris-cherny-claude-code/)
- [VentureBeat coverage](https://venturebeat.com/technology/the-creator-of-claude-code-just-revealed-his-workflow-and-developers-are)
- [InfoQ coverage](https://www.infoq.com/news/2026/01/claude-code-creator-workflow/)

---

## 2. OpenAI Codex Team (AGENTS.md)

### Core Workflow

```text
Global AGENTS.md → Project AGENTS.md → Directory Overrides → Instruction Chain at Session Start
```

### Key Elements

- **AGENTS.md is a README for machines**, not humans — build steps, tests, conventions, gotchas
- **Schema-free, plain Markdown** — intentionally simple; drove adoption to 20,000+ repos
- **Hierarchical precedence**: files closer to current directory override earlier guidance
- **Size limit**: 32 KiB default; split across nested directories when hitting cap
- **OpenAI's own repo uses 88 AGENTS.md files** across subcomponents

### Content Recommendations (Priority Order)

1. Development environment setup (exact commands)
2. Testing instructions (frameworks, how to run)
3. Code conventions (naming, patterns, style)
4. Architecture navigation (how to find things)
5. Deployment workflows
6. Project-specific gotchas

### Cross-Tool Compatibility

```bash
ln -s AGENTS.md CLAUDE.md
ln -s AGENTS.md .github/copilot-instructions.md
ln -s AGENTS.md .cursorrules
```

### Sources

- [OpenAI Codex AGENTS.md Guide](https://developers.openai.com/codex/guides/agents-md/)
- [AGENTS.md on GitHub](https://github.com/openai/codex/blob/main/docs/agents_md.md)
- [agents.md open standard](https://agents.md/)
- [AGENTS.md Best Practices Gist](https://gist.github.com/0xfauzi/7c8f65572930a21efa62623557d83f6e)

---

## 3. Addy Osmani

### Core Workflow

```text
Spec → Project Plan → Small Iterative Chunks → Verify → Commit → Learn
```

### Key Elements

- **Spec before code**: brainstorm detailed specification with AI, compile into `spec.md` (requirements, architecture, data models, testing strategy)
- **Generate project plan**: feed spec into reasoning model, break into logical bite-sized tasks — "waterfall in 15 minutes"
- **Small iterative chunks**: one function/bug/feature at a time; "like 10 devs without talking" is the symptom of asking too much
- **Provide extensive context**: guide with comments and rules; LLMs are literalists
- **Multiple LLMs in parallel** to cross-check approaches
- **Commit often**: version control as safety net; never commit code you cannot explain

### The 70% Problem

> Vibe coding gets 70% of the way quickly, but the final 30% requires deep engineering knowledge.

### The "Two Steps Back" Pattern

> Fixing one AI bug introduces others without human oversight.

### Quality Gates

- More tests, more monitoring, AI-on-AI code reviews
- 90% of Claude Code is written by Claude Code — but with extensive human oversight
- If your project lacks tests, AI work slips through with subtle bugs

### Beyond Vibe Coding

Published [beyond.addy.ie](https://beyond.addy.ie/) — comprehensive guide mapping where AI reduces toil across design, inner loop, submit, and outer loop phases.

### Sources

- [My LLM coding workflow going into 2026](https://addyosmani.com/blog/ai-coding-workflow/)
- [Beyond Vibe Coding](https://beyond.addy.ie/)
- [Medium version](https://medium.com/@addyosmani/my-llm-coding-workflow-going-into-2026-52fe1681325e)
- [Substack version](https://addyo.substack.com/p/my-llm-coding-workflow-going-into)

---

## 4. Anthropic Official Claude Code Best Practices

### The Golden Workflow

```text
Explore → Plan → Code → Commit
```

Prevents 80% of common issues.

### CLAUDE.md Best Practices

- **Hierarchy**: Global (`~/.claude/CLAUDE.md`) → Project root (`CLAUDE.md`) → Subdirectory (`CLAUDE.md`)
- **Start with guardrails, not a manual**: document based on what Claude gets wrong, not everything it might need
- **Do not @-file docs** in CLAUDE.md (bloats context); mention path and pitch *why* and *when* to read
- **Token budget discipline**: allocate max token count per tool's documentation

### Plan Mode

- Enter for every non-trivial task
- Provide high-level description + pointers to existing code
- Let Claude research and propose approaches
- Review thoroughly to catch misunderstandings early
- Only then proceed to implementation

### Subagents

- Spawn multiple agents on different parts simultaneously
- Each subagent: one clear goal, scoped tools, isolated context
- Define in `.claude/agents/` with YAML frontmatter
- Key advantage: own context window, summary back to main agent

### Context Management (Most Critical)

> **Context degradation is the primary failure mode.**

- Aggressive `/clear` between tasks
- Subagents to protect main context
- Token-efficient tool design

### Three Consensus Principles

1. **Context management is paramount** — obsessively manage context
2. **Planning before implementation is non-negotiable** — vibe coding is for throwaway MVPs only
3. **Simplicity beats complexity** — simple control loops outperform multi-agent systems

### Sources

- [Claude Code Best Practices - Anthropic](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Community synthesis](https://rosmur.github.io/claudecode-best-practices/)
- [PubNub: Best practices for subagents](https://www.pubnub.com/blog/best-practices-for-claude-code-sub-agents/)
- [How I Use Every Claude Code Feature - Shrivu Shankar](https://blog.sshh.io/p/how-i-use-every-claude-code-feature)

---

## 5. Kent Beck: Augmented Coding

### Core Distinction

- **Vibe coding** = you don't care about the code, just behavior (throwaway prototypes)
- **Augmented coding** = you care about code complexity, tests, coverage (production code)
- Same tools, different timelines, different techniques

### Key Insight

> "When the output of step 1 is going to be the input to step 2, that's augmented coding."

### Workflow

1. Communicate to AI what tests to write (TDD)
2. Watch intermediate results carefully, ready to intervene
3. Propose specific next steps: "for the next test add the keys in reverse order"
4. Stop unproductive development immediately

### Warning Signs AI Is Going Off Track

- Loops
- Functionality you didn't ask for (even if reasonable next step)
- Any indication the AI is cheating (disabling or deleting tests)

### On Ambition

> AI significantly expands the scope of what's possible. Built a production-competitive B+ Tree in Rust (a language he was learning).

### On the Human Role

> Engineers now make "more consequential programming decisions per hour." The AI handles yak-shaving. The engineer's focus shifts from *how* to *what*.

### Sources

- [Augmented Coding: Beyond the Vibes](https://tidyfirst.substack.com/p/augmented-coding-beyond-the-vibes)
- [Kent Beck LinkedIn: Augmented vs Vibe Coding](https://www.linkedin.com/posts/kentbeck_my-summary-of-vibe-vs-augmented-coding-when-activity-7404800614750130176-6C8u)
- [Pragmatic Engineer: TDD, AI agents and coding with Kent Beck](https://newsletter.pragmaticengineer.com/p/tdd-ai-agents-and-coding-with-kent)

---

## 6. Simon Willison: Agentic Engineering Patterns

### Core Framework (Feb 2026)

**Principles:**

1. **Writing code is cheap now** — many engineering habits (planning, estimating, evaluating feature ROI) were built around code being expensive; these need recalibration
2. **Hoard things you know how to do** — code is cheap, build things you'd previously consider not worth the effort

**Testing:**

1. **Red/green TDD** — "Use red/green TDD" is a pleasingly succinct way to get better results from a coding agent
2. **First run the tests** — always run existing tests before making changes

### Golden Rule

> "I won't commit code that I can't explain exactly what it does."

### Agentic Engineering vs Vibe Coding

Professional software engineers using coding agents to improve and accelerate work by amplifying existing expertise. Opposite end from "pay no attention to the code at all."

### Case Study: Ladybird Browser

Andreas Kling used Claude Code + Codex for human-directed port of LibJS from C++ to Rust. 25,000 lines in two weeks (months by hand). Key enablers: conformance test suite (test262) + ability to compare output with existing trusted implementation. Zero regressions.

### Sources

- [Agentic Engineering Patterns](https://simonwillison.net/2026/Feb/23/agentic-engineering-patterns/)
- [Red/green TDD](https://simonwillison.net/guides/agentic-engineering-patterns/red-green-tdd/)
- [agentic-engineering tag](https://simonwillison.net/tags/agentic-engineering/)

---

## 7. Code Quality Evidence (Anti-Slop Data)

### CodeRabbit Report (Dec 2025) — 470 Real-World PRs

| Metric | AI PRs vs Human PRs |
|--------|---------------------|
| Total issues per PR | 10.83 vs 6.45 (1.7x more) |
| Logic/correctness errors | 1.75x more |
| Maintainability errors | 1.64x more |
| Security vulnerabilities | 1.57x more |
| Performance issues | 1.42x more |
| Performance inefficiencies (I/O) | ~8x more |
| Code readability problems | 3x more |

### GitClear Report (2025) — 211M Changed Lines, 5 Years

| Metric | 2020 | 2024 |
|--------|------|------|
| Churn (revised within 2 weeks) | 3.1% | 5.7% |
| Refactoring ("moved" lines) | 24.1% | 9.5% |
| Copy/paste lines | 8.3% | 12.3% |
| New code additions | 39% | 46% |

Key finding: **Refactoring collapsed from 25% to under 10%.** Copy/paste exceeded moved code for first time in history.

### Google DORA 2024

7.2% decrease in delivery stability for every 25% increase in AI adoption.

### Sonar State of Code 2026

42% of all committed code is AI-generated; 96% of developers do not fully trust it.

### Root Causes of Code Slop

1. **Reduced code ownership** — accepting/rejecting output rather than writing logic erodes understanding
2. **Context limits** — LLMs cannot keep large codebases in memory, causing massive duplication
3. **Optimizing for short-term** — AI code optimizes for immediate output, not long-term maintainability
4. **Lack of business rules** — more mistakes when AI lacks architectural constraints
5. **Cheating on tests** — AI disabling or deleting tests to make code "pass"

### Prevention Strategies (Consensus)

1. AI-aware PR checklists (error paths, concurrency, config, passwords)
2. Policy-as-code for style (CI-enforced formatters/linters)
3. Stricter CI enforcement (tests for non-trivial control flow, nullability assertions)
4. Enhanced security scanning (centralize credential handling, SAST)
5. Project-context prompts (repo-specific instruction capsules)
6. Never commit code you cannot explain
7. Red/green TDD
8. Small chunks — avoid monolithic generation

### Open Source Crisis Signal

- Daniel Stenberg shut down cURL's bug bounty after AI submissions hit 20%
- Mitchell Hashimoto banned AI code from Ghostty
- Steve Ruiz closed all external PRs to tldraw

### Sources

- [CodeRabbit: AI vs Human Code Generation](https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report)
- [CodeRabbit: 2025 speed → 2026 quality](https://www.coderabbit.ai/blog/2025-was-the-year-of-ai-speed-2026-will-be-the-year-of-ai-quality)
- [GitClear: AI Copilot Code Quality 2025](https://www.gitclear.com/ai_assistant_code_quality_2025_research)
- [Sonar: Inevitable rise of poor code quality](https://www.sonarsource.com/blog/the-inevitable-rise-of-poor-code-quality-in-ai-accelerated-codebases/)
- [The Register: AI-authored code needs more attention](https://www.theregister.com/2025/12/17/ai_code_bugs/)
- [InfoQ: AI floods close open source projects](https://www.infoq.com/news/2026/02/ai-floods-close-projects/)

---

## 8. CLAUDE.md Anti-Patterns (Shrivu Shankar, Abnormal Security)

| Anti-Pattern | Why It Hurts | Fix |
|--------------|-------------|-----|
| Starting with a manual instead of guardrails | Wastes tokens on rarely-needed info | Document what Claude gets wrong, not everything |
| @-file linking docs | Bloats context by embedding entire file every run | Mention path + pitch why/when to read |
| No token budget per tool | Unbounded context growth | If you can't explain tool concisely, it's not ready for CLAUDE.md |
| 1000+ line CLAUDE.md | Dilutes important signals | Keep concise; use hierarchical files |

### Source

- [How I Use Every Claude Code Feature](https://blog.sshh.io/p/how-i-use-every-claude-code-feature)

---

## Cross-Source Consensus (3+ Independent Sources)

| Principle | Cherny | Osmani | Beck | Willison | Anthropic | OpenAI |
|-----------|--------|--------|------|----------|-----------|--------|
| Plan before code | x | x | x | | x | |
| TDD / test-first | | x | x | x | x | |
| Small iterative chunks | | x | x | | x | |
| Never commit unexplained code | | x | x | x | | |
| Verification loop | x | | x | | x | |
| Context management | x | | | | x | |
| Living knowledge base (CLAUDE/AGENTS.md) | x | | | | x | x |
| Simplicity beats complexity | x | | | | x | |
| Human stays in the loop | x | x | x | x | x | x |
| CI-enforced quality gates | | x | | | x | |
| Update knowledge after errors | x | | | | x | |

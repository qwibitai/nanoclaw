# AI Agent Engineering Research Hub 📌

**Last Updated:** February 23, 2026 (Weekly Check)
**Purpose:** Track latest research from OpenAI and Anthropic on agent engineering and agentic coding

---

## OpenAI Agent Engineering Research

### 🔗 Main Resource
**[OpenAI Engineering Blog](https://openai.com/index/)**

### Featured Research

#### 1. **Harness Engineering** (2026)
- **URL:** https://openai.com/index/harness-engineering/
- **Key Finding:** AI agents generated ~1 million lines of production code in 5 months with zero manually written source code
- **Team Size:** Only 3 engineers directing Codex agents
- **Key Metrics:** ~1,500 pull requests opened and merged
- **Core Concept:** Engineers design environments and specify intent; agents execute tasks
- **Harness Components:**
  - Scaffolding (structure for agents)
  - Feedback loops (tests, CI/CD, observability)
  - Documentation (clear specifications)
  - Architectural constraints (guardrails)

#### 2. **OpenAI Frontier Platform** (2026)
- **URL:** https://openai.com/index/introducing-openai-frontier/
- **Purpose:** Enterprise platform for building, deploying, and managing AI agents
- **Key Features:**
  - Shared business context (CRMs, data warehouses, internal tools)
  - Institutional knowledge onboarding
  - Identity, governance, and permission controls
  - Auditability for regulated environments

#### 3. **Unrolling the Codex Agent Loop**
- **URL:** https://openai.com/index/unrolling-the-codex-agent-loop/
- **Topic:** Detailed mechanics of how Codex agents iterate through development tasks

#### 4. **Unlocking the Codex Harness: How We Built the App Server** (2026)
- **URL:** https://openai.com/index/unlocking-the-codex-harness/
- **Topic:** Deep dive into the architecture behind OpenAI's harness system
- **Key Focus:** Architectural patterns for building robust harnesses that orchestrate coding agents at scale

#### 5. **Introducing AgentKit** (2026)
- **URL:** https://openai.com/index/introducing-agentkit/
- **Topic:** New toolkit/framework for building AI agents with OpenAI's systems
- **Application:** Standardizing agent development and reducing custom infrastructure work

#### 6. **Introducing Codex - Cloud-based Software Engineering Agent** (2026)
- **URL:** https://openai.com/index/introducing-codex/
- **Topic:** Official introduction to Codex as a cloud-based software engineering agent
- **Significance:** Foundational understanding of Codex capabilities for coding tasks

#### 7. **Beyond Rate Limits: Scaling Access to Codex and Sora** (Feb 13, 2026)
- **URL:** https://openai.com/index/beyond-rate-limits/
- **Innovation:** Hybrid access system combining rate limits with real-time credit purchasing
- **Architecture:** "Decision waterfall" that consolidates usage tracking, rate limits, and credit balances into single evaluation path
- **Impact:** No more hard stops during development—users can continue working past rate limits with credits

### Recent Articles
- InfoQ: [OpenAI Introduces Harness Engineering: Codex Agents Power Large-Scale Software Development](https://www.infoq.com/news/2026/02/openai-harness-engineering-codex/)
- Martin Fowler Blog: [Harness Engineering](https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html)
- Medium: [2025 Was Agents. 2026 Is Agent Harnesses](https://aakashgupta.medium.com/2025-was-agents-2026-is-agent-harnesses-heres-why-that-changes-everything-073e9877655e)

---

## Anthropic Agent Engineering Research

### 🔗 Main Resource
**[Anthropic Engineering Blog](https://www.anthropic.com/engineering)**

### Featured Research

#### 1. **2026 Agentic Coding Trends Report** (2026)
- **Key Findings:**
  - Developers integrate AI into 60% of their work
  - Engineers maintain active oversight on 80-100% of delegated tasks
  - 8 major trends identified (foundation, capability, impact)
- **Link:** https://resources.anthropic.com/2026-agentic-coding-trends-report

#### 2. **Building a C Compiler with a Team of Parallel Claudes** (Feb 2026)
- **Topic:** Autonomous software development using multiple Claude agents working together

#### 3. **Effective Harnesses for Long-Running Agents** (Nov 2025)
- **Focus:** Managing context window challenges across extended operations
- **Link:** https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents

#### 4. **Demystifying Evals for AI Agents** (Jan 2026)
- **Key Insight:** "The capabilities that make agents useful also make them difficult to evaluate"
- **Topic:** Evaluation strategies for agent performance

#### 5. **Building Effective Agents** (Dec 2024)
- **Key Principle:** "The most successful implementations use simple, composable patterns rather than complex frameworks"

#### 6. **Writing Effective Tools for Agents — with Agents** (Sep 2025)
- **Innovation:** Using Claude to optimize its own tools for improved performance

#### 7. **Designing AI-Resistant Technical Evaluations** (Jan 2026)
- **Challenge:** Creating performance assessments that remain effective as AI capabilities advance

#### 8. **Quantifying Infrastructure Noise in Agentic Coding Evals** (2026)
- **Finding:** Infrastructure setup can significantly impact benchmark results, sometimes more than differences between top AI models

#### 9. **Introducing Advanced Tool Use** (Nov 2025)
- **Key Innovation:** Three beta features enable Claude to dynamically discover, learn, and execute tools independently
- **Impact:** Major leap in agent autonomy—agents can discover and use tools without explicit definitions

#### 10. **Code Execution with MCP** (Nov 2025)
- **Key Finding:** Tool calls consume context per definition; agents scale better by writing code to invoke tools through MCP instead
- **Benefit:** More efficient context usage for handling larger, more complex multi-file tasks

#### 11. **Beyond Permission Prompts** (Oct 2025)
- **Innovation:** Claude Code sandboxing reduces permission requests while strengthening security through filesystem and network isolation
- **Impact:** Less friction in agent workflows with improved security and autonomy

#### 12. **Effective Context Engineering for AI Agents** (Sep 2025)
- **Core Principle:** Context is a finite resource requiring careful curation and management
- **Application:** Strategies for maximizing agent performance with limited token budgets in long-running tasks

#### 13. **Introducing Claude Opus 4.6** (Feb 5, 2026)
- **URL:** https://www.anthropic.com/news/claude-opus-4-6
- **Major Features:**
  - 1M token context window (first Opus-class model with long context)
  - Highest score on Terminal-Bench 2.0 (agentic coding benchmark)
  - Agent Teams feature (multiple agents working in parallel)
  - Adaptive thinking (model decides when to use extended reasoning)
  - Effort controls (4 levels: low, medium, high, max)
- **Performance:** Outperforms GPT-5.2 by ~144 Elo points on GDPval-AA (economically valuable knowledge work)
- **Impact:** Production-ready multi-agent coordination for complex projects

#### 14. **Equipping Agents for the Real World with Agent Skills** (Dec 2025)
- **URL:** https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- **Innovation:** Agent Skills open standard for universal AI agent interoperability
- **Industry Adoption:** Microsoft, OpenAI, Atlassian, Figma, Cursor, GitHub
- **Technical:** Organized folders of instructions/scripts that agents discover and load dynamically
- **Standards Effort:** Anthropic donated Model Context Protocol to Linux Foundation; co-founded Agentic AI Foundation with OpenAI
- **Impact:** Cross-platform skill sharing reduces custom integration work
- **Specification:** Available at https://agentskills.io

---

## Key Themes Across Both Organizations

### Engineering Role Transformation
- **From:** Writing code directly (80% manual coding)
- **To:** Orchestrating agents (80% agent coordination, 20% oversight)

### Code Generation Scale
- OpenAI: 1M lines in 5 months (3 engineers)
- Anthropic: 100% of code by AI (Boris Cherny, head of Claude Code - no manual coding in 2+ months)

### Critical Infrastructure
- **Harnesses/Scaffolding:** Feedback loops, documentation, constraints
- **Evaluation:** New methodologies needed for agent performance
- **Oversight:** Maintaining human judgment on 80-100% of delegated work

### 2026 Outlook
- **Trend:** "Slopacolypse" — flood of AI-generated content across all digital media
- **Opportunity:** Continued improvements on model and agent layers
- **Challenge:** Transformation of all computer-based jobs (will be "painful")

---

## How to Use This Document

- 📌 **Pinned & Searchable** — Reference this whenever discussing AI agent research
- 🔗 **All Links Are Current** — Check the URLs for latest updates
- 📅 **Monitor Regularly** — Both organizations publish new research frequently
- 🔍 **Search:** Look here first before searching for recent agent engineering articles

---

**Next Update:** Check both sites monthly for new research releases

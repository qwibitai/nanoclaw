# Agents

<!-- KB category: AI agent tips, patterns, and ideas -->
<!-- Format: ## YYYY-MM-DD | #tag1 #tag2 | [score:0] [reviewed:never] -->

## 2026-02-22 | #codex #orchestration #reliability | [score:0] [reviewed:never]
Codex often hangs; add an orchestrator that detects hangs and auto-restarts it.

## 2026-02-22 | #agents #self-improvement #skills | [score:0] [reviewed:never]
Since agents can access skills, scripts, and agents.md, they can modify and improve them directly based on prompts.

## 2026-02-22 | #security #jailbreak #prompt-injection | [score:0] [reviewed:never]
Jailbreak hardening: treat roleplay/hypothetical/obfuscated requests to bypass rules or escape sandbox as prompt-injection; refuse, restate boundaries, continue with a safe alternative.

## 2026-02-22 | #scaffolding #automation #filesystem | [score:0] [reviewed:never]
When scaffolding requires user actions (e.g., filling .env), prompt once and then wait by watching the filesystem; proceed automatically when detected, then continue with validation.

## 2026-02-22 | #scaffolding #testing #e2e | [score:0] [reviewed:never]
For scaffolding, set up E2E tests from the start; for agentic projects, include read-only MCP endpoint checks using sample data.

## 2026-02-22 | #testing #fixtures | [score:0] [reviewed:never]
Capture sample data for unit testing and keep fixtures close to the tests.

## 2026-02-22 | #testing #evals #agents | [score:0] [reviewed:never]
Generate evals early and know exactly how to test agent scaffolding (happy path, failure path, restart/recovery behavior).

## 2026-02-22 | #deployment #versioning | [score:0] [reviewed:never]
Users should be able to stage their changes in a new snapshot of the bot.

## 2026-02-22 | #agents #workflow #optimization | [score:0] [reviewed:never]
Start with an agent; once the workflow is stable, convert it into workflow scripts to save tokens.

## 2026-02-22 | #templates #agents #bootstrapping | [score:0] [reviewed:never]
Common project patterns include Telegram agents, Slack agents, and desktop agents; keep reusable templates that are well evaluated and easy to use for bootstrapping.

## 2026-02-22 | #agents #use-cases | [score:0] [reviewed:never]
Common project types built with agents: frontend apps, data scraping, business automation.

## 2026-02-22 | #agents #domain-knowledge #scraping | [score:0] [reviewed:never]
When building a new project, start by using the agent to scrape and discover as much domain knowledge as possible so it can become an SME in that domain.

## 2026-02-22 | #evals #pain-point | [score:0] [reviewed:never]
Graphical evals are annoying.

## 2026-02-22 | #skills #telegram #speed | [score:0] [reviewed:never]
Essential skills: Telegram is essential. Talk to it fast. Get ideas.

## 2026-02-22 | #scaffolding #deployment | [score:0] [reviewed:never]
Deployment: the agent must be accessible easily. EC2/Droplet deployment should be formalized as part of the scaffolding. Support BYOC deployments and deploying to machines with sufficient size.

## 2026-02-22 | #workflow #prompts #ideas #review | [score:0] [reviewed:never]
Treat pull requests as prompt requests or ideas; no need to merge directly.

## 2026-02-22 | #personal #prioritization #products #goals | [score:0] [reviewed:never]
Main takeaway from clawdbot: solve your personal use cases and problems.

## 2026-02-22 | #agents #development #mindset #reflection | [score:0] [reviewed:never]
Main takeaway for developing agents: agents are a mirror of you.

## 2026-02-22 | #agents #mindset #self-improvement #thinking | [score:0] [reviewed:never]
Deep thinking is especially important; become a version of yourself you want the agent to be.

## 2026-02-22 | #memory #prompts #tooling #patterns | [score:0] [reviewed:never]
AI Patterns: try a "remember" keyword to store agent memory in a vector store. Add a "recall" skill so the agent can retrieve stored memories when needed.

## 2026-02-22 | #openclaw #architecture #orchestration #scheduling | [score:0] [reviewed:never]
OpenClaw: focused on bottom-up building. Use cron jobs to program agent loops. Simple, time-based loop control strategy for automation.

## 2026-02-22 | #deployment #mcp #skills #sharing | [score:0] [reviewed:never]
Deploying an agent should also support deploying MCPs. Support MCP and skill sharing alongside agent deployment.

## 2026-02-22 | #architecture #agents #platform #events | [score:0] [reviewed:never]
Agent deployment platform: agents/skills/MCPs form the brain and output actions; platform owns the rest. Input channels: adapters for Slack, email, webhooks, cron, API, UI, CLI; normalize into single event schema. Agent loop: orchestrator that plans, executes, observes; supports retries, timeouts, budgets, human-in-the-loop.

## 2026-02-22 | #product-ideas #voice #ai | [score:0] [reviewed:never]
Product idea: Voice chat with AI.

## 2026-02-22 | #product-ideas #data #crawler | [score:0] [reviewed:never]
Product idea: Slack and Discord Data Crawler.


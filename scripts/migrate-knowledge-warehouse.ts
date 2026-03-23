/**
 * Migrate knowledge-warehouse content into the NanoClaw KB.
 *
 * Usage: npx tsx scripts/migrate-knowledge-warehouse.ts [warehouse-path]
 *   warehouse-path defaults to ~/projects/knowledge-warehouse/warehouse
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WAREHOUSE =
  process.argv[2] ??
  path.join(process.env.HOME!, "projects/knowledge-warehouse/warehouse");

const KB = path.resolve(__dirname, "../groups/main/kb");
const ENTRIES = path.join(KB, "entries");
const DATE = "2026-02-22"; // approximate last-modified date of warehouse

// ── helpers ──────────────────────────────────────────────────────────

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function quicknote(tags: string[], content: string): string {
  const tagStr = tags.map((t) => `#${t.replace(/\s+/g, "-")}`).join(" ");
  return `## ${DATE} | ${tagStr} | [score:0] [reviewed:never]\n${content.trim()}\n`;
}

function fullEntry(opts: {
  type: string;
  title: string;
  tags: string[];
  content: string;
}): { filename: string; body: string } {
  const filename = `${DATE}-${slug(opts.title)}.md`;
  const body = `---
type: ${opts.type}
title: "${opts.title.replace(/"/g, '\\"')}"
tags: [${opts.tags.join(", ")}]
related: []
created: ${DATE}
source: knowledge-warehouse
score: 0
last_reviewed: null
---

${opts.content.trim()}
`;
  return { filename, body };
}

function appendCategory(file: string, notes: string[]) {
  const fp = path.join(KB, file);
  const existing = fs.existsSync(fp) ? fs.readFileSync(fp, "utf8") : "";
  fs.writeFileSync(fp, existing.trimEnd() + "\n\n" + notes.join("\n") + "\n");
}

function writeEntry(filename: string, body: string) {
  fs.writeFileSync(path.join(ENTRIES, filename), body);
}

function parseTags(line: string): string[] {
  const m = line.match(/Tags?:\s*(.*)/i);
  if (!m) return [];
  return m[1]
    .split(/[,;]+/)
    .map((t) => t.trim().replace(/^#/, "").replace(/\s+/g, "-"))
    .filter(Boolean);
}

// ── parsers per source file ──────────────────────────────────────────

function migrateAgentNotes() {
  const src = fs.readFileSync(path.join(WAREHOUSE, "agent-notes.md"), "utf8");
  const agentQuicknotes: string[] = [];
  let entryCount = 0;

  // --- References → full entries ---
  const refs = [
    {
      title: "The Complete Guide to Building Skills for Claude",
      summary:
        "Practical guide for designing high-signal Claude skills using progressive-disclosure structure (frontmatter → SKILL.md → linked files), with guidance on trigger wording, instruction structure, test loops, and distribution strategy.",
      tags: [
        "anthropic",
        "skills",
        "claude",
        "mcp",
        "prompt-engineering",
        "workflow-design",
      ],
      link: "https://resources.anthropic.com/hubfs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf",
    },
    {
      title: "OpenClaw ACP — Agent Commerce Workflows",
      summary:
        "ACP CLI + skill package for agent commerce workflows, including wallet identity on Base, marketplace browse/buy/sell, seller runtime, and resource registration. Useful pattern: expose machine-readable CLI (--json) plus a SKILL.md and references/ docs so agents can execute commerce tasks reliably.",
      tags: [
        "openclaw",
        "agent-skills",
        "acp",
        "cli",
        "marketplace",
        "commerce",
      ],
      link: "https://github.com/Virtual-Protocol/openclaw-acp",
    },
    {
      title: "QMD — Memory Techniques and Knowledge Management",
      summary:
        "Resource for memory techniques and practical patterns for retaining and organizing information. Also supports document embeddings for semantic search workflows.",
      tags: ["memory", "memory-techniques", "knowledge-management", "tooling"],
      link: "https://github.com/tobi/qmd",
    },
  ];
  for (const ref of refs) {
    const { filename, body } = fullEntry({
      type: "resource",
      title: ref.title,
      tags: ref.tags,
      content: `${ref.summary}\n\nLink: ${ref.link}`,
    });
    writeEntry(filename, body);
    entryCount++;
  }

  // --- Agent workflow notes → quicknotes ---
  const workflowNotes = [
    {
      tags: ["codex", "orchestration", "reliability"],
      text: "Codex often hangs; add an orchestrator that detects hangs and auto-restarts it.",
    },
    {
      tags: ["agents", "self-improvement", "skills"],
      text: "Since agents can access skills, scripts, and agents.md, they can modify and improve them directly based on prompts.",
    },
    {
      tags: ["security", "jailbreak", "prompt-injection"],
      text: "Jailbreak hardening: treat roleplay/hypothetical/obfuscated requests to bypass rules or escape sandbox as prompt-injection; refuse, restate boundaries, continue with a safe alternative.",
    },
    {
      tags: ["scaffolding", "automation", "filesystem"],
      text: "When scaffolding requires user actions (e.g., filling .env), prompt once and then wait by watching the filesystem; proceed automatically when detected, then continue with validation.",
    },
    {
      tags: ["scaffolding", "testing", "e2e"],
      text: "For scaffolding, set up E2E tests from the start; for agentic projects, include read-only MCP endpoint checks using sample data.",
    },
    {
      tags: ["testing", "fixtures"],
      text: "Capture sample data for unit testing and keep fixtures close to the tests.",
    },
    {
      tags: ["testing", "evals", "agents"],
      text: "Generate evals early and know exactly how to test agent scaffolding (happy path, failure path, restart/recovery behavior).",
    },
    {
      tags: ["deployment", "versioning"],
      text: "Users should be able to stage their changes in a new snapshot of the bot.",
    },
    {
      tags: ["agents", "workflow", "optimization"],
      text: "Start with an agent; once the workflow is stable, convert it into workflow scripts to save tokens.",
    },
    {
      tags: ["templates", "agents", "bootstrapping"],
      text: "Common project patterns include Telegram agents, Slack agents, and desktop agents; keep reusable templates that are well evaluated and easy to use for bootstrapping.",
    },
    {
      tags: ["agents", "use-cases"],
      text: "Common project types built with agents: frontend apps, data scraping, business automation.",
    },
    {
      tags: ["agents", "domain-knowledge", "scraping"],
      text: "When building a new project, start by using the agent to scrape and discover as much domain knowledge as possible so it can become an SME in that domain.",
    },
    {
      tags: ["evals", "pain-point"],
      text: "Graphical evals are annoying.",
    },
  ];
  for (const n of workflowNotes) {
    agentQuicknotes.push(quicknote(n.tags, n.text));
  }

  // --- Essential skills → quicknote ---
  agentQuicknotes.push(
    quicknote(
      ["skills", "telegram", "speed"],
      "Essential skills: Telegram is essential. Talk to it fast. Get ideas."
    )
  );

  // --- Scaffolding essentials → quicknotes ---
  agentQuicknotes.push(
    quicknote(
      ["scaffolding", "deployment"],
      "Deployment: the agent must be accessible easily. EC2/Droplet deployment should be formalized as part of the scaffolding. Support BYOC deployments and deploying to machines with sufficient size."
    )
  );

  // --- Agent templates → full entries ---
  const slackTemplate = fullEntry({
    type: "tip",
    title: "Agent Template — Slack Agent",
    tags: ["template", "slack", "agent", "triage"],
    content: `Purpose: Handle Slack triage, summaries, and light automation in specific channels.

Inputs: Slack events, slash commands, scheduled jobs.
Outputs: Threaded replies, summaries, action items, follow-up tasks.
Required config: Bot token, signing secret, channel allowlist, rate limits.
Safety: Ignore DMs by default, redact secrets, require explicit user confirmation for actions.
Validation: Replay sample event payloads and confirm correct responses in a test channel.`,
  });
  writeEntry(slackTemplate.filename, slackTemplate.body);
  entryCount++;

  const voiceTemplate = fullEntry({
    type: "tip",
    title: "Agent Template — Voice Agent",
    tags: ["template", "voice", "agent", "audio"],
    content: `Purpose: Provide real-time spoken interactions for quick tasks and notes.

Inputs: Microphone audio stream, wake word or push-to-talk, optional context files.
Outputs: Transcript, synthesized reply audio, structured action items.
Components: VAD, STT, LLM, TTS, turn-taking, fallback to text.
Safety: Wake-word gating, local mute, PII redaction, explicit confirmation before actions.
Validation: Speak test phrases and verify latency, transcript accuracy, and response quality.`,
  });
  writeEntry(voiceTemplate.filename, voiceTemplate.body);
  entryCount++;

  // --- Ideas and takeaways → quicknotes ---
  const ideas = [
    {
      tags: ["workflow", "prompts", "ideas", "review"],
      text: "Treat pull requests as prompt requests or ideas; no need to merge directly.",
    },
    {
      tags: ["personal", "prioritization", "products", "goals"],
      text: "Main takeaway from clawdbot: solve your personal use cases and problems.",
    },
    {
      tags: ["agents", "development", "mindset", "reflection"],
      text: "Main takeaway for developing agents: agents are a mirror of you.",
    },
    {
      tags: ["agents", "mindset", "self-improvement", "thinking"],
      text: "Deep thinking is especially important; become a version of yourself you want the agent to be.",
    },
    {
      tags: ["memory", "prompts", "tooling", "patterns"],
      text: 'AI Patterns: try a "remember" keyword to store agent memory in a vector store. Add a "recall" skill so the agent can retrieve stored memories when needed.',
    },
  ];
  for (const idea of ideas) {
    agentQuicknotes.push(quicknote(idea.tags, idea.text));
  }

  // --- OpenClaw notes → quicknote ---
  agentQuicknotes.push(
    quicknote(
      ["openclaw", "architecture", "orchestration", "scheduling"],
      "OpenClaw: focused on bottom-up building. Use cron jobs to program agent loops. Simple, time-based loop control strategy for automation."
    )
  );

  // --- Auto enrichment → full entry ---
  const enrichment = fullEntry({
    type: "tip",
    title: "Auto Enrichment Spec for Knowledge Notes",
    tags: [
      "knowledge-management",
      "enrichment",
      "automation",
      "quality",
    ],
    content: `Purpose: Keep notes useful over time by adding lightweight context without changing core content.

Triggered on: new notes/links added, manual request ("enrich notes"), scheduled review (e.g., weekly).

What it does:
- Fetches link titles, authors, and publish dates where available
- Adds 2–4 sentence summaries per link or project
- Tags each item with 3–6 topical tags
- Groups related items and deduplicates repeated links
- Preserves original text; enrichment is additive and clearly marked

Output rules:
- ASCII only
- Neutral and factual summaries
- High information quality; push back if provided info is low quality
- If a source cannot be accessed, leave the link and add a short note

Quality criteria for articles:
- Must convey some new idea
- Must share concrete examples of use
- The writing must be excellent`,
  });
  writeEntry(enrichment.filename, enrichment.body);
  entryCount++;

  appendCategory("agents.md", agentQuicknotes);
  console.log(
    `agents.md: ${agentQuicknotes.length} quicknotes, ${entryCount} full entries`
  );
}

function migrateProducts() {
  const agentQuicknotes: string[] = [];
  let entryCount = 0;

  // --- Projects with links → full entries ---
  const projects = [
    {
      title: "oh-my-claudecode — Multi-Agent Orchestration",
      tags: ["claude-code", "orchestration", "multi-agent", "automation"],
      summary:
        "Multi-agent orchestration layer for Claude Code with natural-language workflows, automatic parallelization, and multiple execution modes (autopilot, ultrawork, ralph, etc.).",
      link: "https://github.com/Yeachan-Heo/oh-my-claudecode",
    },
    {
      title: "claude-flow — Agent Orchestration Platform",
      tags: ["orchestration", "swarm", "mcp", "memory", "platform"],
      summary:
        "Agent orchestration platform for Claude focused on multi-agent swarms, autonomous workflows, MCP tool integration, and persistent memory.",
      link: "https://github.com/ruvnet/claude-flow",
    },
    {
      title: "Ralph Wiggum — Iterative Self-Referential Loop Plugin",
      tags: ["claude-code", "iterative-loop", "automation", "plugin"],
      summary:
        "Iterative self-referential loop plugin; Claude re-runs the same task until completion, preserving work between iterations.",
      link: "https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum",
    },
    {
      title: "claude-mem — Context Persistence Plugin",
      tags: ["memory", "context", "claude-code", "plugin"],
      summary:
        "Claude Code plugin that captures tool usage, generates summaries, and re-injects relevant context in future sessions; includes search and a local web UI.",
      link: "https://github.com/thedotmack/claude-mem",
    },
    {
      title: "memory-store Plugin — Session & Change Tracking",
      tags: ["memory", "tracking", "mcp", "claude-code"],
      summary:
        "Claude Code plugin that automatically tracks sessions, file changes, and commits via a Memory Store MCP server with OAuth-based retrieval.",
      link: "https://github.com/julep-ai/memory-store-plugin",
    },
    {
      title: "Superpowers Marketplace",
      tags: ["marketplace", "skills", "claude-code", "plugins"],
      summary:
        'Curated Claude Code plugin marketplace with core "Superpowers" skills, writing guidance, and plugin-dev resources.',
      link: "https://github.com/obra/superpowers-marketplace",
    },
    {
      title: "Trail of Bits Skills Marketplace",
      tags: ["security", "skills", "marketplace", "claude-code"],
      summary:
        "Skills marketplace for Claude Code focused on security research, vulnerability detection, and audit workflows; includes plugins for smart contracts, code auditing, malware analysis, and verification.",
      link: "https://github.com/trailofbits/skills",
    },
    {
      title: "Claude Code Plugins Directory",
      tags: ["claude-code", "plugins", "directory"],
      summary:
        "Anthropic's claude-code repository plugins directory (source tree for official plugins).",
      link: "https://github.com/anthropics/claude-code/tree/main/plugins",
    },
    {
      title: "Repomix — Claude Code Plugins Guide",
      tags: ["guide", "tooling", "claude-code", "plugins"],
      summary:
        "Guide to using Repomix to package Claude Code plugins into LLM-friendly XML/Markdown outputs.",
      link: "https://repomix.com/guide/claude-code-plugins",
    },
    {
      title: "User Interface Wiki",
      tags: ["ui-ux", "frontend", "design", "reference", "patterns"],
      summary:
        "Curated UI/UX design patterns, heuristics, and examples focused on practical interface design.",
      link: "https://github.com/raphaelsalaja/userinterface-wiki",
    },
  ];
  for (const p of projects) {
    const { filename, body } = fullEntry({
      type: "resource",
      title: p.title,
      tags: p.tags,
      content: `${p.summary}\n\nLink: ${p.link}`,
    });
    writeEntry(filename, body);
    entryCount++;
  }

  // --- Deployment ideas → quicknotes ---
  agentQuicknotes.push(
    quicknote(
      ["deployment", "mcp", "skills", "sharing"],
      "Deploying an agent should also support deploying MCPs. Support MCP and skill sharing alongside agent deployment."
    )
  );

  // --- Agent deployment platform ideas → quicknote ---
  agentQuicknotes.push(
    quicknote(
      ["architecture", "agents", "platform", "events"],
      "Agent deployment platform: agents/skills/MCPs form the brain and output actions; platform owns the rest. Input channels: adapters for Slack, email, webhooks, cron, API, UI, CLI; normalize into single event schema. Agent loop: orchestrator that plans, executes, observes; supports retries, timeouts, budgets, human-in-the-loop."
    )
  );

  // --- Product ideas → quicknotes ---
  agentQuicknotes.push(
    quicknote(
      ["product-ideas", "voice", "ai"],
      "Product idea: Voice chat with AI."
    )
  );
  agentQuicknotes.push(
    quicknote(
      ["product-ideas", "data", "crawler"],
      "Product idea: Slack and Discord Data Crawler."
    )
  );

  appendCategory("agents.md", agentQuicknotes);
  console.log(
    `products → agents.md: ${agentQuicknotes.length} quicknotes, ${entryCount} full entries`
  );
}

function migrateNotes() {
  const reflectionNotes: string[] = [];
  const resourceNotes: string[] = [];
  let entryCount = 0;

  // --- Mental model → reflections ---
  reflectionNotes.push(
    quicknote(
      ["development", "mental-model", "methodology"],
      "Context structuring: Definition (what's the end result?), Constraints (what invariants must hold?), Validation (how to prove invariants hold and definition is true?)."
    )
  );

  // --- Testing methodology → reflections ---
  reflectionNotes.push(
    quicknote(
      ["testing", "methodology", "adversarial"],
      "Testing: plug the hole on both sides. 1) Add positive tests (edge cases on a feature). 2) Add adversarial testing: introduce novel bugs derived from production issues — can tests catch them? If not, improve."
    )
  );

  // --- Blog posts → full entries ---
  const blogs = [
    {
      title: "Claude 4.5 Opus Soul Document — Richard Weiss",
      tags: ["ai", "anthropic", "model-spec", "alignment", "interpretability"],
      summary:
        "Investigates claims that a soul document/Anthropic Guidelines for Claude 4.5 Opus can be extracted from the model; documents a consensus-based extraction approach and discusses uncertainty about faithfulness. Amanda Askell confirmed the document was used in supervised learning.",
      link: "https://www.lesswrong.com/posts/vpNG99GhbBoLov9og/claude-4-5-opus-soul-document",
    },
    {
      title: "Software Survival 3.0 — Steve Yegge",
      tags: [
        "ai",
        "software-economics",
        "tooling",
        "selection-pressure",
        "orchestration",
      ],
      summary:
        "Argues that in a Software 3.0 world, software survives if it saves cognition/tokens; proposes a survival ratio model based on savings, usage, awareness cost, and friction cost, plus levers like insight compression and substrate efficiency.",
      link: "https://steve-yegge.medium.com/software-survival-3-0-97a2a6255f7b",
    },
    {
      title: "Stevey's Birthday Blog — Steve Yegge",
      tags: ["ai", "orchestration", "career", "productivity", "personal"],
      summary:
        "Personal update framed around five themes (Money, Time, Power, Control, Direction), including AI money influx, the strain/nap effects of high-agent workflows, and a snapshot of the orchestration landscape (Ralph Wiggum, Loom, Claude Flow, Gas Town).",
      link: "https://steve-yegge.medium.com/steveys-birthday-blog-34f437139cb5",
    },
    {
      title: "BAGS and the Creator Economy — Steve Yegge",
      tags: [
        "creator-economy",
        "socialfi",
        "tokens",
        "crypto",
        "marketplaces",
      ],
      summary:
        'Proposes BAGS as a creator-economy/social product where attention becomes tokenized; describes how users can buy/sell "bags" tied to creators and positions it as a SocialFi-style model.',
      link: "https://steve-yegge.medium.com/bags-and-the-creator-economy-249b924a621a",
    },
  ];
  for (const b of blogs) {
    const { filename, body } = fullEntry({
      type: "resource",
      title: b.title,
      tags: b.tags,
      content: `${b.summary}\n\nLink: ${b.link}`,
    });
    writeEntry(filename, body);
    entryCount++;
  }

  // --- Video → full entry ---
  const video = fullEntry({
    type: "resource",
    title: "How OpenClaw's Creator Uses AI — Peter Steinberger Interview",
    tags: ["ai", "automation", "productivity", "interview", "openclaw"],
    content: `Interview with Peter Steinberger (OpenClaw creator) about using AI to run his life in a 40-minute workflow.\n\nLink: https://www.youtube.com/watch?v=AcwK1Uuwc0U&t=1782s`,
  });
  writeEntry(video.filename, video.body);
  entryCount++;

  // --- Podcasts → resources quicknotes ---
  resourceNotes.push(
    quicknote(
      ["audiobooks", "background-listening", "learning"],
      "Audible — audiobook and spoken-word platform for long-form background listening.\nLink: https://www.audible.com/"
    )
  );
  resourceNotes.push(
    quicknote(
      ["software-engineering", "careers", "podcasts", "youtube"],
      "Ryan Peterman — The Peterman Pod: software engineering career stories and interviews in long-form.\nLink: https://youtu.be/2Sjzd9pt6Ts"
    )
  );

  // --- Values → reflections ---
  reflectionNotes.push(
    quicknote(
      ["values", "accountability"],
      "Value: Accountability — I own outcomes, follow through, and fix issues without deflecting responsibility."
    )
  );

  appendCategory("reflections.md", reflectionNotes);
  appendCategory("resources.md", resourceNotes);
  console.log(
    `notes → reflections: ${reflectionNotes.length}, resources: ${resourceNotes.length}, entries: ${entryCount}`
  );
}

function migrateBusiness() {
  const notes: string[] = [];

  notes.push(
    quicknote(
      ["vision", "domain-knowledge", "agents"],
      "Company vision: Capture and continuously refine deep domain knowledge. Be an agent-first company where core workflows are designed for agents from day one."
    )
  );
  notes.push(
    quicknote(
      ["strategy", "adoption", "insight"],
      "Companies are looking in the wrong place by focusing on getting tech companies to adopt; these companies will easily replace tools to save cost."
    )
  );
  notes.push(
    quicknote(
      ["reviews-engine", "f-and-b", "business-idea"],
      "Reviews engine: $1K for system setup, $1 for every review, starting with any vertical in F&B; image generation, organic review content, and automated posting."
    )
  );

  // Create new category file
  const header = "# Business\n\n";
  fs.writeFileSync(path.join(KB, "business.md"), header + notes.join("\n") + "\n");
  console.log(`business.md: ${notes.length} quicknotes (new category)`);
}

function migrateConnections() {
  const notes: string[] = [];

  const contacts = [
    { name: "RC", tags: ["moonshot-ai", "creative"], desc: "moonshot.ai, creative, crazy" },
    { name: "Tianxiao", tags: ["moonshot-ai", "deep-thinker"], desc: "moonshot.ai, creative, crazy, deep thinker" },
    { name: "Jon", tags: ["anthropic"], desc: "Anthropic" },
    { name: "Ambar", tags: ["investor", "family"], desc: "Parizad's uncle, investor, business" },
    { name: "Nora", tags: ["investor", "family"], desc: "Parizad's aunt, investor" },
    { name: "Shirin", tags: ["investor", "family"], desc: "Parizad's aunt, investor" },
  ];

  for (const c of contacts) {
    notes.push(quicknote(c.tags, `${c.name}: ${c.desc}`));
  }

  appendCategory("connections.md", notes);
  console.log(`connections.md: ${notes.length} quicknotes`);
}

function migrateDataSources() {
  const notes: string[] = [];

  notes.push(
    quicknote(
      ["data-source", "blog", "steve-yegge"],
      "Steve Yegge (Blog) — Framing: big ideas and philosophy, may not be practical immediately. Filter: extract core thesis and test against current projects before acting."
    )
  );
  notes.push(
    quicknote(
      ["data-source", "dm", "rc"],
      "RC (DM) — Framing: practical advice with focus on organic AI growth and experimental ideas. Filter: ask clarifying questions and validate with small experiments."
    )
  );
  notes.push(
    quicknote(
      ["data-source", "social", "x"],
      "x.com — Framing: curated for hype and latest news, seldom extremely high quality. Filter: verify claims with primary sources before using; ignore low-signal threads."
    )
  );
  notes.push(
    quicknote(
      ["data-source", "social", "hackernews"],
      "hackernews.com — Framing: occasional high-quality articles amid noise; useful for spotting topics. Filter: scan comments for expert validation and prioritize links with primary sources."
    )
  );

  const header = "# Data Sources\n\n";
  fs.writeFileSync(path.join(KB, "data-sources.md"), header + notes.join("\n") + "\n");
  console.log(`data-sources.md: ${notes.length} quicknotes (new category)`);
}

function migrateTasks() {
  const notes: string[] = [];
  notes.push(
    quicknote(
      ["shopping", "sf-trip", "gifts"],
      "People to buy stuff for before heading back from SF: Family, Parizad's family, Jet, Jed, Zhicai/Jo/Jimmy, John & Woon, Singapore Office."
    )
  );
  appendCategory("todos.md", notes);
  console.log(`todos.md: ${notes.length} quicknote`);
}

function migrateInstructions() {
  const src = fs.readFileSync(
    path.join(WAREHOUSE, "instructions/setting-up-codex-on-a-digital-ocean-vps.md"),
    "utf8"
  );

  const { filename, body } = fullEntry({
    type: "tip",
    title: "Setting Up Codex on a Digital Ocean VPS",
    tags: ["codex", "deployment", "digital-ocean", "ubuntu", "setup"],
    content: `Goal: Install Codex CLI on a barebones Ubuntu 22.04/24.04 droplet and authenticate with device code.

Important: Device-code auth must be enabled in your ChatGPT account security settings (or workspace permissions for Business/Edu/Enterprise).

Notes:
- Assumes you have sudo
- You will open the device-code URL in your local browser and enter the one-time code

\`\`\`bash
set -euo pipefail

# Base packages
sudo apt-get update
sudo apt-get install -y ca-certificates curl git unzip

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify Node
node -v
npm -v

# Install Codex CLI
sudo npm install -g @openai/codex

# Verify Codex
codex --version

# Authenticate with device code
codex login --device-auth

# Quick smoke test
mkdir -p ~/codex-test
cd ~/codex-test
codex --help
\`\`\`

If login fails on a headless server, it is often because device-code auth is disabled at the workspace level.`,
  });
  writeEntry(filename, body);
  console.log(`instructions → entries/${filename}`);
}

// ── main ─────────────────────────────────────────────────────────────

function main() {
  console.log(`Source: ${WAREHOUSE}`);
  console.log(`Target: ${KB}\n`);

  if (!fs.existsSync(WAREHOUSE)) {
    console.error(`ERROR: warehouse not found at ${WAREHOUSE}`);
    process.exit(1);
  }

  fs.mkdirSync(ENTRIES, { recursive: true });

  migrateAgentNotes();
  migrateProducts();
  migrateNotes();
  migrateBusiness();
  migrateConnections();
  migrateDataSources();
  migrateTasks();
  migrateInstructions();

  // Update review-stats with entry count
  const entryFiles = fs.readdirSync(ENTRIES).filter((f) => f.endsWith(".md"));
  const categoryFiles = fs
    .readdirSync(KB)
    .filter((f) => f.endsWith(".md") && f !== "review-stats.md");
  let quicknoteCount = 0;
  for (const cf of categoryFiles) {
    const content = fs.readFileSync(path.join(KB, cf), "utf8");
    quicknoteCount += (content.match(/\[score:0\]/g) || []).length;
  }

  const totalEntries = entryFiles.length + quicknoteCount;
  const stats = `## Review Stats
- total_entries: ${totalEntries}
- total_reviewed: 0
- total_pruned: 0
- streak: 0
- last_review: never
`;
  fs.writeFileSync(path.join(KB, "review-stats.md"), stats);

  console.log(
    `\nDone! ${quicknoteCount} quicknotes + ${entryFiles.length} full entries = ${totalEntries} total`
  );
}

main();

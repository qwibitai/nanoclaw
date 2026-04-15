[DeepWiki](https://deepwiki.com/)

[OasAIStudio/open-agent-sdk](https://github.com/OasAIStudio/open-agent-sdk "Open repository")

- [Overview](https://deepwiki.com/OasAIStudio/open-agent-sdk/1-overview)
- [Getting Started](https://deepwiki.com/OasAIStudio/open-agent-sdk/1.1-getting-started)
- [Monorepo Structure & Tooling](https://deepwiki.com/OasAIStudio/open-agent-sdk/1.2-monorepo-structure-and-tooling)
- [Core Architecture](https://deepwiki.com/OasAIStudio/open-agent-sdk/2-core-architecture)
- [ReAct Loop & Agent Execution Engine](https://deepwiki.com/OasAIStudio/open-agent-sdk/2.1-react-loop-and-agent-execution-engine)
- [Session Management](https://deepwiki.com/OasAIStudio/open-agent-sdk/2.2-session-management)
- [Message Types & Data Model](https://deepwiki.com/OasAIStudio/open-agent-sdk/2.3-message-types-and-data-model)
- [LLM Providers](https://deepwiki.com/OasAIStudio/open-agent-sdk/3-llm-providers)
- [Provider Abstraction (LLMProvider Base)](https://deepwiki.com/OasAIStudio/open-agent-sdk/3.1-provider-abstraction-\(llmprovider-base\))
- [Provider Implementations (OpenAI, Google, Anthropic, Codex)](https://deepwiki.com/OasAIStudio/open-agent-sdk/3.2-provider-implementations-\(openai-google-anthropic-codex\))
- [Authentication & Codex OAuth](https://deepwiki.com/OasAIStudio/open-agent-sdk/3.3-authentication-and-codex-oauth)
- [Tools System](https://deepwiki.com/OasAIStudio/open-agent-sdk/4-tools-system)
- [Built-in Tools: File & Shell Operations](https://deepwiki.com/OasAIStudio/open-agent-sdk/4.1-built-in-tools:-file-and-shell-operations)
- [Built-in Tools: Web, Task & Skill Tools](https://deepwiki.com/OasAIStudio/open-agent-sdk/4.2-built-in-tools:-web-task-and-skill-tools)
- [File Checkpoint System](https://deepwiki.com/OasAIStudio/open-agent-sdk/4.3-file-checkpoint-system)
- [MCP (Model Context Protocol) Integration](https://deepwiki.com/OasAIStudio/open-agent-sdk/4.4-mcp-\(model-context-protocol\)-integration)
- [Permissions & Hooks](https://deepwiki.com/OasAIStudio/open-agent-sdk/5-permissions-and-hooks)
- [Permission System](https://deepwiki.com/OasAIStudio/open-agent-sdk/5.1-permission-system)
- [Hooks Framework](https://deepwiki.com/OasAIStudio/open-agent-sdk/5.2-hooks-framework)
- [Skills System](https://deepwiki.com/OasAIStudio/open-agent-sdk/6-skills-system)
- [Skill Architecture & Loading](https://deepwiki.com/OasAIStudio/open-agent-sdk/6.1-skill-architecture-and-loading)
- [Skill Execution & Matching](https://deepwiki.com/OasAIStudio/open-agent-sdk/6.2-skill-execution-and-matching)
- [CLI Package](https://deepwiki.com/OasAIStudio/open-agent-sdk/7-cli-package)
- [CLI Entrypoint & Configuration](https://deepwiki.com/OasAIStudio/open-agent-sdk/7.1-cli-entrypoint-and-configuration)
- [Subagent System](https://deepwiki.com/OasAIStudio/open-agent-sdk/7.2-subagent-system)
- [Benchmarking Suite](https://deepwiki.com/OasAIStudio/open-agent-sdk/8-benchmarking-suite)
- [SWE-bench Evaluation](https://deepwiki.com/OasAIStudio/open-agent-sdk/8.1-swe-bench-evaluation)
- [Terminal-bench & Harbor Integration](https://deepwiki.com/OasAIStudio/open-agent-sdk/8.2-terminal-bench-and-harbor-integration)
- [Autoresearch Optimization Loop](https://deepwiki.com/OasAIStudio/open-agent-sdk/8.3-autoresearch-optimization-loop)
- [Web & Documentation Sites](https://deepwiki.com/OasAIStudio/open-agent-sdk/9-web-and-documentation-sites)
- [Web Application (packages/web)](https://deepwiki.com/OasAIStudio/open-agent-sdk/9.1-web-application-\(packagesweb\))
- [Documentation Site (packages/docs)](https://deepwiki.com/OasAIStudio/open-agent-sdk/9.2-documentation-site-\(packagesdocs\))
- [Testing & Development Workflow](https://deepwiki.com/OasAIStudio/open-agent-sdk/10-testing-and-development-workflow)
- [Test Infrastructure](https://deepwiki.com/OasAIStudio/open-agent-sdk/10.1-test-infrastructure)
- [Publishing & Release Pipeline](https://deepwiki.com/OasAIStudio/open-agent-sdk/10.2-publishing-and-release-pipeline)
- [Examples & Code Agent Demo](https://deepwiki.com/OasAIStudio/open-agent-sdk/11-examples-and-code-agent-demo)
- [Glossary](https://deepwiki.com/OasAIStudio/open-agent-sdk/12-glossary)

## Overview

Relevant source files
- [AGENTS.md](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/AGENTS.md?plain=1)
- [README.md](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1)
- [ROADMAP.md](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/ROADMAP.md?plain=1)
- [docs/adr/001-monorepo-structure.md](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/adr/001-monorepo-structure.md?plain=1)
- [docs/api-reference.md](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/api-reference.md?plain=1)
- [docs/claude-agent-sdk-comparison.md](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/claude-agent-sdk-comparison.md?plain=1)
- [docs/introduction.md](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/introduction.md?plain=1)
- [examples/quickstart/README.md](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/examples/quickstart/README.md?plain=1)
- [package.json](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/package.json)
- [packages/core/package.json](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/packages/core/package.json)
- [packages/web/app/layout.tsx](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/packages/web/app/layout.tsx)

Open Agent SDK is a lightweight, general-purpose TypeScript agent runtime designed as an open-source alternative to the Claude Agent SDK [README.md4-6](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L4-L6) It provides a transparent, vendor-agnostic framework for building AI agents with persistent sessions, complex tool-use capabilities, and granular permission controls [README.md17-51](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L17-L51)

The SDK is built to handle everything from one-shot prompts to long-lived, multi-turn workflows involving subagent delegation and file-system operations [README.md53-60](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L53-L60)

### Core Philosophy

- **Open Runtime**: Unlike "black box" solutions, the core is MIT-licensed and designed for inspection and extension [README.md47](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L47-L47)
- **Provider Agnostic**: Supports OpenAI, Google Gemini, Anthropic, and Codex through a unified interface [docs/introduction.md18-20](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/introduction.md?plain=1#L18-L20)
- **Production Ready**: Features strict TypeScript typing, high test coverage (>86%), and built-in safety mechanisms like [docs/introduction.md23-70](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/introduction.md?plain=1#L23-L70)

---

### System Context: Natural Language to Code Entities

The following diagram maps high-level conceptual components to their specific implementations within the codebase.

**SDK Entity Mapping**

```
#mermaid-312uo6ch0o5{font-family:ui-sans-serif,-apple-system,system-ui,Segoe UI,Helvetica;font-size:16px;fill:#333;}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#mermaid-312uo6ch0o5 .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#mermaid-312uo6ch0o5 .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#mermaid-312uo6ch0o5 .error-icon{fill:#dddddd;}#mermaid-312uo6ch0o5 .error-text{fill:#222222;stroke:#222222;}#mermaid-312uo6ch0o5 .edge-thickness-normal{stroke-width:1px;}#mermaid-312uo6ch0o5 .edge-thickness-thick{stroke-width:3.5px;}#mermaid-312uo6ch0o5 .edge-pattern-solid{stroke-dasharray:0;}#mermaid-312uo6ch0o5 .edge-thickness-invisible{stroke-width:0;fill:none;}#mermaid-312uo6ch0o5 .edge-pattern-dashed{stroke-dasharray:3;}#mermaid-312uo6ch0o5 .edge-pattern-dotted{stroke-dasharray:2;}#mermaid-312uo6ch0o5 .marker{fill:#999;stroke:#999;}#mermaid-312uo6ch0o5 .marker.cross{stroke:#999;}#mermaid-312uo6ch0o5 svg{font-family:ui-sans-serif,-apple-system,system-ui,Segoe UI,Helvetica;font-size:16px;}#mermaid-312uo6ch0o5 p{margin:0;}#mermaid-312uo6ch0o5 .label{font-family:ui-sans-serif,-apple-system,system-ui,Segoe UI,Helvetica;color:#333;}#mermaid-312uo6ch0o5 .cluster-label text{fill:#444;}#mermaid-312uo6ch0o5 .cluster-label span{color:#444;}#mermaid-312uo6ch0o5 .cluster-label span p{background-color:transparent;}#mermaid-312uo6ch0o5 .label text,#mermaid-312uo6ch0o5 span{fill:#333;color:#333;}#mermaid-312uo6ch0o5 .node rect,#mermaid-312uo6ch0o5 .node circle,#mermaid-312uo6ch0o5 .node ellipse,#mermaid-312uo6ch0o5 .node polygon,#mermaid-312uo6ch0o5 .node path{fill:#ffffff;stroke:#dddddd;stroke-width:1px;}#mermaid-312uo6ch0o5 .rough-node .label text,#mermaid-312uo6ch0o5 .node .label text,#mermaid-312uo6ch0o5 .image-shape .label,#mermaid-312uo6ch0o5 .icon-shape .label{text-anchor:middle;}#mermaid-312uo6ch0o5 .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#mermaid-312uo6ch0o5 .rough-node .label,#mermaid-312uo6ch0o5 .node .label,#mermaid-312uo6ch0o5 .image-shape .label,#mermaid-312uo6ch0o5 .icon-shape .label{text-align:center;}#mermaid-312uo6ch0o5 .node.clickable{cursor:pointer;}#mermaid-312uo6ch0o5 .root .anchor path{fill:#999!important;stroke-width:0;stroke:#999;}#mermaid-312uo6ch0o5 .arrowheadPath{fill:#0b0b0b;}#mermaid-312uo6ch0o5 .edgePath .path{stroke:#999;stroke-width:2.0px;}#mermaid-312uo6ch0o5 .flowchart-link{stroke:#999;fill:none;}#mermaid-312uo6ch0o5 .edgeLabel{background-color:#ffffff;text-align:center;}#mermaid-312uo6ch0o5 .edgeLabel p{background-color:#ffffff;}#mermaid-312uo6ch0o5 .edgeLabel rect{opacity:0.5;background-color:#ffffff;fill:#ffffff;}#mermaid-312uo6ch0o5 .labelBkg{background-color:rgba(255, 255, 255, 0.5);}#mermaid-312uo6ch0o5 .cluster rect{fill:#f8f8f8;stroke:#dddddd;stroke-width:1px;}#mermaid-312uo6ch0o5 .cluster text{fill:#444;}#mermaid-312uo6ch0o5 .cluster span{color:#444;}#mermaid-312uo6ch0o5 div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:ui-sans-serif,-apple-system,system-ui,Segoe UI,Helvetica;font-size:12px;background:#dddddd;border:1px solid hsl(0, 0%, 76.6666666667%);border-radius:2px;pointer-events:none;z-index:100;}#mermaid-312uo6ch0o5 .flowchartTitleText{text-anchor:middle;font-size:18px;fill:#333;}#mermaid-312uo6ch0o5 rect.text{fill:none;stroke-width:0;}#mermaid-312uo6ch0o5 .icon-shape,#mermaid-312uo6ch0o5 .image-shape{background-color:#ffffff;text-align:center;}#mermaid-312uo6ch0o5 .icon-shape p,#mermaid-312uo6ch0o5 .image-shape p{background-color:#ffffff;padding:2px;}#mermaid-312uo6ch0o5 .icon-shape rect,#mermaid-312uo6ch0o5 .image-shape rect{opacity:0.5;background-color:#ffffff;fill:#ffffff;}#mermaid-312uo6ch0o5 .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#mermaid-312uo6ch0o5 .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#mermaid-312uo6ch0o5 :root{--mermaid-font-family:"trebuchet ms",verdana,arial,sans-serif;}Code Entity SpaceNatural Language SpaceGates'The Agent Loop''A Conversation''LLM Backend''Capabilities'ReActLoopSessionLLMProviderToolRegistryPermissionManager
```

Sources: [docs/introduction.md30-112](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/introduction.md?plain=1#L30-L112) [docs/api-reference.md145-244](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/api-reference.md?plain=1#L145-L244)

---

### Monorepo Structure

The project uses a Bun-based monorepo layout, separating the core logic from the developer tools, documentation, and evaluation suites [README.md83-93](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L83-L93)

| Package Path | Purpose |
| --- | --- |
|  | The primary SDK implementation, including the ReAct loop and built-in tools [README.md87](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L87-L87) |
|  | The CLI tool for running agents from the terminal [packages/core/package.json7-10](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/packages/core/package.json#L7-L10) |
|  | The product landing page built with Next.js 15 [README.md88](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L88-L88) |
|  | The documentation site built with Astro and Starlight [README.md89](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L89-L89) |
|  | Runnable usage examples, including quickstarts and a full code-agent demo [README.md90](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L90-L90) |
|  | Evaluation harnesses for SWE-bench and Terminal-bench [README.md91](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L91-L91) |

For a deep dive into the monorepo tooling and build scripts, see [Monorepo Structure & Tooling](https://deepwiki.com/OasAIStudio/open-agent-sdk/1.2-monorepo-structure-and-tooling).

Sources: [README.md83-93](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L83-L93) [package.json21-24](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/package.json#L21-L24) [docs/adr/001-monorepo-structure.md139-156](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/adr/001-monorepo-structure.md?plain=1#L139-L156)

---

### Key Concepts

The Open Agent SDK architecture revolves around several key abstractions that enable complex agentic behavior.

#### The ReAct Loop

The implements the Observe → Think → Act pattern [docs/introduction.md32-38](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/introduction.md?plain=1#L32-L38) It manages the conversation turns, dispatches tool calls, and handles streaming execution [docs/introduction.md41-43](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/introduction.md?plain=1#L41-L43)

#### Persistent Sessions

Sessions allow for multi-turn conversations with full history preservation [docs/introduction.md57-62](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/introduction.md?plain=1#L57-L62)

- : Initializes a new agent workflow [docs/api-reference.md147-156](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/api-reference.md?plain=1#L147-L156)
- : Loads a previous state from storage (e.g., ) [docs/api-reference.md191-202](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/api-reference.md?plain=1#L191-L202)
- : Creates a new branch from an existing conversation [docs/api-reference.md232-242](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/api-reference.md?plain=1#L232-L242)

#### Tool System & MCP

The SDK comes with 14 built-in tools for file operations, shell execution, and web search [docs/introduction.md47-53](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/introduction.md?plain=1#L47-L53) It also supports the **Model Context Protocol (MCP)** via, allowing it to connect to external tool servers [docs/api-reference.md103-131](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/api-reference.md?plain=1#L103-L131)

---

### Execution Architecture: Code Entity Flow

The diagram below shows how a prompt moves through the SDK's code entities to produce a result.

**Execution Pipeline**

```
#mermaid-hmy8de19wbm{font-family:ui-sans-serif,-apple-system,system-ui,Segoe UI,Helvetica;font-size:16px;fill:#333;}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#mermaid-hmy8de19wbm .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#mermaid-hmy8de19wbm .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#mermaid-hmy8de19wbm .error-icon{fill:#dddddd;}#mermaid-hmy8de19wbm .error-text{fill:#222222;stroke:#222222;}#mermaid-hmy8de19wbm .edge-thickness-normal{stroke-width:1px;}#mermaid-hmy8de19wbm .edge-thickness-thick{stroke-width:3.5px;}#mermaid-hmy8de19wbm .edge-pattern-solid{stroke-dasharray:0;}#mermaid-hmy8de19wbm .edge-thickness-invisible{stroke-width:0;fill:none;}#mermaid-hmy8de19wbm .edge-pattern-dashed{stroke-dasharray:3;}#mermaid-hmy8de19wbm .edge-pattern-dotted{stroke-dasharray:2;}#mermaid-hmy8de19wbm .marker{fill:#999;stroke:#999;}#mermaid-hmy8de19wbm .marker.cross{stroke:#999;}#mermaid-hmy8de19wbm svg{font-family:ui-sans-serif,-apple-system,system-ui,Segoe UI,Helvetica;font-size:16px;}#mermaid-hmy8de19wbm p{margin:0;}#mermaid-hmy8de19wbm .label{font-family:ui-sans-serif,-apple-system,system-ui,Segoe UI,Helvetica;color:#333;}#mermaid-hmy8de19wbm .cluster-label text{fill:#444;}#mermaid-hmy8de19wbm .cluster-label span{color:#444;}#mermaid-hmy8de19wbm .cluster-label span p{background-color:transparent;}#mermaid-hmy8de19wbm .label text,#mermaid-hmy8de19wbm span{fill:#333;color:#333;}#mermaid-hmy8de19wbm .node rect,#mermaid-hmy8de19wbm .node circle,#mermaid-hmy8de19wbm .node ellipse,#mermaid-hmy8de19wbm .node polygon,#mermaid-hmy8de19wbm .node path{fill:#ffffff;stroke:#dddddd;stroke-width:1px;}#mermaid-hmy8de19wbm .rough-node .label text,#mermaid-hmy8de19wbm .node .label text,#mermaid-hmy8de19wbm .image-shape .label,#mermaid-hmy8de19wbm .icon-shape .label{text-anchor:middle;}#mermaid-hmy8de19wbm .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#mermaid-hmy8de19wbm .rough-node .label,#mermaid-hmy8de19wbm .node .label,#mermaid-hmy8de19wbm .image-shape .label,#mermaid-hmy8de19wbm .icon-shape .label{text-align:center;}#mermaid-hmy8de19wbm .node.clickable{cursor:pointer;}#mermaid-hmy8de19wbm .root .anchor path{fill:#999!important;stroke-width:0;stroke:#999;}#mermaid-hmy8de19wbm .arrowheadPath{fill:#0b0b0b;}#mermaid-hmy8de19wbm .edgePath .path{stroke:#999;stroke-width:2.0px;}#mermaid-hmy8de19wbm .flowchart-link{stroke:#999;fill:none;}#mermaid-hmy8de19wbm .edgeLabel{background-color:#ffffff;text-align:center;}#mermaid-hmy8de19wbm .edgeLabel p{background-color:#ffffff;}#mermaid-hmy8de19wbm .edgeLabel rect{opacity:0.5;background-color:#ffffff;fill:#ffffff;}#mermaid-hmy8de19wbm .labelBkg{background-color:rgba(255, 255, 255, 0.5);}#mermaid-hmy8de19wbm .cluster rect{fill:#f8f8f8;stroke:#dddddd;stroke-width:1px;}#mermaid-hmy8de19wbm .cluster text{fill:#444;}#mermaid-hmy8de19wbm .cluster span{color:#444;}#mermaid-hmy8de19wbm div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:ui-sans-serif,-apple-system,system-ui,Segoe UI,Helvetica;font-size:12px;background:#dddddd;border:1px solid hsl(0, 0%, 76.6666666667%);border-radius:2px;pointer-events:none;z-index:100;}#mermaid-hmy8de19wbm .flowchartTitleText{text-anchor:middle;font-size:18px;fill:#333;}#mermaid-hmy8de19wbm rect.text{fill:none;stroke-width:0;}#mermaid-hmy8de19wbm .icon-shape,#mermaid-hmy8de19wbm .image-shape{background-color:#ffffff;text-align:center;}#mermaid-hmy8de19wbm .icon-shape p,#mermaid-hmy8de19wbm .image-shape p{background-color:#ffffff;padding:2px;}#mermaid-hmy8de19wbm .icon-shape rect,#mermaid-hmy8de19wbm .image-shape rect{opacity:0.5;background-color:#ffffff;fill:#ffffff;}#mermaid-hmy8de19wbm .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#mermaid-hmy8de19wbm .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#mermaid-hmy8de19wbm :root{--mermaid-font-family:"trebuchet ms",verdana,arial,sans-serif;}Provider LayerExecution EngineAPI Layerprompt()createSession()ReActLoopToolRegistryPermissionManagerLLMProviderOpenAIProviderGoogleProvider
```

Sources: [docs/introduction.md118-148](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/introduction.md?plain=1#L118-L148) [docs/api-reference.md41-110](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/api-reference.md?plain=1#L41-L110)

---

### Quick Navigation

To get started with development or to understand the deeper architecture, follow the links below:

- **[Getting Started](https://deepwiki.com/OasAIStudio/open-agent-sdk/1.1-getting-started)**: Installation, environment setup, and running your first agent prompt [README.md25-43](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L25-L43)
- **[Monorepo Structure & Tooling](https://deepwiki.com/OasAIStudio/open-agent-sdk/1.2-monorepo-structure-and-tooling)**: Detailed explanation of the Bun-based workspace and build pipeline [package.json1-38](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/package.json#L1-L38)
- **[Core Architecture](https://deepwiki.com/OasAIStudio/open-agent-sdk/2-core-architecture)**: Deep dive into the, session management, and data models [docs/introduction.md83-112](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/introduction.md?plain=1#L83-L112)
- **[LLM Providers](https://deepwiki.com/OasAIStudio/open-agent-sdk/3-llm-providers)**: Overview of the provider abstraction and implementation details for OpenAI, Google, Anthropic, and Codex [docs/api-reference.md19-24](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/api-reference.md?plain=1#L19-L24)
- **[Tools System](https://deepwiki.com/OasAIStudio/open-agent-sdk/4-tools-system)**: Comprehensive documentation on built-in tools, MCP integration, and file checkpoints [docs/introduction.md45-53](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/introduction.md?plain=1#L45-L53)
- **[Permissions & Hooks](https://deepwiki.com/OasAIStudio/open-agent-sdk/5-permissions-and-hooks)**: How to use the safety and extensibility layers [docs/introduction.md64-81](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/introduction.md?plain=1#L64-L81)
- **[Skills System](https://deepwiki.com/OasAIStudio/open-agent-sdk/6-skills-system)**: Understanding skill discovery and execution from [packages/core/package.json1-56](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/packages/core/package.json#L1-L56)
- **[CLI Package](https://deepwiki.com/OasAIStudio/open-agent-sdk/7-cli-package)**: Documentation for the CLI entrypoint and subagent runner [README.md28-70](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L28-L70)
- **[Benchmarking Suite](https://deepwiki.com/OasAIStudio/open-agent-sdk/8-benchmarking-suite)**: Guide to running evaluations with SWE-bench and Terminal-bench [README.md130-131](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L130-L131)
- **[Web & Documentation Sites](https://deepwiki.com/OasAIStudio/open-agent-sdk/9-web-and-documentation-sites)**: Overview of the Next.js landing page and Astro documentation site [README.md88-89](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L88-L89)
- **[Testing & Development Workflow](https://deepwiki.com/OasAIStudio/open-agent-sdk/10-testing-and-development-workflow)**: Strategy for unit, integration, and e2e tests [README.md97-111](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L97-L111)
- **[Examples & Code Agent Demo](https://deepwiki.com/OasAIStudio/open-agent-sdk/11-examples-and-code-agent-demo)**: Detailed walkthrough of the directory [README.md79](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L79-L79)
- **[Glossary](https://deepwiki.com/OasAIStudio/open-agent-sdk/12-glossary)**: Definitions of terms and domain concepts [packages/core/package.json4](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/packages/core/package.json#L4-L4)

Sources: [README.md62-73](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/README.md?plain=1#L62-L73) [docs/introduction.md5-112](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/introduction.md?plain=1#L5-L112) [docs/api-reference.md1-38](https://github.com/OasAIStudio/open-agent-sdk/blob/8a6e16c7/docs/api-reference.md?plain=1#L1-L38)
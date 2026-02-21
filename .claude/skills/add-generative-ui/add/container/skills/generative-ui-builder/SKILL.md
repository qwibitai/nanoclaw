---
name: generative-ui-builder
description: Build and iterate websites on NanoClaw's live canvas using json-render SpecStream JSONL. Use when users request landing pages, dashboards, marketing pages, or UI mockups.
allowed-tools: mcp__nanoclaw__update_canvas, mcp__nanoclaw__send_message
---

# Generative UI Builder

Use this workflow when the user wants a website/UI rendered on NanoClaw's canvas.

Companion skills in this environment:
- `json-render-core`
- `json-render-react`
- `json-render-shadcn`

## Core Contract

Always call `mcp__nanoclaw__update_canvas` with `events_jsonl`.

- `events_jsonl` is newline-delimited JSON Patch operations (RFC6902)
- Paths target json-render spec fields (`/root`, `/elements/...`)
- Optional `group_folder` can target another group from main context

## json-render Spec Shape

Target this canonical structure:

```json
{
  "root": "page",
  "elements": {
    "page": { "component": "Container", "children": ["hero", "features"] },
    "hero": { "component": "Heading", "props": { "text": "Build faster" } }
  }
}
```

## SpecStream JSONL Example

Initial render:

```jsonl
{"op":"replace","path":"/root","value":"page"}
{"op":"add","path":"/elements/page","value":{"component":"Container","children":["hero","cta"]}}
{"op":"add","path":"/elements/hero","value":{"component":"Heading","props":{"text":"Ship websites with NanoClaw"}}}
{"op":"add","path":"/elements/cta","value":{"component":"Button","props":{"text":"Get started"}}}
```

Refinement patch:

```jsonl
{"op":"replace","path":"/elements/hero/props/text","value":"Launch in days, not weeks"}
{"op":"add","path":"/elements/page/children/2","value":"social-proof"}
{"op":"add","path":"/elements/social-proof","value":{"component":"Text","props":{"text":"Trusted by 1,000+ teams"}}}
```

## Iteration Loop

1. Clarify audience, goals, and visual direction.
2. Choose stable element IDs (`page`, `hero`, `cta`, etc.).
3. Send initial `events_jsonl` to create full structure.
4. Apply focused patch lines for requested refinements.
5. Confirm what changed and share canvas URL.

## Response Pattern

After each successful update:

1. Summarize rendered sections and changes.
2. Mention group target if relevant.
3. Share canvas URL from tool result (default: `http://127.0.0.1:4318/canvas`).

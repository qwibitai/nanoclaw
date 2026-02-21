---
name: json-render-core
description: Model and transform UI as json-render specs. Use when defining spec shape, element IDs, and SpecStream patch operations.
---

# json-render-core

Use this skill for schema/spec-level work.

## Core Model

A json-render spec has:

- `root`: root element id (string or null)
- `elements`: map of element id -> element definition

Example:

```json
{
  "root": "page",
  "elements": {
    "page": { "component": "Container", "children": ["hero"] },
    "hero": { "component": "Heading", "props": { "text": "Hello" } }
  }
}
```

## Streaming Format

Use SpecStream JSONL (one RFC6902 operation per line):

```jsonl
{"op":"replace","path":"/root","value":"page"}
{"op":"add","path":"/elements/page","value":{"component":"Container","children":["hero"]}}
{"op":"replace","path":"/elements/hero/props/text","value":"Updated copy"}
```

Supported ops: `add`, `remove`, `replace`, `move`, `copy`, `test`.

## Authoring Rules

- Use stable IDs in `/elements/*` paths.
- Patch only what changed.
- Prefer additive updates over full rewrites.

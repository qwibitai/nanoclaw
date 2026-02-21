---
name: json-render-react
description: Render json-render specs in React with @json-render/react Renderer and action handling.
---

# json-render-react

Use this skill for React rendering concerns.

## Install

```bash
npm install @json-render/react react react-dom
```

## Basic Render Pattern

```tsx
import { Renderer } from "@json-render/react";

<Renderer
  spec={spec}
  componentMap={componentMap}
  onAction={onAction}
/>
```

`spec` should be the canonical `{ root, elements }` object.

## Interaction Pattern

- Keep behavior in `onAction` handlers.
- Treat spec updates as external state (e.g., from API polling/streaming).
- Re-render by replacing/updating `spec` with new state.

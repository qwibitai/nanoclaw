---
name: json-render-shadcn
description: Use shadcn-styled component mappings with json-render React rendering.
---

# json-render-shadcn

Use this skill when the UI should look polished with shadcn-based primitives.

## Install

```bash
npm install @json-render/shadcn @json-render/react react react-dom
```

## Integration

```tsx
import { Renderer } from "@json-render/react";
import { componentMap } from "@json-render/shadcn";

<Renderer
  spec={spec}
  componentMap={componentMap}
  onAction={onAction}
/>
```

If your runtime exports `registry` instead of `componentMap`, pass the same map via that prop.

## Guidance

- Keep IDs and layout structure stable; patch copy/style incrementally.
- Prefer shadcn components for landing pages, dashboards, and internal tools.

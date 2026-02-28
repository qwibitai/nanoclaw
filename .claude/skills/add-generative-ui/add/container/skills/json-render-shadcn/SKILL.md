---
name: json-render-shadcn
description: Pre-built shadcn/ui components for json-render. Use when working with @json-render/shadcn, adding standard UI components to a catalog, or building web UIs with Radix UI + Tailwind CSS components.
---

# @json-render/shadcn

Pre-built shadcn/ui component definitions and implementations for json-render. Provides 36 components built on Radix UI + Tailwind CSS.

## Two Entry Points

| Entry Point                   | Exports                      | Use For                                                |
| ----------------------------- | ---------------------------- | ------------------------------------------------------ |
| `@json-render/shadcn/catalog` | `shadcnComponentDefinitions` | Catalog schemas (no React dependency, safe for server) |
| `@json-render/shadcn`         | `shadcnComponents`           | React implementations                                  |

## Usage Pattern

Pick the components you need from the standard definitions. Do not spread all definitions -- explicitly select what your app uses:

```typescript
import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/react/schema';
import { shadcnComponentDefinitions } from '@json-render/shadcn/catalog';
import { defineRegistry } from '@json-render/react';
import { shadcnComponents } from '@json-render/shadcn';

// Catalog: pick definitions
const catalog = defineCatalog(schema, {
  components: {
    Card: shadcnComponentDefinitions.Card,
    Stack: shadcnComponentDefinitions.Stack,
    Heading: shadcnComponentDefinitions.Heading,
    Button: shadcnComponentDefinitions.Button,
    Input: shadcnComponentDefinitions.Input,
  },
  actions: {},
});

// Registry: pick matching implementations
const { registry } = defineRegistry(catalog, {
  components: {
    Card: shadcnComponents.Card,
    Stack: shadcnComponents.Stack,
    Heading: shadcnComponents.Heading,
    Button: shadcnComponents.Button,
    Input: shadcnComponents.Input,
  },
});
```

## Spec Conventions

- Use `type` for component names in each element.
- For NanoClaw canvas, use `root` as an element id and `elements` as an id map.
- Prefer documented shadcn props (for example `Button.label`, `Link.label`).

> State actions (`setState`, `pushState`, `removeState`) are built into the React schema and handled by `ActionProvider` automatically. No need to declare them.

## Extending with Custom Components

Add custom components alongside standard ones:

```typescript
const catalog = defineCatalog(schema, {
  components: {
    // Standard
    Card: shadcnComponentDefinitions.Card,
    Stack: shadcnComponentDefinitions.Stack,

    // Custom
    Metric: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        trend: z.enum(["up", "down", "neutral"]).nullable(),
      }),
      description: "KPI metric display",
    },
  },
  actions: {},
});

const { registry } = defineRegistry(catalog, {
  components: {
    Card: shadcnComponents.Card,
    Stack: shadcnComponents.Stack,
    Metric: ({ props }) => <div>{props.label}: {props.value}</div>,
  },
});
```

## Available Components

### Layout

- **Card** - Container with optional title, description, maxWidth, centered
- **Stack** - Flex container with direction, gap, align, justify
- **Grid** - Grid layout with columns (number) and gap
- **Separator** - Visual divider with orientation

### Navigation

- **Tabs** - Tabbed navigation with tabs array, defaultValue, value
- **Accordion** - Collapsible sections with items array and type (single/multiple)
- **Collapsible** - Single collapsible section with title
- **Pagination** - Page navigation with totalPages and page

### Overlay

- **Dialog** - Modal dialog with title, description, openPath
- **Drawer** - Bottom drawer with title, description, openPath
- **Tooltip** - Hover tooltip with content and text
- **Popover** - Click-triggered popover with trigger and content
- **DropdownMenu** - Dropdown with label and items array

### Content

- **Heading** - Heading text with level (h1-h4)
- **Text** - Paragraph with variant (body, caption, muted, lead, code)
- **Image** - Image with alt, width, height
- **Avatar** - User avatar with src, name, size
- **Badge** - Status badge with text and variant (default, secondary, destructive, outline)
- **Alert** - Alert banner with title, message, type (success, warning, info, error)
- **Carousel** - Scrollable carousel with items array
- **Table** - Data table with columns (string[]) and rows (string[][])

### Feedback

- **Progress** - Progress bar with value, max, label
- **Skeleton** - Loading placeholder with width, height, rounded
- **Spinner** - Loading spinner with size and label

### Input

- **Button** - Button with label, variant (primary, secondary, danger), disabled
- **Link** - Anchor link with label and href
- **Input** - Text input with label, name, type, placeholder, value, checks
- **Textarea** - Multi-line input with label, name, placeholder, rows, value, checks
- **Select** - Dropdown select with label, name, options (string[]), value, checks
- **Checkbox** - Checkbox with label, name, checked
- **Radio** - Radio group with label, name, options (string[]), value
- **Switch** - Toggle switch with label, name, checked
- **Slider** - Range slider with label, min, max, step, value
- **Toggle** - Toggle button with label, pressed, variant
- **ToggleGroup** - Group of toggles with items, type, value
- **ButtonGroup** - Button group with buttons array and selected

## Built-in Actions (from `@json-render/react`)

These are built into the React schema and handled by `ActionProvider` automatically. They appear in prompts without needing to be declared in the catalog.

- **setState** - Set a value at a state path (`{ statePath, value }`)
- **pushState** - Push a value onto an array (`{ statePath, value, clearStatePath? }`)
- **removeState** - Remove an array item by index (`{ statePath, index }`)

## Important Notes

- The `/catalog` entry point has no React dependency -- use it for server-side prompt generation
- Components use Tailwind CSS classes -- your app must have Tailwind configured
- Component implementations use bundled shadcn/ui primitives (not your app's `components/ui/`)
- Form inputs support `checks` for validation (type + message pairs)
- Events: inputs emit `change`/`submit`/`focus`/`blur`; buttons emit `press`; selects emit `change`/`select`

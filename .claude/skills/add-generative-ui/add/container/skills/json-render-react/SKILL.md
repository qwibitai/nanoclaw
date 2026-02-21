---
name: json-render-react
description: React renderer for json-render that turns JSON specs into React components. Use when working with @json-render/react, building React UIs from JSON, creating component catalogs, or rendering AI-generated specs.
---

# @json-render/react

React renderer that converts JSON specs into React component trees.

## Quick Start

```typescript
import { defineRegistry, Renderer } from "@json-render/react";
import { catalog } from "./catalog";

const { registry } = defineRegistry(catalog, {
  components: {
    Card: ({ props, children }) => <div>{props.title}{children}</div>,
  },
});

function App({ spec }) {
  return <Renderer spec={spec} registry={registry} />;
}
```

## Creating a Catalog

```typescript
import { defineCatalog } from "@json-render/core";
import { schema, defineRegistry } from "@json-render/react";
import { z } from "zod";

// Create catalog with props schemas
export const catalog = defineCatalog(schema, {
  components: {
    Button: {
      props: z.object({
        label: z.string(),
        variant: z.enum(["primary", "secondary"]).nullable(),
      }),
      description: "Clickable button",
    },
    Card: {
      props: z.object({ title: z.string() }),
      description: "Card container with title",
    },
  },
});

// Define component implementations with type-safe props
const { registry } = defineRegistry(catalog, {
  components: {
    Button: ({ props }) => (
      <button className={props.variant}>{props.label}</button>
    ),
    Card: ({ props, children }) => (
      <div className="card">
        <h2>{props.title}</h2>
        {children}
      </div>
    ),
  },
});
```

## Spec Structure (NanoClaw Canvas)

For NanoClaw canvas flows, use `root` as an element id and `elements` as an id-to-element map:

```json
{
  "root": "page",
  "elements": {
    "page": {
      "type": "Card",
      "props": { "title": "Hello" },
      "children": ["cta"]
    },
    "cta": {
      "type": "Button",
      "props": { "label": "Click me" }
    }
  }
}
```

Prefer `type` for component names. `component` may appear in legacy payloads and should be normalized to `type` before rendering.

## Visibility Conditions

Use `visible` on elements to show/hide based on state. New syntax: `{ "$state": "/path" }`, `{ "$state": "/path", "eq": value }`, `{ "$state": "/path", "not": true }`, `{ "$and": [cond1, cond2] }` for AND, `{ "$or": [cond1, cond2] }` for OR. Helpers: `visibility.when("/path")`, `visibility.unless("/path")`, `visibility.eq("/path", val)`, `visibility.and(cond1, cond2)`, `visibility.or(cond1, cond2)`.

## Providers

| Provider             | Purpose                                            |
| -------------------- | -------------------------------------------------- |
| `StateProvider`      | Share state across components (JSON Pointer paths) |
| `ActionProvider`     | Handle actions dispatched via the event system     |
| `VisibilityProvider` | Enable conditional rendering based on state        |
| `ValidationProvider` | Form field validation                              |

## Dynamic Prop Expressions

Any prop value can be a data-driven expression resolved by the renderer before components receive props:

- **`{ "$state": "/state/key" }`** - reads from state model (one-way read)
- **`{ "$bindState": "/path" }`** - two-way binding: reads from state and enables write-back. Use on the natural value prop (value, checked, pressed, etc.) of form components.
- **`{ "$bindItem": "field" }`** - two-way binding to a repeat item field. Use inside repeat scopes.
- **`{ "$cond": <condition>, "$then": <value>, "$else": <value> }`** - conditional value

```json
{
  "type": "Input",
  "props": {
    "value": { "$bindState": "/form/email" },
    "placeholder": "Email"
  }
}
```

Components do not use a `statePath` prop for two-way binding. Use `{ "$bindState": "/path" }` on the natural value prop instead.

Components receive already-resolved props. For two-way bound props, use the `useBoundProp` hook with the `bindings` map the renderer provides.

## Event System

Components use `emit` to fire named events, or `on()` to get an event handle with metadata. The element's `on` field maps events to action bindings:

```tsx
// Simple event firing
Button: ({ props, emit }) => (
  <button onClick={() => emit("press")}>{props.label}</button>
),

// Event handle with metadata (e.g. preventDefault)
Link: ({ props, on }) => {
  const click = on("click");
  return (
    <a href={props.href} onClick={(e) => {
      if (click.shouldPreventDefault) e.preventDefault();
      click.emit();
    }}>{props.label}</a>
  );
},
```

```json
{
  "type": "Button",
  "props": { "label": "Submit" },
  "on": { "press": { "action": "submit" } }
}
```

The `EventHandle` returned by `on()` has: `emit()`, `shouldPreventDefault` (boolean), and `bound` (boolean).

## Built-in Actions

The `setState`, `pushState`, and `removeState` actions are built into the React schema and handled automatically by `ActionProvider`. They are injected into AI prompts without needing to be declared in catalog `actions`:

```json
{ "action": "setState", "params": { "statePath": "/activeTab", "value": "home" } }
{ "action": "pushState", "params": { "statePath": "/items", "value": { "text": "New" } } }
{ "action": "removeState", "params": { "statePath": "/items", "index": 0 } }
```

Note: `statePath` in action params (e.g. `setState.statePath`) targets the mutation path. Two-way binding in component props uses `{ "$bindState": "/path" }` on the value prop, not `statePath`.

## useBoundProp

For form components that need two-way binding, use `useBoundProp` with the `bindings` map the renderer provides when a prop uses `{ "$bindState": "/path" }` or `{ "$bindItem": "field" }`:

```tsx
import { useBoundProp } from "@json-render/react";

Input: ({ element, bindings }) => {
  const [value, setValue] = useBoundProp<string>(
    element.props.value,
    bindings?.value
  );
  return (
    <input
      value={value ?? ""}
      onChange={(e) => setValue(e.target.value)}
    />
  );
},
```

`useBoundProp(propValue, bindingPath)` returns `[value, setValue]`. The `value` is the resolved prop; `setValue` writes back to the bound state path (no-op if not bound).

## BaseComponentProps

For building reusable component libraries not tied to a specific catalog (e.g. `@json-render/shadcn`):

```typescript
import type { BaseComponentProps } from "@json-render/react";

const Card = ({ props, children }: BaseComponentProps<{ title?: string }>) => (
  <div>{props.title}{children}</div>
);
```

## defineRegistry

`defineRegistry` conditionally requires the `actions` field only when the catalog declares actions. Catalogs with `actions: {}` can omit it.

## Key Exports

| Export               | Purpose                                                     |
| -------------------- | ----------------------------------------------------------- |
| `defineRegistry`     | Create a type-safe component registry from a catalog        |
| `Renderer`           | Render a spec using a registry                              |
| `schema`             | Element tree schema (includes built-in state actions)       |
| `useStateStore`      | Access state context                                        |
| `useStateValue`      | Get single value from state                                 |
| `useBoundProp`       | Two-way binding for `$bindState`/`$bindItem` expressions    |
| `useActions`         | Access actions context                                      |
| `useAction`          | Get a single action dispatch function                       |
| `useUIStream`        | Stream specs from an API endpoint                           |
| `BaseComponentProps` | Catalog-agnostic base type for reusable component libraries |
| `EventHandle`        | Event handle type (`emit`, `shouldPreventDefault`, `bound`) |
| `ComponentContext`   | Typed component context (catalog-aware)                     |

# Dashboard Guide

Patterns and decisions for designing Home Assistant Lovelace dashboards.

## Table of Contents

- [Dashboard Structure](#dashboard-structure)
- [View Types](#view-types)
- [Built-in Cards](#built-in-cards)
- [Features](#features)
- [Actions](#actions)
- [Custom Cards](#custom-cards)
- [CSS Styling](#css-styling)
- [HACS Integration](#hacs-integration)
- [Complete Example: Multi-View Dashboard](#complete-example-multi-view-dashboard)
- [Common Pitfalls](#common-pitfalls)
- [Modern Best Practices (2024+)](#modern-best-practices-2024)
- [Visual Iteration Workflow](#visual-iteration-workflow)

---

## Dashboard Structure

```json
{
  "title": "My Home",
  "icon": "mdi:home",
  "config": {
    "views": [
      {
        "title": "Overview",
        "path": "home",
        "type": "sections",
        "max_columns": 4,
        "sections": [
          {"title": "Climate", "cards": [...]},
          {"title": "Lights", "cards": [...]}
        ]
      }
    ]
  }
}
```

**url_path rules:**
- New dashboards must contain a hyphen: `my-dashboard` (not `mydashboard`)
- Use `lovelace` to target the built-in default dashboard
- `dashboard_id`: internal identifier (returned on create, used for update/delete)
- `url_path`: URL identifier (user-facing, used in dashboard URLs)

---

## View Types

| Type | Use for |
|------|---------|
| `sections` | Most dashboards (RECOMMENDED) — grid-based, responsive |
| `panel` | Full-screen single cards (maps, cameras, iframes) |
| `sidebar` | Two-column layouts with primary/secondary content |
| `masonry` | Legacy — auto-arranges cards, less control |

### View Configuration

```json
{
  "title": "View Name",
  "path": "unique-path",
  "type": "sections",
  "icon": "mdi:icon",
  "max_columns": 4,
  "sections": [...],
  "subview": false,
  "badges": ["sensor.entity_id"],
  "background": {"image": "url(/local/background.jpg)", "opacity": 0.3}
}
```

---

## Built-in Cards

| Category | Cards |
|----------|-------|
| **Modern Primary** | tile, area, button, grid |
| **Container** | vertical-stack, horizontal-stack, grid |
| **Logic** | conditional, entity-filter |
| **Display** | sensor, history-graph, statistics-graph, gauge, energy, calendar, distribution |
| **Legacy Control** | entity, entities, light, thermostat (use tile instead) |

**Default:** Use `tile` card for most entities. Use `references/dashboard-cards.md` to look up all card types or fetch card-specific docs.

### Tile Card

```json
{
  "type": "tile",
  "entity": "climate.bedroom",
  "name": "Master Bedroom",
  "icon": "mdi:thermostat",
  "features": [
    {"type": "target-temperature"},
    {"type": "climate-hvac-modes", "style": "dropdown"}
  ],
  "tap_action": {"action": "more-info"}
}
```

### Grid Card

```json
{
  "type": "grid",
  "columns": 3,
  "square": false,
  "cards": [
    {"type": "tile", "entity": "light.kitchen"},
    {"type": "tile", "entity": "light.dining"},
    {"type": "tile", "entity": "light.hallway"}
  ]
}
```

---

## Features

Quick controls available on tile, area, humidifier, and thermostat cards.

| Domain | Feature types |
|--------|--------------|
| Climate | `climate-hvac-modes`, `climate-fan-modes`, `climate-preset-modes`, `target-temperature` |
| Light | `light-brightness`, `light-color-temp` |
| Cover | `cover-open-close`, `cover-position`, `cover-tilt` |
| Fan | `fan-speed`, `fan-direction`, `fan-oscillate` |
| Media | `media-player-playback`, `media-player-volume-slider` |
| Valve | `valve-open-close`, `valve-position` |
| Other | `toggle`, `button`, `alarm-modes`, `lock-commands`, `numeric-input`, `datetime-picker` |

### Tile Card Extras (2025.9+)

Tile cards support additional display features beyond controls:
- **Trend graph**: 24-hour history sparkline for numeric entities (enabled in tile card config)
- **Bar gauge**: Percentage-based bar display for numeric entities
- **Action buttons**: Run automations/scripts directly from tile cards

Feature `style` options: `"dropdown"` or `"icons"`

---

## Actions

```json
{
  "tap_action": {"action": "toggle"},
  "hold_action": {"action": "more-info"},
  "double_tap_action": {"action": "navigate", "navigation_path": "/lovelace/lights"}
}
```

Action types: `toggle`, `call-service`, `more-info`, `navigate`, `url`, `none`

### Visibility Conditions

```json
{
  "visibility": [
    {"condition": "user", "users": ["user_id_hex"]},
    {"condition": "state", "entity": "sun.sun", "state": "above_horizon"}
  ]
}
```

---

## Custom Cards

Use custom JavaScript cards when built-in cards don't support your visualization.

### Minimal Custom Card

```javascript
class MyCard extends HTMLElement {
  setConfig(config) {
    if (!config.entity) throw new Error("Please define an entity");
    this.config = config;
  }
  set hass(hass) {
    if (!this.content) {
      this.innerHTML = `<ha-card header="${this.config.title || 'My Card'}">
        <div class="card-content"></div>
      </ha-card>`;
      this.content = this.querySelector(".card-content");
    }
    const state = hass.states[this.config.entity];
    this.content.innerHTML = state ? `State: ${state.state}` : "Entity not found";
  }
  getCardSize() { return 2; }
}
customElements.define("my-card", MyCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "my-card", name: "My Card", description: "A custom card" });
```

Usage: `{"type": "custom:my-card", "entity": "sensor.temperature"}`

For isolated styling, use Shadow DOM (`this.attachShadow({ mode: "open" })`) and scope CSS inside the shadow root.

### Hosting

Use the HA dashboard resource API to convert inline code to a hosted URL, then register as a dashboard resource. Size limit: ~24KB source code.

### Custom Card Workflow

1. Write the card JavaScript class (see Minimal Custom Card above)
2. Register it as a dashboard resource via the HA REST API (`/api/config/lovelace/resources`) with `resource_type: "module"`
3. Use the card in your dashboard config with the `custom:` prefix

```json
{
  "type": "custom:quick-status-card",
  "entity": "sensor.temperature",
  "name": "Living Room"
}
```

---

## CSS Styling

### Theme Overrides

```css
:root {
  --primary-color: #03a9f4;
  --ha-card-background: rgba(26, 26, 46, 0.9);
  --ha-card-border-radius: 16px;
  --ha-card-box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}
```

### Card-mod (Per-Card Styling)

Requires the `card-mod` HACS component:

```yaml
type: entities
card_mod:
  style: |
    ha-card {
      --ha-card-background: teal;
      color: var(--primary-color);
    }
entities:
  - light.bed_light
```

---

## HACS Integration

| Use case | Solution |
|----------|----------|
| Popular community card | HACS — search and install via HACS API |
| Small custom styling | Inline CSS — register via HA dashboard resource API |
| One-off custom card | Inline module — register via HA dashboard resource API |
| Large/complex card | HACS or filesystem (`/config/www/`) |

### Finding and Installing Cards

Search HACS for community cards by name/category, review repository details, then install. HACS install operations are destructive — clients will ask for user confirmation.

### Popular HACS Cards

- **mushroom** — Modern, clean card collection
- **button-card** — Highly customizable buttons
- **mini-graph-card** — Compact graphs
- **card-mod** — CSS styling for any card
- **layout-card** — Advanced layout control
- **apexcharts-card** — Professional charts

---

## Complete Example: Multi-View Dashboard

```json
{
  "views": [
    {
      "title": "Overview",
      "path": "home",
      "type": "sections",
      "max_columns": 4,
      "badges": ["person.john", "person.jane"],
      "sections": [
        {
          "title": "Quick Actions",
          "cards": [{
            "type": "grid",
            "columns": 4,
            "square": false,
            "cards": [
              {"type": "button", "name": "Lights", "icon": "mdi:lightbulb", "tap_action": {"action": "navigate", "navigation_path": "/lovelace/lights"}},
              {"type": "button", "name": "Climate", "icon": "mdi:thermostat", "tap_action": {"action": "navigate", "navigation_path": "/lovelace/climate"}},
              {"type": "button", "name": "Security", "icon": "mdi:shield-home", "tap_action": {"action": "navigate", "navigation_path": "/lovelace/security"}},
              {"type": "button", "name": "Energy", "icon": "mdi:lightning-bolt", "tap_action": {"action": "navigate", "navigation_path": "/lovelace/energy"}}
            ]
          }]
        },
        {
          "title": "Favorites",
          "cards": [{
            "type": "grid",
            "columns": 3,
            "square": false,
            "cards": [
              {"type": "tile", "entity": "light.living_room", "features": [{"type": "light-brightness"}]},
              {"type": "tile", "entity": "climate.bedroom", "features": [{"type": "target-temperature"}]},
              {"type": "tile", "entity": "lock.front_door"}
            ]
          }]
        }
      ]
    },
    {
      "title": "Lights",
      "path": "lights",
      "type": "sections",
      "icon": "mdi:lightbulb",
      "max_columns": 3,
      "sections": [
        {
          "title": "Living Room",
          "cards": [{
            "type": "grid",
            "columns": 3,
            "cards": [
              {"type": "tile", "entity": "light.overhead", "features": [{"type": "light-brightness"}]},
              {"type": "tile", "entity": "light.lamp", "features": [{"type": "light-brightness"}]},
              {"type": "tile", "entity": "light.accent", "features": [{"type": "light-color-temp"}]}
            ]
          }]
        }
      ]
    }
  ]
}
```

---

## Common Pitfalls

| Issue | Solution |
|-------|----------|
| url_path rejected | New dashboards need a hyphen: `my-dashboard` not `mydashboard`. Use `lovelace` for the default dashboard. |
| Entity not found | Use full entity ID: `light.living_room` not `living_room` |
| Features not working | Match feature type to entity domain (e.g., `light-brightness` only works on `light.*`) |
| Custom card not loading | Check resource type is `module` and verify URL is accessible |
| Card too large for inline | Use HACS or filesystem instead |

---

## Modern Best Practices (2024+)

- Use **sections** view type with grid-based layouts
- Use **tile** cards as primary card type (replaces legacy entity/light/climate cards)
- Use **grid** cards for multi-column layouts within sections
- Create **multiple views** with navigation paths (avoid single-view endless scrolling)
- Use **area** cards with navigation for hierarchical organization

### Recent Dashboard Features (2026.2–2026.4)

| Feature | Version | Details |
|---------|---------|---------|
| **Distribution card** | 2026.2 | Proportional horizontal bars across multiple entities (power monitoring, storage usage) |
| **Section background colors** | 2026.4 | Sections support custom `background_color` with adjustable opacity |
| **Card favorites** | 2026.4 | Light color favorites and cover position favorites display on tile/light cards |
| **Auto-height cards** | 2026.4 | Cards auto-adjust height based on content via the layout editor |

**Legacy patterns to avoid:**
- Single-view dashboards with all cards in one long scroll
- Excessive use of vertical-stack/horizontal-stack instead of grid
- Masonry view (auto-layout) — use sections for precise control
- Putting all entities in generic "entities" cards

---

## Visual Iteration Workflow

For iterative dashboard design with visual feedback, add a browser automation MCP server:

### Recommended MCP Servers

- **Playwright MCP** (`@anthropic/mcp-playwright`) — Take screenshots, interact with pages
- **Puppeteer MCP** — Similar browser automation capabilities
- **Browser DevTools MCP** — Inspect elements, debug layouts

### Workflow

```
1. Create/update dashboard via the HA config API
2. Navigate browser to dashboard URL (e.g., http://homeassistant.local:8123/lovelace/my-dashboard)
3. Take screenshot to see current layout
4. Analyze screenshot for issues (spacing, alignment, colors)
5. Adjust configuration and repeat
```

### Example with Playwright MCP

```
1. Get the HA base URL from the system overview (e.g., "http://homeassistant.local:8123")
2. Update dashboard config via the HA REST API
3. Navigate browser to {base_url}/lovelace/{url_path}
4. Take screenshot → analyze → adjust → repeat
```

### Benefits

- See actual rendered output, not just JSON config
- Catch visual issues (card overlap, responsive breakpoints)
- Verify custom card styling
- Test on different viewport sizes

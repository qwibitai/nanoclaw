# Dashboard Card Types

Home Assistant provides 38 built-in card types. For card-specific documentation, fetch from GitHub on demand.

## Available Card Types

alarm-panel, area, button, calendar, clock, conditional, distribution, energy, entities, entity-filter, entity, gauge, glance, grid, heading, history-graph, horizontal-stack, humidifier, iframe, light, logbook, map, markdown, media-control, picture-elements, picture-entity, picture-glance, picture, plant-status, sensor, shopping-list, statistic, statistics-graph, thermostat, tile, todo-list, vertical-stack, weather-forecast

**Note:** The HA docs URL pattern also covers 4 view types (`masonry`, `panel`, `sections`, `sidebar`) — these are set at the view level via `"type"` in view config, NOT inside card arrays. See `references/dashboard-guide.md#view-types`.

## Fetching Card Documentation

To get detailed documentation for a specific card type, fetch from the Home Assistant docs:

```
https://raw.githubusercontent.com/home-assistant/home-assistant.io/refs/heads/current/source/_dashboards/{card_type}.markdown
```

Replace `{card_type}` with the card name from the list above (e.g., `tile`, `grid`, `button`).

If the MCP server registers resource URI templates for card docs, prefer those over raw GitHub fetches.

## Quick Card Selection Guide

| Need | Card |
|------|------|
| Control any entity | `tile` (modern default) |
| Layout multiple cards in columns | `grid` |
| Navigation button | `button` with `tap_action: navigate` |
| Room overview with controls | `area` |
| Historical data graph | `history-graph` or `statistics-graph` |
| Sensor value display | `sensor` or `gauge` |
| Proportional data across entities | `distribution` |
| Show/hide cards conditionally | `conditional` |
| Embed external page | `iframe` |
| Rich text / instructions | `markdown` |
| Camera or image with overlays | `picture-elements` |

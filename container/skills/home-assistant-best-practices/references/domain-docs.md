# Domain Documentation

To get detailed documentation for any Home Assistant integration or entity domain, fetch from the official docs on demand.

## Fetching Domain Docs

```
https://raw.githubusercontent.com/home-assistant/home-assistant.io/refs/heads/current/source/_integrations/{domain}.markdown
```

Replace `{domain}` with the integration name (e.g., `light`, `climate`, `mqtt`).

If the MCP server registers resource URI templates for domain docs, prefer those over raw GitHub fetches.

## Common Domains

| Domain | Description |
|--------|-------------|
| `light` | Light control (brightness, color, temperature) |
| `switch` | On/off switches |
| `climate` | HVAC and thermostat control |
| `cover` | Blinds, shades, garage doors |
| `fan` | Fan speed and oscillation |
| `lock` | Door locks |
| `media_player` | Media playback and volume |
| `vacuum` | Robot vacuum control |
| `sensor` | Numeric and text sensors |
| `binary_sensor` | On/off sensors (motion, door, window) |
| `automation` | Automation management |
| `script` | Script management |
| `scene` | Scene activation |
| `input_boolean` | Toggle helpers |
| `input_number` | Numeric input helpers |
| `input_select` | Dropdown helpers |
| `input_datetime` | Date/time helpers |
| `mqtt` | MQTT broker and entities |
| `zha` | Zigbee Home Automation |
| `notify` | Notification services |
| `tts` | Text-to-speech |
| `camera` | Camera feeds and snapshots |
| `weather` | Weather forecasts |
| `person` | Person/presence tracking |
| `zone` | Geographic zones |

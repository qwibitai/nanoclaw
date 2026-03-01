---
name: ha
description: Control Home Assistant — turn lights on/off, read sensor values, trigger automations, list entities. Use whenever the user asks about smart home devices.
allowed-tools: Bash(curl:*)
---

# Home Assistant REST API

Credentials are available as environment variables: `$HA_URL` and `$HA_TOKEN`.

## Examples

```bash
# List all entities
curl -s -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/states" | python3 -c "import json,sys; [print(e['entity_id'], e['state']) for e in json.load(sys.stdin)]"

# Get a single entity
curl -s -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/states/light.living_room"

# Turn on a light
curl -s -X POST -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" \
  -d '{"entity_id": "light.living_room"}' "$HA_URL/api/services/light/turn_on"

# Turn off a light
curl -s -X POST -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" \
  -d '{"entity_id": "light.living_room"}' "$HA_URL/api/services/light/turn_off"

# Call any service
curl -s -X POST -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" \
  -d '{"entity_id": "switch.fan"}' "$HA_URL/api/services/switch/toggle"

# Fire an event
curl -s -X POST -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/events/my_event"

# Check HA is reachable
curl -s -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/"
```

## Notes

- `jq` may not be in the container. Use Python to parse JSON:
  `python3 -c "import json,sys; data=json.load(sys.stdin); ..."`
- Entity IDs follow the pattern `domain.name` (e.g. `light.kitchen`, `sensor.temperature`, `switch.fan`)
- To find an entity ID, list all entities and filter by domain or name
- Service calls return `[]` on success

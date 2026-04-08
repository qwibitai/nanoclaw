# Home Assistant Direct Control

**Goal: Execute trivial HA requests in 1-2 tool calls. No tool discovery. No searching when entity is known.**

---

## Step 1 — Check Known Entities First

Before calling `ha_search_entities`, check if the entity is already listed below.
If found → skip search → go straight to `mcp__ha-mcp__ha_call_write_tool`. That's 1 tool call total.

### 💡 Lights

| Name | entity_id |
|------|-----------|
| Kitchen Lights (group) | `light.kitchen_lights` |
| Living Lights (group) | `light.living_lights` |
| Mamad / Work Room Lights (group) | `light.mamad_lights` |
| Hallway Light | `light.hallway_light` |
| Storage Light | `light.storage_light` |
| All Lights (group) | `light.all_lights` |
| Kitchen Island Light | `light.kitchen_island_light` |
| Kitchen Dining Table Light | `light.kitchen_dining_table_light` |
| Kitchen Hallway Light | `light.kitchen_hallway_light` |
| Mamad Desk Light | `light.mamad_desk_light` |
| Mamad Cubes Light | `light.mamad_cubes_light` |
| Mamad Main Light | `light.mamad_light` |
| Mirror / Entry Light | `light.entry_mirror_light` |
| Couch Light | `light.living_couch_light` |
| TV Light | `light.living_tv_light` |
| Living Desk Light | `light.living_desk_light` |

### ❄️ Climate (ACs)

| Name | entity_id |
|------|-----------|
| Living Room AC | `climate.living_ac` |
| Bedroom AC | `climate.bedroom_ac` |
| Boys Room AC | `climate.boys_ac` |
| Nikol Room AC | `climate.nikol_ac` |
| Work Room / Mamad AC | `climate.mamad_ac` |

### 📺 Media Players

| Name | entity_id |
|------|-----------|
| Living Room TV | `media_player.living_room_tv` |
| Bedroom TV | `media_player.bedroom_tv` |
| Kitchen TV | `media_player.kitchen_tv` |
| Sony XR-75X95L (Living) | `media_player.sony_xr_75x95l` |

### 🎛️ Input Booleans

| Name | entity_id |
|------|-----------|
| Security Armed | `input_boolean.security_armed` |
| Living Clock ON/OFF | `input_boolean.living_clock_on_off` |

### 🚨 Oref Alert

| Name | entity_id |
|------|-----------|
| Oref Alert (event — full data) | `event.oref_alert` |
| Oref Alert (binary on/off) | `binary_sensor.oref_alert` |
| Oref Alert (state string) | `sensor.oref_alert` |

### 🤖 Automations

| Name | entity_id |
|------|-----------|
| Oref Alert Main | `automation.oref_alert_main` |
| Boiler Safety Auto-Off | `automation.boiler_safety_auto_off` |
| Hallway Light On/Off | `automation.hallway_light_on_off` |
| Nikol Shutter Open Daily | `automation.nikol_shutter_open_daily` |

---

## Step 2 — Call the Tool Directly

### ✅ Correct tool names (use these exactly)

- **Write / control**: `mcp__ha-mcp__ha_call_write_tool`
- **Read / state**: `mcp__ha-mcp__ha_call_read_tool`
- **Search unknown entity**: `mcp__ha-mcp__ha_search_entities`

### Turn a light on/off
```
mcp__ha-mcp__ha_call_write_tool(
  name="ha_call_service",
  arguments={"domain": "light", "service": "turn_on", "entity_id": "light.kitchen_lights"}
)
```

### Turn light on with brightness/color
```
mcp__ha-mcp__ha_call_write_tool(
  name="ha_call_service",
  arguments={
    "domain": "light",
    "service": "turn_on",
    "entity_id": "light.living_couch_light",
    "data": {"brightness_pct": 50, "color_temp_kelvin": 3000, "transition": 2}
  }
)
```

### Turn off TV / media player
```
mcp__ha-mcp__ha_call_write_tool(
  name="ha_call_service",
  arguments={"domain": "media_player", "service": "turn_off", "entity_id": "media_player.living_room_tv"}
)
```

### Set AC temperature
```
mcp__ha-mcp__ha_call_write_tool(
  name="ha_call_service",
  arguments={
    "domain": "climate",
    "service": "set_temperature",
    "entity_id": "climate.living_ac",
    "data": {"temperature": 22, "hvac_mode": "cool"}
  }
)
```

### Turn off AC
```
mcp__ha-mcp__ha_call_write_tool(
  name="ha_call_service",
  arguments={"domain": "climate", "service": "turn_off", "entity_id": "climate.bedroom_ac"}
)
```

### Read entity state
```
mcp__ha-mcp__ha_call_read_tool(
  name="ha_get_state",
  arguments={"entity_id": "sensor.oref_alert"}
)
```

### Toggle a switch
```
mcp__ha-mcp__ha_call_write_tool(
  name="ha_call_service",
  arguments={"domain": "switch", "service": "toggle", "entity_id": "switch.example"}
)
```

---

## Service Quick Reference

| Domain | Services | Data params |
|--------|----------|-------------|
| `light` | `turn_on`, `turn_off`, `toggle` | `brightness_pct` (0-100), `color_temp_kelvin`, `rgb_color`, `transition` |
| `media_player` | `turn_on`, `turn_off`, `media_play`, `media_pause`, `volume_set` | `volume_level` (0.0–1.0) |
| `climate` | `set_temperature`, `set_hvac_mode`, `turn_off` | `temperature`, `hvac_mode` (cool/heat/auto/dry/fan_only) |
| `switch` | `turn_on`, `turn_off`, `toggle` | — |
| `cover` | `open_cover`, `close_cover`, `set_cover_position` | `position` (0–100) |
| `scene` | `turn_on` | — |
| `automation` | `trigger`, `turn_on`, `turn_off` | — |
| `script` | `turn_on` | — |
| `input_boolean` | `turn_on`, `turn_off`, `toggle` | — |
| `homeassistant` | `toggle`, `turn_on`, `turn_off` | Works on any entity as fallback |

---

## Decision Flow

```
User asks to control a device
        │
        ▼
Is entity_id in the Known Entities tables above?
   YES → mcp__ha-mcp__ha_call_write_tool immediately (1 tool call) ✅
    NO → mcp__ha-mcp__ha_search_entities first, then ha_call_write_tool (2 tool calls)
        │
        ▼
Read-only request (check state, check who's home, last alert)?
        → mcp__ha-mcp__ha_call_read_tool with ha_get_state
```

---

## Single Light vs All Lights in Area

Use this rule to decide which entity to target:

| User says | Interpretation | Entity to use |
|-----------|---------------|---------------|
| "turn on kitchen light" | The main/primary kitchen light | `light.kitchen_light` (single bulb) |
| "turn on kitchen lights" | All lights in the kitchen | `light.kitchen_lights` (group) |
| "turn on all kitchen lights" | All lights in the kitchen | `light.kitchen_lights` (group) |
| "turn on the light in the kitchen" | Main kitchen light | `light.kitchen_light` (single) |
| "turn on living room light" | Main living room light | search for `light.living_light` or closest match |
| "turn on living lights" / "all living lights" | Group | `light.living_lights` |

**Rule of thumb:**
- Singular + no "all" → single specific light (look for `light.<room>_light`)
- Plural OR "all" → room group (look for `light.<room>_lights`)
- When in doubt → use the group (safer, user can always ask for specific)

---

## ❌ Common Mistakes to Avoid

| Wrong | Right |
|-------|-------|
| `mcp__ha_mcp__ha_call_service(...)` | `mcp__ha-mcp__ha_call_write_tool(name="ha_call_service", ...)` |
| Calling `ha_search_tools` for basic on/off | Tools are listed above — skip discovery |
| `data: { entity_id: "..." }` | `entity_id` is a top-level argument, not inside `data` |
| `ha_get_overview` to find a single entity | Use `ha_search_entities` |
| `device_id` in target | Always use `entity_id` (stable across device re-adds) |

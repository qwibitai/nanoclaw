# Safe Refactoring Workflow

Follow this workflow whenever you modify existing Home Assistant configuration: renaming entities, replacing template sensors with helpers, converting device triggers, or restructuring automations.

**Core rule:** Search all consumers BEFORE changing anything. Verify zero stale references AFTER.

---

## Universal Workflow

### Step 1: Identify the full scope of change

Answer three questions before touching anything:

1. **What changes?** Entity ID, automation structure, sensor type, or trigger semantics.
2. **What sibling entities share the same device?** Query the device to list every entity it owns (battery sensor, update entity, diagnostic button). Plan changes for all siblings together.
   - Query the device via the HA REST API (`GET /api/states/<entity_id>`) or inspect Settings > Devices.
3. **Rename one entity or all device entities?** Devices bundle 2-6 entities. Renaming the primary but leaving siblings with the old naming scheme creates inconsistency.

### Step 2: Search ALL consumers

Search every component type that references entity IDs. Do not limit searches to the component you are editing.

| Component | How to search |
|-----------|---------------|
| Automations | Search automations for the entity ID via the HA API or grep `automations.yaml` |
| Dashboards | Search dashboard configs for the entity ID via the HA API or grep `.storage/lovelace*`, `ui-lovelace.yaml` |
| Scripts | grep `scripts.yaml` |
| Scenes | grep `scenes.yaml` |
| Config-Entry-based groups | `GET /api/config/config_entries/entry?type=config&domain=group` — members in `options.entities`; entity registry renames do NOT update these automatically (→ see Config-Entry-Groups section) |
| Config-Entry integrations (Better Thermostat, Generic Thermostat, Generic Hygrostat, Threshold Helper, Min/Max Helper) | `GET /api/config/config_entries/entry` — scan `data` and `options` fields for the old entity ID; entity registry renames do NOT update these fields automatically (→ see Config-Entry-Data section) |
| Other | Check AppDaemon apps, Node-RED flows, Pyscript scripts, or any custom integration that references entity IDs |

Record every location found. This list becomes your update checklist for Step 4.

### Step 3: Make the change

Rename the entity, replace the template sensor, or restructure the automation.

### Step 4: Update every consumer

Work through each location from your Step 2 checklist. Update every reference to the new entity ID, helper entity, or automation structure.

### Step 5: Verify

1. **Search for the OLD identifier** across all component types. Expect zero results.
   - Search for the old entity ID via the HA API or grep all config files.
2. **Search for the NEW identifier** to confirm all expected locations reference it.
3. **Reload or check dashboards** if entity IDs changed.
4. **If stale references remain that you cannot update**, rename the entity back to its original ID to restore functionality, then report the blocking locations to the user.

---

## Entity Renames

Additional requirements beyond the universal workflow:

**Device-sibling discovery (Step 1):**
HA devices bundle multiple entities. A smart plug might expose `switch.*`, `sensor.*_energy`, and `update.*`. A multi-sensor exposes motion, temperature, illuminance, and battery entities. Rename all siblings to match.

Example — renaming a smart plug's entities from manufacturer defaults to room-based names:

| Domain | Old entity ID | New entity ID |
|---|---|---|
| switch | `switch.shellyplug_s_a1b2c3d4e5f6` | `switch.office_heater` |
| sensor | `sensor.shellyplug_s_a1b2c3d4e5f6_energy` | `sensor.office_heater_energy` |
| update | `update.shellyplug_s_a1b2c3d4e5f6` | `update.office_heater` |

**Dashboard reference locations (Step 2):**
Dashboard cards reference entities in multiple places. Search all of these:

- `entity:` field
- `tap_action` and `hold_action` targets
- Conditional card conditions
- Template card Jinja2 blocks
- `views[n].badges` — badge rows per view; badges are siblings of the cards array, not children, so any card-focused search will miss them — always search the full dashboard config
- `views[n].header.card` — sections view only (HA 2025.3+); the view header accepts a Markdown card that supports Jinja2 templates and may contain entity references; it is a sibling of the cards array and is not reachable via card-focused search

---

## Helper Replacements

When replacing a template sensor with a built-in helper (`min_max`, `threshold`, `derivative`):

**New entity ID (Step 1):**
The helper creates a new entity with a different entity_id. The old template sensor's entity_id stops existing. Update every consumer of the old entity_id to reference the new one.

**Test equivalence (Step 5):**
Verify the new helper produces the same values as the old template sensor. Check units, precision, and unavailable-state handling.

---

## Trigger Restructuring

When converting `device_id` triggers to `entity_id` triggers, or replacing `wait_template` with `wait_for_trigger`:

**Behavioral equivalence (Step 1):**
`wait_for_trigger` waits for a state *change*; `wait_template` polls for *current state*. These differ when the target state is already true at wait start: `wait_for_trigger` blocks indefinitely, `wait_template` returns immediately.

**Automation callers (Step 2):**
Search for scripts or other automations that call the automation you are restructuring via `automation.trigger` or `automation.turn_on`. Renaming or splitting an automation changes its entity_id and breaks these callers.

---

## Config-Entry-Groups

When renaming entities that are members of a HA **group** created via the UI (Config-Entry-based group, platform: `group`):

**Entity registry renames do NOT update group members automatically.**

Group member entity IDs are stored in `options.entities` of the group's Config Entry — not in the entity registry. A registry rename leaves the group referencing the old (now non-existent) entity ID, silently breaking it.

**Detection (Step 2):**
List all Config-Entry-based groups to get their `entry_id` values:

```http
GET /api/config/config_entries/entry?type=config&domain=group
```

> **Note:** Some HA MCP integrations may not expose all fields from the Config Entries API
> response — in particular, `options.entities` may be absent. Use the REST endpoint above
> to confirm current group members directly.

To inspect current members of a specific group, initiate an Options Flow and read
`suggested_value` in the returned `data_schema.entities` field:

```http
POST /api/config/config_entries/options/flow
{"handler": "<group_config_entry_id>"}
```

> **One active flow per Config Entry:** HA allows only one active Options Flow per Config
> Entry at a time. If you open a detection flow to read current values, abandon or complete
> it before initiating the fix flow. To abandon:
>
> ```http
> DELETE /api/config/config_entries/options/flow/<flow_id>
> ```

**Fix (Step 4):**
After the registry rename, update group membership via the Options Flow.

1. Initiate a new fix flow (the detection flow from above must be abandoned or completed
   first). Read the current option values from `suggested_value`. Note the `flow_id`:

```http
POST /api/config/config_entries/options/flow
{"handler": "<group_config_entry_id>"}
```

2. Submit the updated member list, preserving existing `hide_members` value.
   Include `all` only if it was present in the step 1 `data_schema` response — only
   `light`, `switch`, and `binary_sensor` groups support it. For all other group types
   (fan, lock, media_player, sensor, etc.) omit `all` entirely:

```http
POST /api/config/config_entries/options/flow/<flow_id>
{"entities": ["new.entity_id_1", "new.entity_id_2"], "hide_members": <suggested_value>}
```

   If the group type supports `all`, add it explicitly:

```http
POST /api/config/config_entries/options/flow/<flow_id>
{"entities": ["new.entity_id_1", "new.entity_id_2"], "hide_members": <suggested_value>, "all": <suggested_value>}
```

> **Safe rule:** Always derive field presence from the step 1 `data_schema` response —
> never hardcode fields. Submitting unknown fields may result in a validation error.

**Verify (Step 5):**
Re-initiate the Options Flow for the group's `entry_id` and confirm that `suggested_value`
for `entities` contains only the updated entity IDs. The REST endpoint
`GET /api/config/config_entries/entry` does not expose `options.entities` — the Options
Flow is the only way to read current group members.


## Config-Entry Data — Blind Spots for entity registry renames

**Entity registry renames only update the Entity Registry.** Integrations that collect entity_ids during their setup flow store them in the Config Entry — not in YAML and not in the Entity Registry. A registry rename leaves these references pointing to the old (now non-existent) entity ID.

**Affected integrations and storage fields:**

| Integration | Storage field | Fields containing entity_ids |
|---|---|---|
| **Better Thermostat** | `data` (not accessible via REST — see note below) | `temperature_sensor`, `humidity_sensor`, `outdoor_sensor`, `window_sensors` |
| Generic Thermostat | `options` | `heater`, `target_sensor` |
| Generic Hygrostat | `options` | `humidifier`, `target_sensor` |
| Threshold Helper | `options` | `entity_id` |
| Min/Max Helper | `options` | `entity_ids` |

**Symptom:** Integration reports "associated entity missing" or behaves incorrectly after restart.

**Timing:** Patch Config-Entry data fields **before the HA restart**. An integration that starts with stale entity_ids can cause integration setup failures on restart.

**Scan via REST API:**
```http
GET /api/config/config_entries/entry
```
Iterate the returned entries and check `data` and `options` fields for the old entity ID.

> **Note:** Some custom integrations (including Better Thermostat) do not expose their entity references in `data` or `options` via this endpoint — the fields may appear empty even when the integration is configured. For these integrations, the REST scan will return no matches; the Fix section below documents whether an alternative fix path exists.

**Fix:**

For integrations that store entity_ids in `options` (Generic Thermostat, Generic Hygrostat, Threshold Helper, Min/Max Helper): use the Options Flow. See the Config-Entry-Groups section above for the full Options Flow pattern.

For integrations that store entity_ids in `data` (Better Thermostat): `data` fields written during the initial Config Flow setup have no standard API for post-setup mutation — the Options Flow updates `options` only. No API-based fix path exists. Document this limitation to the user before proceeding with a rename.

---


## Storage-Mode-Dashboards (`.storage/lovelace.*`)

**Entity registry renames do NOT update Lovelace storage dashboards.**

**Recommended fix — no restart required:**

Use the Lovelace WebSocket API (`lovelace/config` to read, `lovelace/config/save` to write):

```
1. Read dashboard config:
   WebSocket: {"type": "lovelace/config", "url_path": "<dashboard_url_path>"}
   Note: the default (Overview) dashboard requires `"url_path": null`; custom dashboards use their string path.
   → returns full dashboard config (JSON)

2. Replace entity IDs (Python — JSON-aware, boundary-safe):
   def _replace_ids(obj, old_id, new_id):
       if isinstance(obj, str): return new_id if obj == old_id else obj
       if isinstance(obj, list): return [_replace_ids(i, old_id, new_id) for i in obj]
       if isinstance(obj, dict): return {(new_id if k == old_id else k): _replace_ids(v, old_id, new_id) for k, v in obj.items()}
       return obj
   new_config = _replace_ids(config, "old.entity_id", "new.entity_id")
   # Note: string replace on json.dumps() is not boundary-safe — it matches entity IDs
   # that appear as JSON keys or as substrings of other strings in the serialized output.

3. Write dashboard config:
   WebSocket: {"type": "lovelace/config/save", "url_path": "<dashboard_url_path>", "config": new_config}
   Note: use `"url_path": null` for the default (Overview) dashboard; use the string path for custom dashboards.
   → takes effect immediately, no restart required
```



**List all storage dashboards:**
WebSocket: `{"type": "lovelace/dashboards/list"}` → returns all dashboards with their url_path.

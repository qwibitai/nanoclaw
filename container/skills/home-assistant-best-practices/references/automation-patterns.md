# Automation Patterns

This document covers native Home Assistant automation constructs that should be used instead of templates.

## Table of Contents
1. [Native Conditions](#native-conditions)
2. [Trigger Types](#trigger-types)
3. [Wait Actions](#wait-actions)
4. [Automation Modes](#automation-modes)
5. [Continue on Error](#continue-on-error)
6. [Repeat Actions](#repeat-actions)
7. [if/then vs choose](#ifthen-vs-choose)
8. [Trigger IDs](#trigger-ids)
9. [Disabling Automations](#disabling-automations)

---

## Native Conditions

### State Condition

The most common condition type. Supports multiple states, attributes, and duration.

```yaml
# Single state
condition: state
entity_id: light.living_room
state: "on"

# Multiple acceptable states (OR logic)
condition: state
entity_id: vacuum.robot
state:
  - "cleaning"
  - "returning"

# Attribute check
condition: state
entity_id: climate.thermostat
attribute: hvac_action
state: "heating"

# Duration check (entity has been in state for X time)
condition: state
entity_id: binary_sensor.motion
state: "off"
for:
  minutes: 5
```

### Numeric State Condition

For numeric comparisons. Always prefer over template conditions with `| float`.

```yaml
# Above threshold
condition: numeric_state
entity_id: sensor.temperature
above: 25

# Below threshold
condition: numeric_state
entity_id: sensor.humidity
below: 30

# Range
condition: numeric_state
entity_id: sensor.battery
above: 20
below: 80

# Attribute numeric check
condition: numeric_state
entity_id: sun.sun
attribute: elevation
below: -6
```

### Time Condition

For time-based restrictions. Handles midnight crossing automatically.

```yaml
# Time range (handles midnight crossing!)
condition: time
after: "22:00:00"
before: "06:00:00"

# Weekday filter
condition: time
weekday:
  - mon
  - tue
  - wed
  - thu
  - fri

# Combined
condition: time
after: "09:00:00"
before: "17:00:00"
weekday:
  - mon
  - tue
  - wed
  - thu
  - fri
```

### Sun Condition

For sunrise/sunset-based logic with optional offsets.

```yaml
# After sunset
condition: sun
after: sunset

# Before sunrise with offset
condition: sun
before: sunrise
before_offset: "01:00:00"

# After sunset by 30 minutes
condition: sun
after: sunset
after_offset: "00:30:00"
```

### Zone Condition

For presence detection based on zones.

```yaml
condition: zone
entity_id: person.john
zone: zone.home

# Or check if NOT in zone
condition: not
conditions:
  - condition: zone
    entity_id: person.john
    zone: zone.home
```

### And/Or/Not Conditions

Combine conditions with logical operators.

```yaml
# AND (default when multiple conditions listed)
condition: and
conditions:
  - condition: state
    entity_id: light.kitchen
    state: "on"
  - condition: numeric_state
    entity_id: sensor.brightness
    below: 100

# OR
condition: or
conditions:
  - condition: state
    entity_id: person.john
    state: "home"
  - condition: state
    entity_id: person.jane
    state: "home"

# NOT
condition: not
conditions:
  - condition: state
    entity_id: alarm_control_panel.home
    state: "armed_away"

# Shorthand syntax
conditions:
  - and:
      - condition: state
        entity_id: input_boolean.guest_mode
        state: "on"
      - condition: time
        after: "08:00:00"
```

### Template Condition Shorthand

When you must use a template, use the shorthand syntax:

```yaml
# Shorthand (preferred when template is necessary)
conditions:
  - "{{ trigger.to_state.attributes.brightness > 100 }}"

# Long form (equivalent)
conditions:
  - condition: template
    value_template: "{{ trigger.to_state.attributes.brightness > 100 }}"
```

---

## Trigger Types

### Purpose-Specific Triggers (2026.2+)

The HA visual automation editor offers **purpose-specific triggers and conditions** organized by real-world concepts (door opened, motion detected, temperature threshold, battery low, etc.) rather than by technical entity domain. These work across entity types — e.g., "when a door opens" fires whether the door is a contact sensor or a motorized cover.

**Key points:**
- This is a **UI editor feature** — under the hood, it generates standard `state`, `numeric_state`, and other trigger types
- No new YAML trigger syntax — the YAML output uses the same triggers documented below
- Available concepts: door/window/gate open/close, motion/occupancy detection, temperature/humidity/illuminance thresholds, power consumption, battery status, air quality, climate, and more
- When creating automations via the API, use the standard YAML trigger types below

### State Trigger

The workhorse trigger. Fires on entity state changes.

```yaml
# Basic state change to specific value
triggers:
  - trigger: state
    entity_id: binary_sensor.motion
    to: "on"

# From specific state
triggers:
  - trigger: state
    entity_id: light.bedroom
    from: "off"
    to: "on"

# Any state change (omit to/from)
triggers:
  - trigger: state
    entity_id: sensor.temperature

# Attribute change
triggers:
  - trigger: state
    entity_id: climate.thermostat
    attribute: current_temperature

# Duration trigger (entity has been in state for X)
triggers:
  - trigger: state
    entity_id: light.porch
    to: "on"
    for:
      minutes: 30

# Multiple entities
triggers:
  - trigger: state
    entity_id:
      - binary_sensor.motion_kitchen
      - binary_sensor.motion_hallway
    to: "on"
```

### Numeric State Trigger

Fires when crossing a threshold.

```yaml
triggers:
  - trigger: numeric_state
    entity_id: sensor.temperature
    above: 25
    for:
      minutes: 5
```

### Time Trigger

Fires at specific times.

```yaml
# Fixed time
triggers:
  - trigger: time
    at: "07:00:00"

# Input datetime helper
triggers:
  - trigger: time
    at: input_datetime.morning_alarm

# Time pattern (every 5 minutes)
triggers:
  - trigger: time_pattern
    minutes: "/5"

# Every hour at :30
triggers:
  - trigger: time_pattern
    minutes: 30
```

### Sun Trigger

Fires at sunrise/sunset with optional offset.

```yaml
triggers:
  - trigger: sun
    event: sunset
    offset: "-00:30:00"  # 30 minutes before sunset
```

### Event Trigger

Fires on Home Assistant events.

```yaml
# ZHA button event
triggers:
  - trigger: event
    event_type: zha_event
    event_data:
      device_ieee: "00:11:22:33:44:55:66:77"
      command: "on"

# Custom event
triggers:
  - trigger: event
    event_type: my_custom_event
```

### MQTT Trigger

Fires on MQTT messages.

```yaml
triggers:
  - trigger: mqtt
    topic: "zigbee2mqtt/button/action"
    payload: "single"
```

### Device Trigger (Use Sparingly)

Device triggers use device_id which is NOT persistent. Prefer state triggers.

```yaml
# Avoid when possible - device_id changes on re-add
triggers:
  - trigger: device
    domain: mqtt
    device_id: abc123
    type: action
    subtype: single
```

---

## Wait Actions

### wait_for_trigger (Preferred)

Event-driven wait. More efficient than polling.

```yaml
# Wait for door to close
- wait_for_trigger:
    - trigger: state
      entity_id: binary_sensor.door
      to: "off"
  timeout:
    minutes: 5
  continue_on_timeout: false  # Stop automation if timeout

# Wait for any of multiple triggers
- wait_for_trigger:
    - trigger: state
      entity_id: binary_sensor.door
      to: "off"
    - trigger: event
      event_type: mobile_app_notification_action
      event_data:
        action: "CLOSE_DOOR"
```

### wait_template (Use Sparingly)

Polls until template is true. **Immediately continues if already true.**

```yaml
# Only use when wait_for_trigger cannot express the condition
- wait_template: "{{ states('sensor.temperature') | float > 25 }}"
  timeout:
    minutes: 10
```

**Key difference:**
- `wait_for_trigger` waits for a **change** to occur
- `wait_template` waits for a **condition** to be true (passes immediately if already true)

### Checking Wait Results

Both waits set `wait.completed` and `wait.remaining`:

```yaml
- wait_for_trigger:
    - trigger: state
      entity_id: binary_sensor.door
      to: "off"
  timeout:
    minutes: 5

- if:
    - "{{ not wait.completed }}"
  then:
    - action: notify.mobile_app
      data:
        message: "Door still open after 5 minutes!"
```

---

## Automation Modes

The `mode` determines what happens when an automation triggers while already running.

### single (Default)

New triggers are ignored while running. A warning is logged.

**Best for:** One-shot notifications, actions that shouldn't overlap.

```yaml
automation:
  - alias: "Doorbell notification"
    mode: single
    triggers:
      - trigger: state
        entity_id: binary_sensor.doorbell
        to: "on"
    actions:
      - action: notify.mobile_app
        data:
          message: "Someone at the door!"
```

### restart

Stops the current run and starts fresh. Timer-based actions are reset.

**Best for:** Motion-activated lights with timeout, retriggerable delays.

```yaml
mode: restart  # Re-trigger resets the timer
```

See `references/examples.yaml` Example 1 for a complete motion-light automation using restart + wait_for_trigger.

### queued

Queues new triggers to run after current run completes.

**Best for:** Sequential actions, door locks, garage doors.

```yaml
automation:
  - alias: "Garage door controller"
    mode: queued
    max: 5  # Maximum queue size
    triggers:
      - trigger: state
        entity_id: input_boolean.garage_door_trigger
        to: "on"
    actions:
      - action: cover.toggle
        target:
          entity_id: cover.garage_door
      - delay:
          seconds: 20  # Wait for door to fully open/close
```

### parallel

Runs multiple instances simultaneously.

**Best for:** Per-entity actions with `trigger.entity_id`, notifications that shouldn't block.

```yaml
automation:
  - alias: "Window open too long"
    mode: parallel
    max: 10  # Maximum parallel runs
    triggers:
      - trigger: state
        entity_id:
          - binary_sensor.window_bedroom
          - binary_sensor.window_kitchen
          - binary_sensor.window_living
        to: "on"
        for:
          minutes: 30
    actions:
      - action: notify.mobile_app
        data:
          message: "{{ trigger.to_state.name }} has been open for 30 minutes"
```

### max_exceeded

Control logging when max runs are exceeded:

```yaml
automation:
  - alias: "Quiet automation"
    mode: single
    max_exceeded: silent  # No warning logged
```

---

## Continue on Error

Any automation action can be set to continue execution even if it fails, using the `continue_on_error` key. Since 2026.3, this is also configurable in the visual editor (three-dots menu on any action).

```yaml
actions:
  - action: light.turn_on
    target:
      entity_id: light.patio
    continue_on_error: true  # Automation proceeds even if this fails
  - action: notify.mobile_app
    data:
      message: "Light action attempted"
```

**Use sparingly** — silently swallowing errors makes debugging harder. Best for non-critical actions (e.g., logging, optional notifications) where a failure shouldn't block the rest of the automation.

---

## Repeat Actions

Four repeat variants are available:

```yaml
# Repeat N times
- repeat:
    count: 3
    sequence:
      - action: light.toggle
        target:
          entity_id: light.bedroom

# Repeat while condition is true
- repeat:
    while:
      - condition: state
        entity_id: binary_sensor.door
        state: "on"
    sequence:
      - action: notify.mobile_app
        data:
          message: "Door still open"
      - delay:
          minutes: 5

# Repeat until condition is true
- repeat:
    until:
      - condition: numeric_state
        entity_id: sensor.temperature
        below: 25
    sequence:
      - delay:
          minutes: 1

# Repeat for each item in a list
- repeat:
    for_each:
      - "light.kitchen"
      - "light.bedroom"
      - "light.hallway"
    sequence:
      - action: light.turn_off
        target:
          entity_id: "{{ repeat.item }}"
```

Access `repeat.index` (1-based) and `repeat.item` (for `for_each`) inside the sequence.

---

## if/then vs choose

### if/then/else

Use for simple binary conditions:

```yaml
actions:
  - if:
      - condition: state
        entity_id: sun.sun
        state: "below_horizon"
    then:
      - action: light.turn_on
        target:
          entity_id: light.porch
    else:
      - action: light.turn_off
        target:
          entity_id: light.porch
```

### choose

Use for multiple branches (like switch/case):

```yaml
actions:
  - choose:
      - conditions:
          - condition: trigger
            id: "morning"
        sequence:
          - action: scene.turn_on
            target:
              entity_id: scene.morning

      - conditions:
          - condition: trigger
            id: "evening"
        sequence:
          - action: scene.turn_on
            target:
              entity_id: scene.evening

    default:
      - action: light.turn_off
        target:
          area_id: living_room
```

---

## Trigger IDs

Assign IDs to triggers for use in conditions and choose:

```yaml
automation:
  - alias: "Multi-trigger automation"
    triggers:
      - trigger: state
        entity_id: binary_sensor.motion
        to: "on"
        id: "motion_on"

      - trigger: state
        entity_id: binary_sensor.motion
        to: "off"
        for:
          minutes: 5
        id: "motion_off"

    actions:
      - choose:
          - conditions:
              - condition: trigger
                id: "motion_on"
            sequence:
              - action: light.turn_on
                target:
                  entity_id: light.hallway

          - conditions:
              - condition: trigger
                id: "motion_off"
            sequence:
              - action: light.turn_off
                target:
                  entity_id: light.hallway
```

Access trigger info in templates with `trigger.id`, `trigger.entity_id`, `trigger.to_state`, etc.

---

## Disabling Automations

Home Assistant provides two distinct ways to disable an automation, with different persistence and behavior.

### Method 1: Turn Off (Temporary, State Machine)

`automation.turn_off` disables the automation's configured triggers — it will not fire automatically. The entity remains in the state machine with state `off` and can still be invoked via the `automation.trigger` service.

```yaml
- action: automation.turn_off
  target:
    entity_id: automation.my_automation
  data:
    stop_actions: true  # default: true — stops currently running actions
```

| Attribute | Value |
| --- | --- |
| `stop_actions` | Optional. Stops currently active action runs. **Defaults to `true`.** |
| Survives reload? | Yes — state is stored in `core.restore_state` |
| Survives restart? | Only if the automation has an `id:` field — `core.restore_state` matches by `entity_id`, which is derived from `alias:` without `id:` and is unstable if automations are added, removed, or have conflicting aliases |
| Entity in state machine? | Yes — state is `off` |
| Re-enable via | `automation.turn_on` |

**`initial_state` override:** If the automation YAML contains an explicit `initial_state` value, it overrides the stored state after a restart (`true` forces on, `false` forces off regardless of stored state).

### Method 2: Registry Disable (Permanent, via Entity Registry)

Disabling an automation via *Settings → Automations → open automation → ⋮ → Settings → Enabled toggle* sets `disabled_by: user` in `core.entity_registry`. The entity is removed from the state machine entirely.

| Attribute | Value |
| --- | --- |
| Survives reload? | Yes — stored in `core.entity_registry` |
| Survives restart? | Yes |
| Entity in state machine? | **No** — `GET /api/states/<entity_id>` returns 404 |
| Requires `id:` field? | Yes — the `id:` field in `automations.yaml` becomes the automation's `unique_id`, which is required for an entity registry entry |
| Re-enable via | UI toggle (*Settings → Automations → open automation → ⋮ → Settings → Enabled toggle*) or WebSocket API (`config/entity_registry/update` with `{"disabled_by": null}`) |

**Note:** The list toggle on the Automations page (`/config/automation/dashboard`) calls `automation.turn_on`/`turn_off` (Method 1). The *Enabled toggle* under *Settings → Automations → open automation → ⋮ → Settings → Enabled toggle* modifies the entity registry (Method 2). Both can be active simultaneously — an automation can be registry-enabled but in state `off`, or registry-disabled but with a stored `on` state.

### AVOID: `enabled: false` in automations.yaml

```yaml
# AVOID — enabled: is not a valid top-level key
- alias: My Automation
  enabled: false       # not a valid top-level key
  triggers: ...
```

`enabled:` is **not** a valid top-level key in `automations.yaml`. Home Assistant rejects unknown keys during schema validation, so the automation loads as `unavailable`.

```yaml
# CORRECT — disable temporarily via service (Method 1)
- action: automation.turn_off
  target:
    entity_id: automation.my_automation

# CORRECT — disable permanently via entity registry (Method 2)
# UI: Settings → Automations → open automation → ⋮ → Settings → Enabled toggle
# Or via WebSocket API: config/entity_registry/update (disabled_by: user)
```

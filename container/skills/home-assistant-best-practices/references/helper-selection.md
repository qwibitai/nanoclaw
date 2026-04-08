# Helper Selection Guide

This document covers Home Assistant's built-in helpers and integrations that should be used instead of template sensors or complex automations.

## Table of Contents
1. [Numeric Aggregation](#numeric-aggregation) - min_max, statistics
2. [Rate and Change](#rate-and-change) - derivative, threshold
3. [Time-Based Tracking](#time-based-tracking) - utility_meter, history_stats, integration (Riemann sum)
4. [State Storage](#state-storage) - input_boolean, input_number, input_select, input_text, input_datetime, input_button
5. [Counting and Timing](#counting-and-timing) - counter, timer
6. [Scheduling](#scheduling) - schedule, time of day (tod)
7. [Entity Grouping](#entity-grouping) - group, binary sensor groups

---

## Numeric Aggregation

### min_max

**Use for:** Combining multiple sensors to get min, max, mean, median, sum, or last value across all of them.

**Instead of:**
```yaml
# WRONG - Template sensor for averaging
template:
  - sensor:
      - name: "Average Temperature"
        state: >
          {{ ((states('sensor.temp_bedroom') | float) +
              (states('sensor.temp_living') | float) +
              (states('sensor.temp_kitchen') | float)) / 3 }}
```

**Use this:**
```yaml
# RIGHT - min_max helper
sensor:
  - platform: min_max
    name: "Average Temperature"
    type: mean
    entity_ids:
      - sensor.temp_bedroom
      - sensor.temp_living
      - sensor.temp_kitchen
```

**Available types:** `min`, `max`, `mean`, `median`, `last`, `sum`

**Key behaviors:**
- Ignores `unknown` states (except `sum` which goes to unknown)
- Returns error if unit of measurement differs between sensors
- For spiky values, filter with statistics sensor first

**Common uses:**
- Average house temperature from multiple room sensors
- Maximum power consumption across circuits
- Sum of all solar panel production sensors

---

### statistics

**Use for:** Statistical analysis over time for a single sensor (mean, median, stdev, change, variance, etc.).

**Instead of:**
```yaml
# WRONG - Complex template tracking history
template:
  - sensor:
      - name: "Temperature Change"
        state: "{{ states('sensor.temp') | float - state_attr('sensor.temp', 'last_value') | float(0) }}"
```

**Use this:**
```yaml
# RIGHT - Statistics helper
sensor:
  - platform: statistics
    name: "Temperature Change (5 min)"
    entity_id: sensor.temperature
    state_characteristic: change
    max_age:
      minutes: 5
    sampling_size: 50
```

**Available characteristics:**
- `mean`, `median`, `average_linear`, `average_step`, `average_timeless`
- `standard_deviation`, `variance`
- `change`, `change_second`, `change_sample`
- `count`, `count_binary_on`, `count_binary_off`
- `total`, `noisiness`
- `datetime_newest`, `datetime_oldest`, `datetime_value_max`, `datetime_value_min`
- `value_max`, `value_min`, `quantiles`

**Key behaviors:**
- Time-based (`max_age`) vs count-based (`sampling_size`) buffering
- If using `max_age`, ensure frequent enough readings to cover the period
- Different from Long-Term Statistics (which is automatic for sensors with `state_class`)

**Common uses:**
- Humidity change over last hour
- Standard deviation of power readings (detect anomalies)
- Count of motion sensor activations in last 24 hours

---

## Rate and Change

### derivative

**Use for:** Calculating rate of change over time.

**Instead of:**
```yaml
# WRONG - Template calculating delta manually
template:
  - sensor:
      - name: "Power Rate"
        state: "{{ (states('sensor.power') | float - states('sensor.power_previous') | float) / 60 }}"
```

**Use this:**
```yaml
# RIGHT - Derivative helper
sensor:
  - platform: derivative
    name: "Power Rate of Change"
    source: sensor.power
    unit_time: min
    time_window:
      minutes: 5
```

**Parameters:**
- `unit_time`: s, min, h, d - determines output unit (e.g., W/min)
- `time_window`: Smoothing window using Simple Moving Average
- `round`: Decimal places for output

**Key behaviors:**
- Without `time_window`, calculates between consecutive updates only
- Can show large negative spikes when source resets to 0 (total_increasing sensors)
- Use `force_update` option if source updates infrequently

**Common uses:**
- Energy production rate (kW from kWh sensor)
- Temperature change rate (detect HVAC efficiency)
- Water flow rate from cumulative meter

---

### threshold

**Use for:** Creating a binary sensor that turns on/off when a numeric sensor crosses a threshold.

**Instead of:**
```yaml
# WRONG - Template binary sensor
template:
  - binary_sensor:
      - name: "High Temperature"
        state: "{{ states('sensor.temperature') | float > 25 }}"
```

**Use this:**
```yaml
# RIGHT - Threshold helper
binary_sensor:
  - platform: threshold
    name: "High Temperature"
    entity_id: sensor.temperature
    upper: 25
    hysteresis: 1
```

**Parameters:**
- `upper`: Threshold for "on" when value exceeds
- `lower`: Threshold for "on" when value drops below
- `hysteresis`: Buffer zone to prevent rapid toggling

**Hysteresis explained:**
```
With upper: 25 and hysteresis: 1:
- Turns ON when value rises ABOVE 26 (25 + 1)
- Turns OFF when value falls BELOW 24 (25 - 1)
```

**Common uses:**
- Low battery warning (lower threshold)
- High humidity alert
- Air quality threshold alerts
- Detect temperature rising/falling (use with derivative)

---

## Time-Based Tracking

### utility_meter

**Use for:** Tracking consumption with periodic resets (energy, water, gas billing cycles).

**Instead of:**
```yaml
# WRONG - Automation with counter tracking monthly usage
automation:
  - alias: "Reset monthly energy"
    triggers:
      - trigger: time
        at: "00:00:00"
    conditions:
      - "{{ now().day == 1 }}"
    actions:
      - action: input_number.set_value
        target:
          entity_id: input_number.monthly_energy
        data:
          value: 0
```

**Use this:**
```yaml
# RIGHT - Utility meter
utility_meter:
  daily_energy:
    source: sensor.energy_consumption
    cycle: daily
  monthly_energy:
    source: sensor.energy_consumption
    cycle: monthly
```

**Cycle options:** `quarter-hourly`, `hourly`, `daily`, `weekly`, `monthly`, `bimonthly`, `quarterly`, `yearly`

**Advanced features:**
- **Tariffs:** Track peak/off-peak separately
- **Offset:** Start cycle on specific day (e.g., billing date)
- **Cron:** Custom reset schedules
- **Delta:** For sensors that report delta values

```yaml
# Utility meter with tariffs
utility_meter:
  daily_energy:
    source: sensor.energy_consumption
    cycle: daily
    tariffs:
      - peak
      - offpeak
```

Then use automation to switch tariffs:
```yaml
automation:
  - alias: "Switch to peak tariff"
    triggers:
      - trigger: time
        at: "07:00:00"
    actions:
      - action: utility_meter.select_tariff
        target:
          entity_id: utility_meter.daily_energy
        data:
          tariff: peak
```

**Common uses:**
- Daily/monthly energy consumption
- Water usage per billing cycle
- Gas consumption tracking

---

### history_stats

**Use for:** Statistics about how long/often an entity has been in a specific state.

```yaml
sensor:
  - platform: history_stats
    name: "Lights on today"
    entity_id: light.living_room
    state: "on"
    type: time
    start: "{{ now().replace(hour=0, minute=0, second=0) }}"
    end: "{{ now() }}"
```

**Types:**
- `time`: Duration in hours
- `ratio`: Percentage of time
- `count`: Number of state changes to the monitored state

**Key behaviors:**
- Limited by recorder's `purge_keep_days`
- Updates when source changes or once per minute

**Common uses:**
- How long lights were on today
- Percentage of time home was occupied
- Count of door openings per day

---

### integration (Riemann sum)

**Use for:** Converting power (W) to energy (kWh), flow rate to volume, etc.

```yaml
sensor:
  - platform: integration
    name: "Solar Energy"
    source: sensor.solar_power
    unit_prefix: k
    unit_time: h
    method: left
    round: 2
```

**Methods:**
- `left`: Uses previous value for interval (recommended for sparse data)
- `right`: Uses new value for interval
- `trapezoidal`: Averages previous and new (can overestimate with gaps)

**Key behaviors:**
- For solar/sensors with gaps, use `left` method
- `max_sub_interval` forces updates even when source doesn't change

**Common uses:**
- Convert solar power (W) to energy production (kWh)
- Convert water flow rate to total consumption
- Convert gas flow to total usage

---

## State Storage

### input_boolean

**Use for:** Toggle switches for modes, flags, and conditions.

```yaml
input_boolean:
  guest_mode:
    name: "Guest Mode"
    icon: mdi:account-group
  vacation_mode:
    name: "Vacation Mode"
    icon: mdi:airplane
```

**Common uses:**
- Guest mode (disable certain automations)
- Vacation mode
- Manual override flags
- Feature toggles

### input_number

**Use for:** Storing numeric values that can be adjusted.

```yaml
input_number:
  target_temperature:
    name: "Target Temperature"
    min: 15
    max: 30
    step: 0.5
    unit_of_measurement: "°C"
    mode: slider
```

**Modes:** `slider`, `box`

**Common uses:**
- User-adjustable thresholds
- Target temperatures
- Timer durations
- Brightness levels

### input_select

**Use for:** Dropdown selection of predefined options.

```yaml
input_select:
  hvac_mode:
    name: "HVAC Mode"
    options:
      - "auto"
      - "cool"
      - "heat"
      - "off"
    icon: mdi:thermostat
```

**Common uses:**
- Scene selection
- Mode selection
- Status tracking
- Multi-state toggles

### input_text

**Use for:** Storing text strings.

```yaml
input_text:
  notification_message:
    name: "Custom Notification"
    min: 0
    max: 255
    mode: text
```

**Modes:** `text`, `password`

**Common uses:**
- Custom messages
- Temporary storage
- User notes

### input_datetime

**Use for:** Storing date and/or time values.

```yaml
input_datetime:
  morning_alarm:
    name: "Morning Alarm"
    has_time: true
    has_date: false
  next_vacation:
    name: "Next Vacation"
    has_date: true
    has_time: false
```

**Common uses:**
- Alarm times
- Schedule times (wake-up, lights off)
- Future dates (vacation, events)

### input_button

**Use for:** Triggering automations manually.

```yaml
input_button:
  doorbell:
    name: "Doorbell"
    icon: mdi:bell
```

**Common uses:**
- Manual triggers for automations
- Dashboard buttons
- Test triggers

---

## Counting and Timing

### counter

**Use for:** Tracking counts with increment/decrement/reset.

**Instead of:**
```yaml
# WRONG - input_number with automation
input_number:
  coffee_count:
    min: 0
    max: 100
automation:
  - alias: "Increment coffee"
    triggers: ...
    actions:
      - action: input_number.set_value
        data:
          value: "{{ states('input_number.coffee_count') | int + 1 }}"
```

**Use this:**
```yaml
# RIGHT - Counter helper
counter:
  coffee_count:
    name: "Coffees Today"
    initial: 0
    step: 1
    minimum: 0
    maximum: 100
    restore: true
```

**Actions:** `counter.increment`, `counter.decrement`, `counter.reset`, `counter.set_value`

**Key behaviors:**
- `restore: true` preserves value across restarts
- Respects min/max boundaries

**Common uses:**
- Daily counts (coffees, workouts)
- Usage tracking
- Sequential numbering

---

### timer

**Use for:** Countdown timers that fire events when finished.

**Instead of:**
```yaml
# WRONG - Delay in automation
actions:
  - delay:
      minutes: 5
  - action: notify.mobile_app
    data:
      message: "Timer done!"
```

**Use this for pausable/restartable timers:**
```yaml
# RIGHT - Timer helper
timer:
  laundry:
    name: "Laundry Timer"
    duration: "01:00:00"
    restore: true
```

**Actions:** `timer.start`, `timer.pause`, `timer.cancel`, `timer.finish`, `timer.change`

**Events fired:**
- `timer.started`
- `timer.paused`
- `timer.cancelled`
- `timer.finished`
- `timer.restarted`

**Key behaviors:**
- Can be started with custom duration: `timer.start` with `duration: "00:30:00"`
- `restore: true` continues timer after restart
- Can be controlled from dashboard

**Common uses:**
- Laundry/dryer reminders
- Cooking timers
- Activity timers with pause/resume

---

## Scheduling

### schedule

**Use for:** Weekly on/off schedules.

```yaml
schedule:
  work_hours:
    name: "Work Hours"
    monday:
      - from: "09:00:00"
        to: "17:00:00"
    tuesday:
      - from: "09:00:00"
        to: "17:00:00"
    # ... etc
```

**Key behaviors:**
- Creates a binary sensor that's `on` during scheduled times
- Can have multiple blocks per day
- Editable via UI

**Instead of:**
```yaml
# WRONG - Template with weekday checks
template:
  - binary_sensor:
      - name: "Work Hours"
        state: >
          {{ now().weekday() < 5 and
             now().hour >= 9 and
             now().hour < 17 }}
```

**Common uses:**
- Work hours / business hours
- Quiet hours
- HVAC schedules
- Lighting schedules

---

### time of day (tod)

**Use for:** Binary sensor based on current time (sunrise/sunset or fixed times).

```yaml
binary_sensor:
  - platform: tod
    name: "Morning"
    after: "06:00"
    before: "12:00"

  - platform: tod
    name: "Night Time"
    after: sunset
    after_offset: "01:00:00"
    before: sunrise
```

**Common uses:**
- Time-of-day modes (morning, afternoon, evening, night)
- Daylight/darkness detection
- Simple time-based conditions

---

## Entity Grouping

### group

**Use for:** Combining entities for collective state and control.

```yaml
group:
  all_lights:
    name: "All Lights"
    entities:
      - light.living_room
      - light.bedroom
      - light.kitchen
    all: false  # ON if ANY member is on

  security_sensors:
    name: "Security Sensors"
    entities:
      - binary_sensor.front_door
      - binary_sensor.back_door
      - binary_sensor.window
    all: true  # ON only if ALL members are on
```

**Parameters:**
- `all: false` (default): Group is ON if ANY member is ON (OR logic)
- `all: true`: Group is ON only if ALL members are ON (AND logic)

**Key behaviors:**
- Groups inherit the domain of their members
- Light groups can be controlled as a single entity
- Binary sensor groups useful for "any door open" logic

**Instead of:**
```yaml
# WRONG - Template binary sensor for any-on logic
template:
  - binary_sensor:
      - name: "Any Door Open"
        state: >
          {{ is_state('binary_sensor.front_door', 'on') or
             is_state('binary_sensor.back_door', 'on') }}
```

**Common uses:**
- All lights in an area
- Any motion sensor active
- All doors/windows closed
- Group control in dashboards

---

## Decision Matrix

| Need | Helper | Not |
|------|--------|-----|
| Average of multiple sensors | `min_max` (type: mean) | Template with math |
| Sum of multiple sensors | `min_max` (type: sum) | Template with math |
| Average over time | `statistics` | Template tracking history |
| Rate of change | `derivative` | Template calculating delta |
| On/off at threshold | `threshold` | Template binary sensor |
| Consumption per period | `utility_meter` | Counter with reset automation |
| Time in state | `history_stats` | Template tracking timestamps |
| Power to energy | `integration` | Template approximating |
| User toggle | `input_boolean` | - |
| User number | `input_number` | - |
| User selection | `input_select` | - |
| Count events | `counter` | input_number + automation |
| Countdown timer | `timer` | delay + input_datetime |
| Weekly schedule | `schedule` | Template with weekday checks |
| Time of day mode | `tod` | Template with time checks |
| Any-on / all-on | `group` | Template binary sensor |

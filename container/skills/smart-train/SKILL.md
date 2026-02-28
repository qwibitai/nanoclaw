---
name: smart-train
description: Look up SMART (Sonoma-Marin Area Rail Transit) train schedules, next departures, and travel times. Use when the user asks about trains, SMART, commute times, or getting to/from stations.
allowed-tools: Bash(python3:*,curl:*,agent-browser:*)
---

# SMART Train Schedule

## User Context

Home station: **Cotati**

Directional logic:
- "going to Petaluma" / "going to San Rafael" / "going to Larkspur" = **southbound**
- "going to Santa Rosa" / "going to the airport" / "going to Cloverdale" = **northbound**
- "coming home from X" = **toward Cotati** (determine direction based on where X is relative to Cotati)

## Station Order (North to South)

1. Cloverdale
2. Healdsburg
3. Windsor
4. Charles M. Schulz - Sonoma County Airport
5. Santa Rosa North
6. **Santa Rosa Downtown**
7. Rohnert Park
8. **Cotati** (home)
9. **Petaluma Downtown**
10. Petaluma North (Lakeville)
11. Novato Downtown
12. Novato San Marin
13. Marin Civic Center
14. **San Rafael Downtown**
15. Larkspur (southern terminus)

## Travel Time Estimates from Cotati

| Destination | Direction | Approx. Time |
|-------------|-----------|--------------|
| Petaluma Downtown | South | ~10 min |
| San Rafael Downtown | South | ~45 min |
| Larkspur | South | ~55 min |
| Rohnert Park | North | ~5 min |
| Santa Rosa Downtown | North | ~12 min |
| SR Airport | North | ~20 min |

## Answering Schedule Questions

Use the helper script to look up schedules. It downloads and parses GTFS data automatically.

### Show trips between two stations

```bash
python3 /home/node/.claude/skills/smart-train/smart_train.py trips --from "Cotati" --to "Petaluma"
```

With time filters:
```bash
python3 /home/node/.claude/skills/smart-train/smart_train.py trips --from "Cotati" --to "San Rafael" --after 15:00 --before 20:00
```

For a specific date:
```bash
python3 /home/node/.claude/skills/smart-train/smart_train.py trips --from "Cotati" --to "Petaluma" --date 2026-03-01
```

### Show next departures from a station

```bash
python3 /home/node/.claude/skills/smart-train/smart_train.py next --from "Cotati" --direction south
python3 /home/node/.claude/skills/smart-train/smart_train.py next --from "Cotati" --direction north --limit 3
```

### List all stations

```bash
python3 /home/node/.claude/skills/smart-train/smart_train.py stations
```

## Fallback: Agent Browser

If GTFS data is unavailable or the script fails, use agent-browser to check the schedule:

```bash
agent-browser open "https://sonomamarintrain.org/schedules-fares"
```

Then use `agent-browser snapshot -i` to read the page content.

## Notes

- Weekend/holiday schedules have fewer trains and different times
- SMART observes its own holiday schedule — weekend service applies on SMART holidays
- Bikes are allowed on all trains (2 per car, more in bike car)
- Free parking at most stations including Cotati

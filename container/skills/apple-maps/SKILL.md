---
name: apple-maps
description: Get directions, travel times, distances, and Apple Maps links between locations. Use when the user asks about directions, distance, travel time, ETA, how to get somewhere, or navigating between places.
allowed-tools: Bash(node:*)
---

# Apple Maps

All commands go through a single CLI script. Default transport: **driving**.

```
MAPS=/home/node/.claude/skills/apple-maps/maps.cjs
```

## Directions

Get route details including distance, travel time, and turn-by-turn steps.

```bash
node $MAPS directions "Origin" "Destination" [--mode walking|transit]
```

Examples:
```bash
node $MAPS directions "Apple Park, Cupertino" "San Francisco City Hall"
node $MAPS directions "Union Square, SF" "Golden Gate Park" --mode walking
```

## ETA (multiple destinations)

Compare travel time and distance to several destinations at once.

```bash
node $MAPS eta "Origin" "Dest1" "Dest2" ... [--mode walking|transit]
```

Example:
```bash
node $MAPS eta "Downtown LA" "Santa Monica" "Pasadena" "Long Beach"
```

## Search

Find places, businesses, and points of interest.

```bash
node $MAPS search "query" [--near "location"]
```

Examples:
```bash
node $MAPS search "coffee shops" --near "San Francisco"
node $MAPS search "gas station" --near "37.334,-122.009"
```

## Geocode

Convert an address or place name to coordinates.

```bash
node $MAPS geocode "address or place name"
```

## Output

All commands return JSON with human-readable fields (distances in miles, durations like "45 min") plus raw values. Directions and ETA results include Apple Maps links automatically.

## Apple Maps links (no API call needed)

Format: `https://maps.apple.com/?saddr=FROM&daddr=TO&dirflg=FLAG`

**Direction flags:** `d` = driving, `w` = walking, `r` = transit

Examples:
- Driving: `https://maps.apple.com/?saddr=Cupertino+CA&daddr=San+Francisco+CA&dirflg=d`
- From current location: `https://maps.apple.com/?daddr=San+Francisco+CA&dirflg=d`
- Walking: `https://maps.apple.com/?saddr=Union+Square&daddr=Golden+Gate+Park&dirflg=w`
- Coordinates: `https://maps.apple.com/?saddr=37.334,-122.009&daddr=37.783,-122.417&dirflg=d`

## Guidelines

- **Default to driving** unless context suggests otherwise
- Use `--mode walking` if user mentions walking, on foot, nearby, etc.
- Use `--mode transit` if user mentions train, bus, metro, public transport, etc.
- **Always include an Apple Maps link** when providing directions
- Format travel times naturally: "about 45 minutes" not "2700 seconds"
- When comparing routes, use `eta` (more efficient for multiple destinations)
- When the user asks for detailed step-by-step directions, use `directions`

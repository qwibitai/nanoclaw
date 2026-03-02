---
name: birdnet
description: Query BirdNET-Pi bird detection data. Use when the user asks about bird detections, what birds were seen/heard, bird activity, species counts, or anything related to backyard birding.
allowed-tools: Bash(curl:*,bash:*)
---

# BirdNET-Pi

Query the local BirdNET-Pi server for bird detection data.

```
BIRDNET_HOST="192.168.1.62"
```

## Helper script

Use the helper for common queries:

```bash
BIRDNET=/home/node/.claude/skills/birdnet/birdnet.sh
```

### Today's detections (species + counts)

```bash
bash $BIRDNET today
```

### Recent detections (default 10)

```bash
bash $BIRDNET recent
bash $BIRDNET recent 5
```

### Detection history for a specific species

```bash
bash $BIRDNET species "Red-tailed Hawk"
```

Returns JSON: `[{"date":"YYYY-MM-DD","count":N}, ...]`

### Daily stats summary

```bash
bash $BIRDNET stats
```

## Raw endpoints (if the helper doesn't cover your needs)

### Summary stats (HTML table)

```bash
curl -s "http://${BIRDNET_HOST}/todays_detections.php?today_stats=true"
```

Returns HTML table with: Total, Today, Last Hour, Species Total, Species Today.

### All detections today (HTML)

```bash
curl -s "http://${BIRDNET_HOST}/todays_detections.php?ajax_detections=true&display_limit=undefined"
```

Returns HTML with all individual detections. Species in `<button name="species" value="...">`, confidence as `Confidence: NN%`, time in `<td>HH:MM:SS<br></td>`.

### Species detection history (JSON)

```bash
curl -s "http://${BIRDNET_HOST}/todays_detections.php?comname=Red-tailed+Hawk"
```

Returns clean JSON: `[{"date":"2026-02-28","count":3}, ...]`

URL-encode the species name (spaces as `+`).

## Guidelines

- Default to showing today's detections when the user asks generally about birds
- For "what's new" or "anything interesting", highlight unusual or first-time species
- When asked about a specific bird, use the species history endpoint
- Keep responses conversational — the user is a casual birder, not a scientist
- BirdNET-Pi confidence scores are in the detection data; mention if a detection has low confidence

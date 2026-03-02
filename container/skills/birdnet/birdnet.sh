#!/bin/bash
# BirdNET-Pi query helper
# Usage: birdnet.sh <command> [args]
#   today              — Today's detections grouped by species
#   recent [N]         — Last N detections (default 10)
#   species <name>     — Detection history for a species (JSON)
#   stats              — Summary stats (totals, species count)

set -euo pipefail

BIRDNET_HOST="192.168.1.62"
BASE_URL="http://${BIRDNET_HOST}"

cmd="${1:-help}"
shift || true

case "$cmd" in
  today)
    # Fetch all of today's detections via AJAX endpoint and aggregate by species
    html=$(curl -s --max-time 30 "${BASE_URL}/todays_detections.php?ajax_detections=true&display_limit=undefined")
    echo "$html" | python3 -c "
import sys, re
from collections import Counter, defaultdict

html = sys.stdin.read()

# Species names appear in <button> tags with name='species'
# Confidence appears as: <b>Confidence:</b> NN%
species_names = re.findall(r'<button[^>]*name=\"species\"[^>]*value=\"([^\"]+)\"', html)
confidences = re.findall(r'<b>Confidence:</b>\s*(\d+)%', html)

if not species_names:
    print('No detections today.')
    sys.exit(0)

counts = Counter()
max_conf = defaultdict(int)
for i, species in enumerate(species_names):
    species = species.strip()
    counts[species] += 1
    if i < len(confidences):
        max_conf[species] = max(max_conf[species], int(confidences[i]))

# Sort by count descending
for species, count in counts.most_common():
    conf_str = f' (max confidence: {max_conf[species]}%)' if max_conf[species] > 0 else ''
    print(f'{species}: {count}{conf_str}')

print(f'\nTotal: {sum(counts.values())} detections, {len(counts)} species')
"
    ;;

  recent)
    limit="${1:-10}"
    html=$(curl -s --max-time 15 "${BASE_URL}/todays_detections.php?ajax_detections=true&display_limit=undefined&hard_limit=${limit}")
    echo "$html" | python3 -c "
import sys, re

html = sys.stdin.read()

# Time is in <td>HH:MM:SS<br></td>
# Species in <button name='species' value='...'>Name</button>
# Confidence: <b>Confidence:</b> NN%
times = re.findall(r'<td[^>]*>(\d{2}:\d{2}:\d{2})<br>', html)
species = re.findall(r'<button[^>]*name=\"species\"[^>]*value=\"([^\"]+)\"', html)
confs = re.findall(r'<b>Confidence:</b>\s*(\d+)%', html)

if not species:
    print('No recent detections found.')
    sys.exit(0)

for i in range(len(species)):
    t = times[i] if i < len(times) else '??:??:??'
    c = confs[i] if i < len(confs) else '?'
    print(f'{t}  {species[i]}  ({c}%)')
"
    ;;

  species)
    name="${1:?Usage: birdnet.sh species \"Species Name\"}"
    encoded=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote_plus(sys.argv[1]))" "$name")
    curl -s --max-time 10 "${BASE_URL}/todays_detections.php?comname=${encoded}"
    echo  # ensure trailing newline
    ;;

  stats)
    # Get summary stats from today_stats endpoint
    html=$(curl -s --max-time 10 "${BASE_URL}/todays_detections.php?today_stats=true")
    echo "$html" | python3 -c "
import sys, re

html = sys.stdin.read()

# Extract values from the stats table cells/buttons
# Order: Total, Today, Last Hour, Species Total, Species Today
cells = re.findall(r'<td[^>]*>(.*?)</td>', html, re.DOTALL)
values = []
for cell in cells:
    # Get text from buttons or plain text
    btn = re.search(r'<button[^>]*>(\d+)</button>', cell)
    if btn:
        values.append(btn.group(1))
    else:
        text = re.sub(r'<[^>]+>', '', cell).strip()
        if text.isdigit():
            values.append(text)

labels = ['Total detections', 'Today', 'Last hour', 'Species (all time)', 'Species today']
for label, val in zip(labels, values):
    print(f'{label}: {val}')
"
    ;;

  help|*)
    echo "Usage: birdnet.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  today              Today's detections grouped by species"
    echo "  recent [N]         Last N detections (default 10)"
    echo "  species <name>     Detection history for a species (JSON)"
    echo "  stats              Summary stats (totals, species count)"
    ;;
esac

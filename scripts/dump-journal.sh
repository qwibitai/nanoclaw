#!/bin/bash
# Dump recent systemd journal entries to a file readable by the container.
# Runs via cron/systemd timer every 5 minutes.

OUTPUT_DIR="/home/dwalt/workspace/nanoclaw/data/host-logs"
mkdir -p "$OUTPUT_DIR"

# Recent journal (last 30 minutes)
journalctl --since "30 min ago" --no-pager --output=short-iso > "$OUTPUT_DIR/journal-recent.log" 2>&1

# Failed units
systemctl --failed --no-pager > "$OUTPUT_DIR/failed-units.log" 2>&1

# Disk usage
df -h > "$OUTPUT_DIR/disk-usage.log" 2>&1

# Memory
free -h > "$OUTPUT_DIR/memory.log" 2>&1

# NanoClaw service status
systemctl --user status nanoclaw --no-pager > "$OUTPUT_DIR/nanoclaw-status.log" 2>&1

# Docker containers
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" > "$OUTPUT_DIR/containers.log" 2>&1

# System uptime and load
uptime > "$OUTPUT_DIR/uptime.log" 2>&1

# Timestamp
date -Iseconds > "$OUTPUT_DIR/last-updated.log"

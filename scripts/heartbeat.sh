#!/bin/bash
# X NanoClaw heartbeat — posts to UTI telemetry service
source ~/nanoclaw/.env
UPTIME=$(awk '{print int($1)}' /proc/uptime)
SERVICE_STATUS=$(systemctl --user is-active nanoclaw 2>/dev/null || echo "unknown")

curl -sf -X POST "${TELEMETRY_URL}/api/ingest" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TELEMETRY_REGISTRATION_TOKEN}" \
  -d "$(jq -cn \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg bot_id "${TELEMETRY_BOT_ID}" \
    --argjson uptime "$UPTIME" \
    --arg svc "$SERVICE_STATUS" \
    '{
      timestamp: $ts,
      bot_id: $bot_id,
      event_type: "heartbeat",
      payload: { uptime_seconds: $uptime, service_status: $svc }
    }')" > /dev/null 2>&1

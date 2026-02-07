#!/bin/bash
# Test container with proper mounts

PROJECT_ROOT="/Users/aceonhuang/project/nanoclaw"

echo '{"prompt":"Test: what is 2+2?","groupFolder":"test-group","chatId":"test@example.com","isMain":true}' | \
docker run -i \
  -v "$PROJECT_ROOT/skills:/workspace/shared-skills:ro" \
  -v "$PROJECT_ROOT/groups:/workspace/groups:rw" \
  -v "$PROJECT_ROOT/data/env:/workspace/env-dir:ro" \
  -v "$PROJECT_ROOT/data:/workspace/data:rw" \
  nanoclaw-agent:latest

#!/bin/bash
lsof -ti:3001 -ti:3002 2>/dev/null | xargs kill -9 2>/dev/null
ps aux | grep 'src/agent/index.ts\|src/store/index.ts\|src/gateway/index.ts' | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null
echo "Nexus stopped"

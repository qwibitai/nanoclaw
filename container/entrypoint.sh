#!/bin/bash
set -e
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json

# Configure Chromium launch options for agent-browser
# --disable-crash-reporter: prevents crashpad "—database is required" errors
# --proxy-server: routes through residential IP for geo-fenced sites
BROWSER_ARGS="\"--disable-crash-reporter\""
if [ -n "$RESIDENTIAL_PROXY_URL" ]; then
  BROWSER_ARGS="$BROWSER_ARGS,\"--proxy-server=$RESIDENTIAL_PROXY_URL\""
fi
export AGENT_BROWSER_LAUNCH_OPTIONS="{\"args\":[$BROWSER_ARGS]}"
# Configure git/gh auth if GITHUB_TOKEN is present in secrets
GH_TOKEN=$(node -e 'try{const d=JSON.parse(require("fs").readFileSync("/tmp/input.json","utf8"));if(d.secrets?.GITHUB_TOKEN)process.stdout.write(d.secrets.GITHUB_TOKEN)}catch{}' 2>/dev/null)
if [ -n "$GH_TOKEN" ]; then
  git config --global credential.helper '!f() { echo username=x-access-token; echo password='"$GH_TOKEN"'; }; f'
  echo "$GH_TOKEN" | gh auth login --with-token 2>/dev/null || true
fi
node /tmp/dist/index.js < /tmp/input.json

#!/bin/bash
set -e
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json

# Fix Chromium crashpad in containers: crashpad derives its database path from
# XDG_CONFIG_HOME. If that dir isn't writable (or gets corrupted in long-running
# containers), chromium crashes with "chrome_crashpad_handler: --database is required".
# Pointing XDG dirs to /tmp ensures a writable, ephemeral location.
# See: https://github.com/microsoft/playwright/issues/34031
export XDG_CONFIG_HOME=/tmp/.chromium
export XDG_CACHE_HOME=/tmp/.chromium
# Route browser through residential proxy for geo-fenced sites
if [ -n "$RESIDENTIAL_PROXY_URL" ]; then
  export AGENT_BROWSER_PROXY="$RESIDENTIAL_PROXY_URL"
fi

# Configure git/gh auth if GITHUB_TOKEN is present in secrets
GH_TOKEN=$(node -e 'try{const d=JSON.parse(require("fs").readFileSync("/tmp/input.json","utf8"));if(d.secrets?.GITHUB_TOKEN)process.stdout.write(d.secrets.GITHUB_TOKEN)}catch{}' 2>/dev/null)
GH_ORGS=$(node -e 'try{const d=JSON.parse(require("fs").readFileSync("/tmp/input.json","utf8"));if(d.secrets?.GITHUB_ALLOWED_ORGS)process.stdout.write(d.secrets.GITHUB_ALLOWED_ORGS)}catch{}' 2>/dev/null)
if [ -n "$GH_TOKEN" ]; then
  if [ -n "$GH_ORGS" ]; then
    # URL-scoped credentials: only provide token for allowed orgs.
    # Prevents cloning repos outside the allowed organizations.
    IFS=',' read -ra ORGS <<< "$GH_ORGS"
    for org in "${ORGS[@]}"; do
      git config --global "credential.https://github.com/${org}/.helper" \
        '!f() { echo username=x-access-token; echo password='"$GH_TOKEN"'; }; f'
    done
  else
    # Global credential helper — all github.com repos get the token
    git config --global credential.helper '!f() { echo username=x-access-token; echo password='"$GH_TOKEN"'; }; f'
  fi
  # Only give gh CLI global auth when org-scoping is NOT active.
  # gh uses its own auth store (~/.config/gh/) independent of git credential helpers,
  # which would bypass the URL-scoped credential restriction.
  if [ -z "$GH_ORGS" ]; then
    echo "$GH_TOKEN" | gh auth login --with-token 2>/dev/null || true
  fi
fi
# gws (Google Workspace CLI) needs a writable config dir for API discovery cache.
# /home/node/.config/ may be owned by root from calendar MCP setup in Dockerfile.
export GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/.gws
mkdir -p /tmp/.gws

# Convert Gmail OAuth credentials to gws authorized_user format.
# gws needs {type,client_id,client_secret,refresh_token};
# existing creds split these across gcp-oauth.keys.json and credentials.json.
for dir in /home/node/.gmail-mcp /home/node/.gmail-mcp-*; do
  [ -f "$dir/credentials.json" ] && [ -f "$dir/gcp-oauth.keys.json" ] || continue
  node -e '
    const fs=require("fs"),p=require("path");
    const oauth=JSON.parse(fs.readFileSync(p.join("'"$dir"'","gcp-oauth.keys.json"),"utf8"));
    const creds=JSON.parse(fs.readFileSync(p.join("'"$dir"'","credentials.json"),"utf8"));
    const c=oauth.installed||oauth.web;
    if(!c||!creds.refresh_token)process.exit(0);
    fs.writeFileSync(p.join("'"$dir"'","gws-credentials.json"),JSON.stringify({
      type:"authorized_user",client_id:c.client_id,
      client_secret:c.client_secret,refresh_token:creds.refresh_token
    },null,2)+"\n");
  ' 2>/dev/null || true
done

node /tmp/dist/index.js < /tmp/input.json

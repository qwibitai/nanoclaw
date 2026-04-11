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

# Render CLI v2 requires an active workspace for service-level commands.
# When the host passes RENDER_WORKSPACE_ID in secrets (set per-scope via
# RENDER_WORKSPACE_ID_<SCOPE> in .env, normalized in readSecrets), pre-set
# it here so the agent doesn't have to learn the `render workspace set` flow.
RENDER_WS=$(node -e 'try{const d=JSON.parse(require("fs").readFileSync("/tmp/input.json","utf8"));if(d.secrets?.RENDER_WORKSPACE_ID)process.stdout.write(d.secrets.RENDER_WORKSPACE_ID)}catch{}' 2>/dev/null)
RENDER_KEY=$(node -e 'try{const d=JSON.parse(require("fs").readFileSync("/tmp/input.json","utf8"));if(d.secrets?.RENDER_API_KEY)process.stdout.write(d.secrets.RENDER_API_KEY)}catch{}' 2>/dev/null)
if [ -n "$RENDER_WS" ] && [ -n "$RENDER_KEY" ]; then
  RENDER_API_KEY="$RENDER_KEY" /usr/local/bin/render workspace set "$RENDER_WS" --confirm >/dev/null 2>&1 \
    && echo "[entrypoint] render workspace pre-configured: $RENDER_WS" >&2 \
    || echo "[entrypoint] render workspace set failed (workspace=$RENDER_WS)" >&2
fi

# gws (Google Workspace CLI) needs a writable config dir for API discovery cache.
# /home/node/.config/ may be owned by root from calendar MCP setup in Dockerfile.
export GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/.gws
mkdir -p /tmp/.gws

# Google credentials: consolidated gws authorized_user files at /home/node/.config/gws/accounts/.
# If consolidated creds exist, use them directly. Otherwise, fall back to converting legacy
# MCP credentials (gmail-mcp, google-calendar-mcp, google_workspace_mcp) for backward compat.
if [ -d /home/node/.config/gws/accounts ] && ls /home/node/.config/gws/accounts/*.json >/dev/null 2>&1; then
  echo "[entrypoint] Using consolidated gws credentials" >&2
else
  echo "[entrypoint] No consolidated creds — converting legacy MCP credentials" >&2
  mkdir -p /home/node/.config/gws/accounts
  # Convert legacy Gmail credentials
  for dir in /home/node/.gmail-mcp /home/node/.gmail-mcp-*; do
    [ -f "$dir/credentials.json" ] && [ -f "$dir/gcp-oauth.keys.json" ] || continue
    node -e '
      const fs=require("fs"),p=require("path");
      const oauth=JSON.parse(fs.readFileSync(p.join("'"$dir"'","gcp-oauth.keys.json"),"utf8"));
      const creds=JSON.parse(fs.readFileSync(p.join("'"$dir"'","credentials.json"),"utf8"));
      const c=oauth.installed||oauth.web;
      if(!c||!creds.refresh_token)process.exit(0);
      const name=p.basename("'"$dir"'").replace(".gmail-mcp-","").replace(".gmail-mcp","primary");
      fs.writeFileSync(p.join("/home/node/.config/gws/accounts",name+".json"),JSON.stringify({
        type:"authorized_user",client_id:c.client_id,
        client_secret:c.client_secret,refresh_token:creds.refresh_token
      },null,2)+"\n");
    ' 2>/dev/null || true
  done
fi

# Prevent gws from falling back to service account credentials via ADC.
# When GOOGLE_APPLICATION_CREDENTIALS is set (for gcloud/gsutil), gws picks
# up the service account instead of the user's OAuth token — causing
# FAILED_PRECONDITION on Gmail/Calendar. This wrapper strips it so gws
# only uses GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE or per-command overrides.
GWS_BIN=$(command -v gws 2>/dev/null || true)
if [ -n "$GWS_BIN" ]; then
  mkdir -p /tmp/bin
  cat > /tmp/bin/gws <<WRAPPER
#!/bin/bash
unset GOOGLE_APPLICATION_CREDENTIALS
exec "$GWS_BIN" "\$@"
WRAPPER
  chmod +x /tmp/bin/gws
  export PATH="/tmp/bin:$PATH"
fi

# Register git repos for GitNexus code intelligence.
# Startup only registers existing indexes — no analysis runs at boot.
# Repos without an index are skipped; the agent runs `gitnexus analyze`
# in whichever repo it actually needs when the session starts work.
# This avoids re-analyzing all repos (typically 20+) when a thread only
# touches 1-2, and avoids stale-index re-analysis caused by prior commits.
mkdir -p /home/node/.gitnexus
# Collect all repos with an existing index, then register in one Node process.
_gitnexus_repos=()
for gitdir in $(find /workspace -maxdepth 3 -name .git \( -type d -o -type f \) 2>/dev/null); do
  repo=$(dirname "$gitdir")
  [ -f "$repo/.gitnexus/meta.json" ] && _gitnexus_repos+=("$repo")
done
if [ ${#_gitnexus_repos[@]} -gt 0 ]; then
  node -e '
    const fs=require("fs"),p=require("path");
    const regPath=p.join(process.env.HOME,".gitnexus","registry.json");
    const reg=fs.existsSync(regPath)?JSON.parse(fs.readFileSync(regPath,"utf8")):[];
    for(const repo of process.argv.slice(1)){
      if(reg.some(r=>r.path===repo)) continue;
      try{
        const meta=JSON.parse(fs.readFileSync(p.join(repo,".gitnexus","meta.json"),"utf8"));
        reg.push({name:p.basename(repo),path:repo,storagePath:p.join(repo,".gitnexus"),
          indexedAt:meta.indexedAt,lastCommit:meta.lastCommit,stats:meta.stats});
      }catch{}
    }
    fs.writeFileSync(regPath,JSON.stringify(reg,null,2)+"\n");
  ' "${_gitnexus_repos[@]}" 2>/dev/null \
    && echo "[entrypoint] GitNexus: registered ${#_gitnexus_repos[@]} repo(s)" >&2 || true
fi

node /tmp/dist/index.js < /tmp/input.json

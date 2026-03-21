---
name: deploy
description: Deploy web apps to Vercel or Netlify. Use when asked to "deploy", "go live", "publish my app", "host this", "put this on the internet", or "deploy to Vercel/Netlify".
allowed-tools: Bash
---

# Deploy Skill

This skill enables Jarvis to deploy web applications to Vercel (primary) or Netlify (fallback) from within a headless container environment using token-based authentication — no interactive login required.

---

## 1. Authentication Check

Before doing anything else, determine which platform to use based on available environment tokens:

```bash
# Check which platform tokens are available
if [ -n "$VERCEL_TOKEN" ]; then
  PLATFORM="vercel"
elif [ -n "$NETLIFY_AUTH_TOKEN" ]; then
  PLATFORM="netlify"
else
  echo "ERROR: No deployment token found."
  echo "Set VERCEL_TOKEN for Vercel or NETLIFY_AUTH_TOKEN for Netlify"
  exit 1
fi

echo "Using platform: $PLATFORM"
```

If neither token is set, stop and inform the user which environment variable they need to configure.

---

## 2. Install CLI if Needed

### Vercel

```bash
if ! which vercel > /dev/null 2>&1; then
  npm install -g vercel
fi
vercel --version
```

### Netlify

```bash
if ! which netlify > /dev/null 2>&1; then
  npm install -g netlify-cli
fi
netlify --version
```

---

## 3. Project Type Detection

Run this from the project root directory to determine the framework and appropriate build/deploy strategy:

```bash
PROJECT_DIR="${1:-.}"  # Default to current directory

detect_project_type() {
  local dir="$1"

  if compgen -G "$dir/next.config.*" > /dev/null 2>&1; then
    echo "nextjs"
  elif compgen -G "$dir/astro.config.*" > /dev/null 2>&1; then
    echo "astro"
  elif compgen -G "$dir/vite.config.*" > /dev/null 2>&1; then
    echo "vite"
  elif [ -f "$dir/package.json" ] && grep -q '"build"' "$dir/package.json"; then
    echo "node"
  elif [ -f "$dir/index.html" ] && [ ! -f "$dir/package.json" ]; then
    echo "static"
  else
    echo "unknown"
  fi
}

PROJECT_TYPE=$(detect_project_type "$PROJECT_DIR")
echo "Detected project type: $PROJECT_TYPE"
```

### Build Commands and Output Directories by Type

| Type     | Build Command         | Output Dir  | Notes                          |
|----------|-----------------------|-------------|--------------------------------|
| Next.js  | `npm run build`       | `.next/`    | Vercel handles this natively   |
| Astro    | `npm run build`       | `dist/`     | Static or SSR                  |
| Vite     | `npm run build`       | `dist/`     | React, Vue, Svelte             |
| Node     | `npm run build`       | `dist/`     | Check `package.json` for dir   |
| Static   | _(none)_              | `./`        | Raw HTML/CSS/JS, no build step |

---

## 4. Vercel Deployment (Primary)

### CRITICAL: Always use `--yes` to skip all interactive prompts

#### Static HTML (no build step)

```bash
# Auto-generate vercel.json if missing
if [ ! -f vercel.json ]; then
  cat > vercel.json <<'EOF'
{
  "version": 2,
  "builds": [{"src": "**", "use": "@vercel/static"}]
}
EOF
fi

vercel ./ --prod --token=$VERCEL_TOKEN --yes
```

#### Vite / React / Vue / Svelte

```bash
npm install && npm run build
vercel dist/ --prod --token=$VERCEL_TOKEN --yes
```

#### Astro

```bash
npm install && npm run build
vercel dist/ --prod --token=$VERCEL_TOKEN --yes
```

#### Next.js

```bash
npm install
vercel --prod --token=$VERCEL_TOKEN --yes
```

#### Generic Node (with build script)

```bash
npm install && npm run build
vercel dist/ --prod --token=$VERCEL_TOKEN --yes
```

### First-Time Projects (no `.vercel/` directory)

Set the project name in `vercel.json` — the `--name` flag was removed in Vercel CLI v28:

```bash
PROJECT_NAME="my-app-name"  # lowercase, alphanumeric + hyphens only

if [ ! -f vercel.json ]; then
  echo "{\"name\": \"$PROJECT_NAME\"}" > vercel.json
else
  python3 -c "
import json
with open('vercel.json') as f: d = json.load(f)
d['name'] = '$PROJECT_NAME'
with open('vercel.json', 'w') as f: json.dump(d, f, indent=2)
"
fi

vercel --prod --token=$VERCEL_TOKEN --yes
```

### Re-deploying an Existing Project

If `.vercel/` already exists in the project root, just run:

```bash
vercel --prod --token=$VERCEL_TOKEN --yes
```

Vercel remembers the project config and deploys in-place.

---

## 5. Netlify Deployment (Fallback)

Use when `VERCEL_TOKEN` is not set but `NETLIFY_AUTH_TOKEN` is available.

### First-Time: Create a New Site

```bash
PROJECT_NAME="my-app-name"
netlify sites:create --auth=$NETLIFY_AUTH_TOKEN --name=$PROJECT_NAME
```

Save the returned site ID if needed for subsequent deploys.

### Static Site

```bash
netlify deploy --prod --dir=./ --auth=$NETLIFY_AUTH_TOKEN --message="Deployed by Jarvis"
```

### After Build (Vite, Astro, etc.)

```bash
npm install && npm run build
netlify deploy --prod --dir=dist/ --auth=$NETLIFY_AUTH_TOKEN --message="Deployed by Jarvis"
```

### Next.js on Netlify

```bash
npm install && npm run build
netlify deploy --prod --dir=.next/ --auth=$NETLIFY_AUTH_TOKEN
```

---

## 6. Post-Deployment: Extract and Return URL

**IMPORTANT:** Capture the deploy output in the same command that runs the deployment — do NOT run vercel/netlify a second time here. That would trigger a duplicate deployment.

### Vercel

```bash
# Capture output from the single deploy command above
DEPLOY_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.vercel\.app' | tail -1)

if [ -n "$DEPLOY_URL" ]; then
  echo "Deployment successful: $DEPLOY_URL"
else
  echo "Deployment may have succeeded. Check full output above."
fi
```

### Netlify

```bash
DEPLOY_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.netlify\.app' | tail -1)

if [ -n "$DEPLOY_URL" ]; then
  echo "Deployment successful: $DEPLOY_URL"
else
  echo "Deployment may have succeeded. Check full output above."
fi
```

Always send the URL to chat using `mcp__nanoclaw__send_message` or include it in your final response.

---

## 7. Re-Deploy / Update

To push updates to an already-deployed project:

```bash
# Vercel: just run again from project root (uses .vercel/ config)
vercel --prod --token=$VERCEL_TOKEN --yes

# Netlify: specify the dir again
netlify deploy --prod --dir=dist/ --auth=$NETLIFY_AUTH_TOKEN --message="Update by Jarvis"
```

---

## 8. Full Workflow Example

**Scenario:** User says "deploy this React app to Vercel"

```bash
# Step 1: Confirm token
[ -z "$VERCEL_TOKEN" ] && echo "ERROR: VERCEL_TOKEN not set" && exit 1

# Step 2: Install CLI if missing
which vercel || npm install -g vercel

# Step 3: Detect project type
cd /workspace/group/my-react-app

# vite.config.ts exists → type = vite
# Build command: npm run build, output: dist/

# Step 4: Build
npm install && npm run build

# Step 5: Deploy
DEPLOY_OUTPUT=$(vercel dist/ --prod --token=$VERCEL_TOKEN --yes --name=my-react-app 2>&1)
echo "$DEPLOY_OUTPUT"

# Step 6: Extract URL
DEPLOY_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.vercel\.app' | tail -1)
echo "Live at: $DEPLOY_URL"

# Step 7: Report back to user
# Send $DEPLOY_URL to chat
```

---

## 9. Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| 401 Unauthorized | Invalid or expired `VERCEL_TOKEN` | Regenerate token in Vercel dashboard → Settings → Tokens |
| Project not found | Wrong project name or missing `.vercel/` | Use `--name` flag on first deploy |
| Build failed | Missing dependencies | Run `npm install` before build |
| No `index.html` | Wrong output directory specified | Check `package.json` for `"outDir"` or check framework docs |
| `--yes` not recognized | Outdated Vercel CLI | Run `npm install -g vercel@latest` |
| Site name taken (Netlify) | Name already in use globally | Choose a more unique `--name` |
| EACCES during npm install -g | Permission issue in container | Use `npm install -g --prefix /usr/local` |

---

## 10. Important Notes

- **Always run from the project root directory** unless deploying a specific subdirectory (e.g., `dist/`).
- **The `--yes` flag is CRITICAL** for non-interactive use. Without it, Vercel CLI will pause and wait for input, hanging the agent.
- **Project names must be lowercase, alphanumeric, and hyphens only** (no underscores, no spaces).
- **For monorepos**, `cd` into the specific app directory before running any deploy commands.
- **Do not commit tokens** to `vercel.json` or any config file. Tokens are always passed via environment variables.
- **Free tier limits**: Vercel 100GB bandwidth/month, Netlify 100GB bandwidth/month.
- **`.vercel/` directory**: Created automatically after first deploy. Contains project ID and org ID. Can be committed or ignored — if ignored, use `--name` consistently.
- **Vercel vs Netlify**: Vercel is preferred for Next.js and React/Vite apps. Netlify handles static sites and Astro equally well.
- **Preview vs Production**: `--prod` deploys to the production URL. Omitting it creates a preview deployment with a unique URL — useful for testing.

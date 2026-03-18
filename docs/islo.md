# Running NanoClaw on Islo

This path is for users who already run NanoClaw inside an isolated Islo sandbox and do not want nested Docker. In this mode, NanoClaw still keeps per-group workspaces and IPC isolation, but child agents run as local processes inside the Islo VM.

Use this only when the whole NanoClaw instance is already sandboxed by Islo.

## 1. Connect Islo to Claude

On your host:

```bash
ISLO=/Users/you/.local/bin/islo
$ISLO login --tool claude
```

That gives each `islo use ...` shell an injected `ANTHROPIC_API_KEY`, so you do not need to copy Claude credentials into `.env`.

## 2. Create a fresh sandbox

```bash
SANDBOX=nanoclaw-demo
$ISLO use $SANDBOX --source github://qwibitai/nanoclaw:main
```

## 3. Install Node and dependencies inside the sandbox

The exact Node install method is up to you. One working pattern is to unpack a Node 22 tarball into `/workspace/.tooling/node/22.22.0`.

Then build NanoClaw from inside the sandbox:

```bash
$ISLO use $SANDBOX -- bash -lc '
  set -euo pipefail
  export PATH=/workspace/.tooling/node/22.22.0/bin:$PATH
  export NANOCLAW_CONTAINER_RUNTIME=none
  cd /workspace/nanoclaw
  npm install
  npm --prefix container/agent-runner install
  npm run build
  npm --prefix container/agent-runner run build
'
```

## 4. Add a channel

NanoClaw keeps channels as skills. For WhatsApp, either use Claude Code's `/add-whatsapp` flow on your fork or merge the WhatsApp skill branch manually:

```bash
$ISLO use $SANDBOX -- bash -lc '
  set -euo pipefail
  cd /workspace/nanoclaw
  git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git
  git fetch whatsapp main
  git merge whatsapp/main
'
```

If `package-lock.json` conflicts, resolve it the same way you would resolve any normal merge conflict in your fork.

## 5. Authenticate WhatsApp and register your self-chat

```bash
$ISLO use $SANDBOX -- bash -lc '
  set -euo pipefail
  export PATH=/workspace/.tooling/node/22.22.0/bin:$PATH
  export NANOCLAW_CONTAINER_RUNTIME=none
  cd /workspace/nanoclaw
  npx tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone <phone-number-with-country-code>
'
```

After the phone is linked, register your self-chat as the main channel:

```bash
$ISLO use $SANDBOX -- bash -lc '
  set -euo pipefail
  export PATH=/workspace/.tooling/node/22.22.0/bin:$PATH
  export NANOCLAW_CONTAINER_RUNTIME=none
  cd /workspace/nanoclaw
  npx tsx setup/index.ts --step register -- \
    --jid "<phone>@s.whatsapp.net" \
    --name "WhatsApp Main" \
    --trigger "@Andy" \
    --folder "whatsapp_main" \
    --channel whatsapp \
    --assistant-name "Andy" \
    --is-main \
    --no-trigger-required
'
```

## 6. Generate the service wrapper and start NanoClaw

```bash
$ISLO use $SANDBOX -- bash -lc '
  set -euo pipefail
  export PATH=/workspace/.tooling/node/22.22.0/bin:$PATH
  export NANOCLAW_CONTAINER_RUNTIME=none
  cd /workspace/nanoclaw
  npx tsx setup/index.ts --step mounts -- --empty
  npx tsx setup/index.ts --step service
  bash start-nanoclaw.sh
  npx tsx setup/index.ts --step verify
'
```

Expected verification output:

```text
SERVICE: running
CONTAINER_RUNTIME: none
CREDENTIALS: configured
CHANNEL_AUTH: {"whatsapp":"authenticated"}
REGISTERED_GROUPS: 1
STATUS: success
```

## 7. Test it

Send a normal message to your WhatsApp self-chat, for example:

- `ping`
- `What can you do in this sandbox?`

Do not send `/login`. If `islo login --tool claude` succeeded, NanoClaw should use the injected `ANTHROPIC_API_KEY` automatically.

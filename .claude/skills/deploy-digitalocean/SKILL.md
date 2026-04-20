---
name: deploy-digitalocean
description: This skill should be used when the user asks to "deploy to DigitalOcean", "provision a droplet", "set up a VPS for NanoClaw", "deploy the company assistant", "install NanoClaw on a server", or "run deploy-digitalocean". Guides agentic provisioning of a DigitalOcean droplet and full NanoClaw setup from Claude Code without manual SSH steps.
---

# Deploy NanoClaw to DigitalOcean

End-to-end agentic provisioning: create a DigitalOcean droplet, bootstrap it, install NanoClaw, configure credentials, and start the service — without manual SSH steps.

**This skill is idempotent.** Re-running steps individually (e.g. to recover from a partial failure) is safe. Droplet creation will fail gracefully if a droplet named `nanoclaw` already exists — retrieve its IP with `doctl compute droplet get nanoclaw --format PublicIPv4 --no-header` and continue from the failed step.

## 1. Prerequisites

### doctl (DigitalOcean CLI)

Check whether `doctl` is available:

```bash
doctl version 2>/dev/null
```

If missing, install it:

- macOS: `brew install doctl`
- Linux (snap): `sudo snap install doctl`
- Linux (binary): download from https://github.com/digitalocean/doctl/releases, place in `/usr/local/bin/`

### Authentication

Check for an active DigitalOcean authentication context:

```bash
doctl auth list 2>/dev/null
```

If no context is listed, ask the user for a DigitalOcean API token. The token must have **write** scope (not read-only) to create droplets, add SSH keys, and manage firewall rules. Obtain one from https://cloud.digitalocean.com/account/api/tokens. Then run:

```bash
doctl auth init
```

Paste the token when prompted. Alternatively, export it directly for the current session:

```bash
export DIGITALOCEAN_ACCESS_TOKEN=<token>
```

Verify authentication works and confirm the account details look correct:

```bash
doctl account get
```

### SSH key

Check for an existing SSH public key:

```bash
ls ~/.ssh/id_ed25519.pub 2>/dev/null || ls ~/.ssh/id_rsa.pub 2>/dev/null
```

If neither exists, generate one:

```bash
ssh-keygen -t ed25519 -C nanoclaw -f ~/.ssh/id_ed25519 -N ""
```

Capture the public key content:

```bash
cat ~/.ssh/id_ed25519.pub 2>/dev/null || cat ~/.ssh/id_rsa.pub
```

## 2. Provision Droplet

Ask the user for the target region. Suggest `nyc3` (New York), `fra1` (Frankfurt), or `sfo3` (San Francisco). Default to `nyc3` if no preference is given.

Ask the user for the desired droplet size. Recommend `s-4vcpu-8gb` for a 30-user company assistant. `s-2vcpu-4gb` is the minimum. See `references/operations.md` for the full sizing table.

Add the SSH public key to DigitalOcean under the name `nanoclaw-key`. Skip the import if a key with that name is already registered:

```bash
doctl compute ssh-key list --format Name --no-header | grep -q nanoclaw-key \
  || doctl compute ssh-key import nanoclaw-key --public-key-file ~/.ssh/id_ed25519.pub
```

Retrieve the SSH key fingerprint (needed for the droplet create command):

```bash
FINGERPRINT=$(doctl compute ssh-key list --format Name,FingerPrint --no-header | grep nanoclaw-key | awk '{print $2}')
echo "Key fingerprint: $FINGERPRINT"
```

Create the droplet using the selected region, size, and key:

```bash
doctl compute droplet create nanoclaw \
  --region <region> \
  --size <size> \
  --image ubuntu-22-04-x64 \
  --ssh-keys $FINGERPRINT \
  --wait
```

The `--wait` flag blocks until the droplet transitions to `active`. After it returns, verify the status independently to confirm:

```bash
doctl compute droplet get nanoclaw --format Status --no-header
```

Retrieve the public IP and persist it to disk so all subsequent steps can read it (shell variables do not persist between tool invocations):

```bash
IP=$(doctl compute droplet get nanoclaw --format PublicIPv4 --no-header)
echo "$IP" > /tmp/nanoclaw-ip.txt
echo "Droplet IP: $IP"
```

If a previous run already wrote the IP, retrieve it with `IP=$(cat /tmp/nanoclaw-ip.txt)` and confirm it still matches the live droplet.

## 3. Bootstrap Droplet

Read the droplet IP saved in step 2:

```bash
IP=$(cat /tmp/nanoclaw-ip.txt)
```

Run the bootstrap script over SSH. The script installs Node 22, Docker, configures the firewall (SSH only — no inbound HTTP/HTTPS needed since channels use outbound WebSockets), sets up logrotate, and prepares the system:

```bash
ssh -o StrictHostKeyChecking=no root@$IP 'bash -s' < scripts/bootstrap-droplet.sh
```

The bootstrap takes 2–5 minutes. Wait for the SSH command to exit before proceeding.

If the bootstrap script is not present locally (it lives at `scripts/bootstrap-droplet.sh` in this repo), report the missing file to the user and stop. The script must exist before this step can run.

## 4. Clone and Setup

Read the droplet IP:

```bash
IP=$(cat /tmp/nanoclaw-ip.txt)
```

Ask the user for their NanoClaw fork URL (e.g. `https://github.com/<org>/nanoclaw.git`).

Clone the fork and run the initial setup script on the droplet:

```bash
ssh root@$IP "git clone <fork-url> nanoclaw && cd nanoclaw && bash setup.sh"
```

Run the timezone step (auto-detects the system timezone):

```bash
ssh root@$IP "cd nanoclaw && npx tsx setup/index.ts --step timezone"
```

Run the container runtime step with Docker. This builds the NanoClaw agent container image on the droplet and runs a smoke test:

```bash
ssh root@$IP "cd nanoclaw && npx tsx setup/index.ts --step container -- --runtime docker"
```

If the container build fails, check the SSH output for the error. Common causes:
- Docker daemon not fully started yet — wait 10 seconds and retry
- Missing build tools — the bootstrap script should have installed them; if not, run `ssh root@$IP "apt-get install -y build-essential"` and retry
- Stale buildkit cache — run `ssh root@$IP "docker builder prune -f"` and retry the step

## 5. Credential System

Read the droplet IP:

```bash
IP=$(cat /tmp/nanoclaw-ip.txt)
```

Install OneCLI (the credential gateway) and its CLI on the droplet. OneCLI intercepts outbound API calls from agent containers and injects secrets at the gateway level, so raw API keys never appear inside containers. Capture the URL printed by the install script in the same SSH session:

```bash
ONECLI_URL=$(ssh root@$IP "curl -fsSL onecli.sh/install | sh && curl -fsSL onecli.sh/cli/install | sh" 2>&1 | grep -oP 'http://[^\s]+' | tail -1)
```

If the grep produces no output, query the running gateway directly:

```bash
ONECLI_URL=$(ssh root@$IP "onecli system info --json 2>/dev/null | jq -r '.url' 2>/dev/null || echo 'http://localhost:31457'")
```

Verify the installation — the CLI may land in `~/.local/bin/` on the first install:

```bash
ssh root@$IP "onecli version 2>/dev/null || ~/.local/bin/onecli version"
```

Write `ONECLI_URL` to `.env` (idempotent):

```bash
ssh root@$IP "grep -q ONECLI_URL nanoclaw/.env 2>/dev/null || echo 'ONECLI_URL=$ONECLI_URL' >> nanoclaw/.env"
```

Register the Anthropic API key with OneCLI. AskUserQuestion with two options:

1. **Dashboard** — description: "Open $ONECLI_URL in a browser and add the secret via the UI (avoids shell history). Use type 'anthropic', name 'Anthropic', host-pattern 'api.anthropic.com'."
2. **CLI** — description: "Headless/remote server. Run: `ssh root@$IP 'onecli secrets create --name Anthropic --type anthropic --value YOUR_KEY --host-pattern api.anthropic.com'` — replace YOUR_KEY with the actual key."

Confirm the secret was registered:

```bash
ssh root@$IP "onecli secrets list"
```

Refer to the `/init-onecli` skill for the full credential registration flow, including Claude subscription (OAuth token) as an alternative to an API key.

## 6. Service Setup

Read the droplet IP:

```bash
IP=$(cat /tmp/nanoclaw-ip.txt)
```

Run the service step to generate and load the systemd user unit:

```bash
ssh root@$IP "cd nanoclaw && npx tsx setup/index.ts --step service"
```

This step creates a systemd user service with `Restart=always` and runs `loginctl enable-linger` so the service survives user logouts. Verify the service loaded:

```bash
ssh root@$IP "systemctl --user status nanoclaw"
```

## 7. Concurrent Container Limit

Read the droplet IP:

```bash
IP=$(cat /tmp/nanoclaw-ip.txt)
```

Look up the correct `MAX_CONCURRENT_CONTAINERS` value for the droplet size chosen in step 2 from `references/operations.md`. Use the value from the sizing table (e.g. `5` for `s-2vcpu-4gb`, `15` for `s-4vcpu-8gb`, `30` for `s-8vcpu-16gb`).

Set the value idempotently — skip the append if the key already exists:

```bash
ssh root@$IP "grep -q MAX_CONCURRENT_CONTAINERS nanoclaw/.env || echo 'MAX_CONCURRENT_CONTAINERS=<N>' >> nanoclaw/.env"
```

Replace `<N>` with the value from the sizing table.

Restart the service to apply the new value:

```bash
ssh root@$IP "systemctl --user restart nanoclaw"
```

## 8. Verify

Read the droplet IP:

```bash
IP=$(cat /tmp/nanoclaw-ip.txt)
```

Run the NanoClaw verify step:

```bash
ssh root@$IP "cd nanoclaw && npx tsx setup/index.ts --step verify"
```

Check the systemd service status:

```bash
ssh root@$IP "systemctl --user status nanoclaw"
```

Verify Docker is working correctly inside the droplet:

```bash
ssh root@$IP "docker run hello-world"
```

Check the service logs for any startup errors:

```bash
ssh root@$IP "tail -30 nanoclaw/logs/nanoclaw.log"
```

If the verify step reports credential errors, re-run the OneCLI secret registration from step 5. If the service is stopped, check `nanoclaw/logs/nanoclaw.error.log`.

## 9. Next Steps

The droplet is running NanoClaw with no channel connections yet. Complete the company assistant setup by running channel skills on the local machine (they will guide SSH-based credential configuration as needed):

- `/add-slack` — connect a Slack workspace via Socket Mode
- `/add-telegram` — connect a Telegram bot
- `/add-discord` — connect a Discord bot
- `/add-whatsapp` — connect via QR code or pairing code

For identity configuration (name, persona, group setup), run `/add-identity` once that skill is available.

## Troubleshooting

**SSH connection refused immediately after create:** The droplet needs 30–60 seconds to complete its initial boot. Wait and retry the SSH connection.

**Bootstrap script hangs on apt-get:** The Ubuntu package mirror may be slow or temporarily unavailable. The SSH command will time out after ~10 minutes. Retry by re-running the bootstrap command — `apt` operations are idempotent.

**Docker not found after bootstrap:** The bootstrap script installs Docker and adds root to the docker group. If `docker info` fails immediately after bootstrap, reboot the droplet (`ssh root@$IP reboot`) and reconnect after ~30 seconds. Docker starts automatically on reboot.

**OneCLI not in PATH:** The install script places the binary in `~/.local/bin/`. Add it to the PATH for the session and persist it:

```bash
ssh root@$IP "export PATH=\"\$HOME/.local/bin:\$PATH\" && echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
```

**`npx tsx` command not found:** Node 22 was installed by the bootstrap script, but non-interactive SSH sessions may not source `/etc/profile.d/` entries. Prefix the affected command with the explicit path:

```bash
ssh root@$IP "export PATH=\"/usr/local/bin:/usr/bin:\$PATH\" && cd nanoclaw && npx tsx setup/index.ts --step <step>"
```

**`MAX_CONCURRENT_CONTAINERS` too high:** If the droplet runs out of memory (containers crash, OOM messages in kernel logs), reduce the value in `nanoclaw/.env` and restart the service with `systemctl --user restart nanoclaw`.

**Credential errors after service start:** Run `ssh root@$IP "onecli secrets list"` to confirm the Anthropic secret is registered. If empty, re-run the `onecli secrets create` command from step 5. Also verify `ONECLI_URL` is present in `nanoclaw/.env` with `ssh root@$IP "grep ONECLI_URL nanoclaw/.env"`.

**Droplet already exists with that name:** If the `doctl compute droplet create` command fails because a droplet named `nanoclaw` already exists, retrieve its IP with `doctl compute droplet get nanoclaw --format PublicIPv4 --no-header` and continue from the step where the previous run failed.

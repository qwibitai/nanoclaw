# NanoClaw Migration: Hetzner → Oracle Cloud

## Server Details
- **Hetzner (source):** root@88.198.229.116 (SSH key: nanoclaw-ssh-key)
- **Oracle (target):** ubuntu@129.153.28.75 (SSH key: nanoclaw-ssh-key)
- **Key change:** root user → ubuntu user, `/root/` → `/home/ubuntu/`

---

## PHASE 0: Pre-flight (before touching anything)

### Step 0.1 — Update Snowflake network policy NOW

This takes effect asynchronously. Do it first so it's ready by the time you need it.

Log into Snowflake as ACCOUNTADMIN for **both** accounts:

**Sunday account (fivex-getsunday_useast):**
```sql
-- Find existing network policy
SHOW NETWORK POLICIES;
-- Add Oracle IP to the allowed list (keep Hetzner IP too for now)
-- The exact command depends on your existing policy name. Example:
ALTER NETWORK POLICY <your_policy_name> SET ALLOWED_IP_LIST = ('88.198.229.116', '129.153.28.75');
```

**XZO/Apollo account (LSECYRS-OCC59664):**
```sql
-- Same thing — add 129.153.28.75 to the allowed list
ALTER NETWORK POLICY <your_policy_name> SET ALLOWED_IP_LIST = ('88.198.229.116', '129.153.28.75');
```

Keep both IPs allowed until migration is confirmed working.

### Step 0.2 — Check Oracle Cloud firewall (VCN Security Lists)

Oracle blocks all ingress by default except SSH (port 22). If NanoClaw needs any inbound ports (e.g., webhook callbacks), open them now:

1. Go to Oracle Cloud Console → Networking → Virtual Cloud Networks
2. Click your VCN → Click your subnet → Click the Security List
3. Add Ingress Rules for any ports NanoClaw needs (check if any webhooks point to the server IP)

If NanoClaw is purely outbound (polls channels, no webhooks), you can skip this.

---

## PHASE 1: Prepare Oracle

### Step 1.1 — SSH into Oracle
```bash
ssh -i nanoclaw-ssh-key ubuntu@129.153.28.75
```

### Step 1.2 — Install system packages
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential git curl wget unzip sqlite3 pipx
```

### Step 1.3 — Install Docker
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu
```

### Step 1.4 — Log out and back in (docker group needs a new session)
```bash
exit
```
```bash
ssh -i nanoclaw-ssh-key ubuntu@129.153.28.75
```

### Step 1.5 — Verify Docker
```bash
docker --version
docker run --rm hello-world
```

Both commands must succeed. If `docker run` gives "permission denied", you didn't log out and back in properly. Do Step 1.4 again.

### Step 1.6 — Install Node.js 20
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs
```

### Step 1.7 — Verify Node.js
```bash
node --version
npm --version
```

Should show v20.x.x.

### Step 1.8 — Install Claude Code
```bash
sudo npm install -g @anthropic-ai/claude-code
```

### Step 1.9 — Install Snowflake CLI
```bash
pipx install snowflake-cli
```

Verify:
```bash
snow --version
```

### Step 1.10 — Enable lingering (keeps user services running after SSH logout)
```bash
sudo loginctl enable-linger ubuntu
```

### Step 1.11 — Set hostname
```bash
sudo hostnamectl set-hostname nanoclaw
```

### Step 1.12 — Create the scripts directory
```bash
mkdir -p ~/scripts
```

### Step 1.13 — Set up SSH key so Hetzner can send files directly

Generate a temporary keypair on Oracle (or reuse your existing one):
```bash
ssh-keygen -t ed25519 -f ~/.ssh/oracle_transfer -N ""
cat ~/.ssh/oracle_transfer.pub
```

Copy that public key. Then SSH into Hetzner in a **separate terminal** and add it:
```bash
ssh -i nanoclaw-ssh-key root@88.198.229.116
echo "PASTE_THE_PUBLIC_KEY_HERE" >> ~/.ssh/authorized_keys
exit
```

Back on Oracle, test the connection:
```bash
ssh -i ~/.ssh/oracle_transfer root@88.198.229.116 "echo OK"
```

Should print `OK`. If it doesn't, fix SSH before proceeding.

### Step 1.14 — Disconnect from Oracle
```bash
exit
```

---

## PHASE 2: Stop services and capture everything on Hetzner

### Step 2.1 — SSH into Hetzner
```bash
ssh -i nanoclaw-ssh-key root@88.198.229.116
```

### Step 2.2 — Stop NanoClaw (prevent state changes during backup)
```bash
systemctl stop nanoclaw
systemctl stop nanoclaw-update.timer
```

Verify it's stopped:
```bash
systemctl status nanoclaw
```

Should say "inactive (dead)".

### Step 2.3 — Commit and push any uncommitted code
```bash
cd ~/nanoclaw
git status
```

If there are uncommitted changes:
```bash
git add -A
git commit -m "pre-migration snapshot"
git push origin main
```

If `git status` is clean, move on.

### Step 2.4 — Create tarball of nanoclaw directory

This captures everything: code, databases, auth files, groups, configs.
```bash
cd ~
tar czf nanoclaw-full.tar.gz \
  --exclude='nanoclaw/node_modules' \
  --exclude='nanoclaw/.git' \
  nanoclaw/
```

Check the size:
```bash
ls -lh ~/nanoclaw-full.tar.gz
```

### Step 2.5 — Create tarball of home directory state

This captures all credentials, configs, and tools outside the repo.
```bash
cd ~
tar czf home-state.tar.gz \
  .claude/ \
  .claude.json \
  .gitconfig \
  .bashrc \
  .profile \
  .gmail-mcp/ \
  .gmail-mcp-personal2/ \
  .gmail-mcp-sunday/ \
  .gmail-mcp-illysium/ \
  .gmail-mcp-numberdrinks/ \
  .snowflake/ \
  .config/google-calendar-mcp/ \
  .config/nanoclaw/ \
  .docker/ \
  .npm/ \
  .npmrc \
  scripts/ \
  2>/dev/null
```

The `2>/dev/null` suppresses errors for any files that don't exist. That's fine.

Check it was created:
```bash
ls -lh ~/home-state.tar.gz
```

### Step 2.6 — Copy systemd service files (these live outside home dir)
```bash
mkdir -p ~/systemd-backup
cp /etc/systemd/system/nanoclaw.service ~/systemd-backup/
cp /etc/systemd/system/nanoclaw-update.service ~/systemd-backup/
cp /etc/systemd/system/nanoclaw-update.timer ~/systemd-backup/
```

### Step 2.7 — Record installed state for reference
```bash
npm list -g --depth=0 > ~/npm-globals.txt
docker images --format "{{.Repository}}:{{.Tag}}" > ~/docker-images.txt
pipx list > ~/pipx-list.txt 2>/dev/null
```

### Step 2.8 — Restart NanoClaw on Hetzner (keep it running during transfer)
```bash
systemctl start nanoclaw
systemctl start nanoclaw-update.timer
```

---

## PHASE 3: Transfer files (Hetzner → Oracle, direct)

### Step 3.1 — SSH into Hetzner (if not already connected)
```bash
ssh -i nanoclaw-ssh-key root@88.198.229.116
```

### Step 3.2 — Send everything directly to Oracle

```bash
scp -i ~/.ssh/id_ed25519 ~/nanoclaw-full.tar.gz ubuntu@129.153.28.75:~/
scp -i ~/.ssh/id_ed25519 ~/home-state.tar.gz ubuntu@129.153.28.75:~/
scp -i ~/.ssh/id_ed25519 -r ~/systemd-backup ubuntu@129.153.28.75:~/
scp -i ~/.ssh/id_ed25519 ~/npm-globals.txt ubuntu@129.153.28.75:~/
scp -i ~/.ssh/id_ed25519 ~/docker-images.txt ubuntu@129.153.28.75:~/
```

**NOTE:** If Hetzner doesn't have an SSH key that Oracle trusts, transfer via your Mac instead:
```bash
# On your Mac:
scp -i nanoclaw-ssh-key root@88.198.229.116:~/nanoclaw-full.tar.gz ./
scp -i nanoclaw-ssh-key root@88.198.229.116:~/home-state.tar.gz ./
scp -i nanoclaw-ssh-key -r root@88.198.229.116:~/systemd-backup ./
scp -i nanoclaw-ssh-key ./nanoclaw-full.tar.gz ubuntu@129.153.28.75:~/
scp -i nanoclaw-ssh-key ./home-state.tar.gz ubuntu@129.153.28.75:~/
scp -i nanoclaw-ssh-key -r ./systemd-backup ubuntu@129.153.28.75:~/
```

### Step 3.3 — Verify files arrived on Oracle
```bash
ssh -i nanoclaw-ssh-key ubuntu@129.153.28.75 "ls -lh ~/*.tar.gz ~/systemd-backup/"
```

You should see both tar.gz files and the 3 systemd files.

---

## PHASE 4: Restore on Oracle

### Step 4.1 — SSH into Oracle
```bash
ssh -i nanoclaw-ssh-key ubuntu@129.153.28.75
```

### Step 4.2 — Extract nanoclaw directory
```bash
cd ~
tar xzf nanoclaw-full.tar.gz
```

This creates `~/nanoclaw/` with all code, databases, groups, auth, configs.

Verify:
```bash
ls ~/nanoclaw/.env
ls ~/nanoclaw/store/messages.db
ls ~/nanoclaw/groups/
```

All three should exist.

### Step 4.3 — Extract home directory state
```bash
cd ~
tar xzf home-state.tar.gz
```

Verify critical files:
```bash
ls ~/.gmail-mcp/credentials.json
ls ~/.gmail-mcp-sunday/credentials.json
ls ~/.snowflake/connections.toml
ls ~/.snowflake/keys/sunday/rsa_key.p8
ls ~/.config/google-calendar-mcp/tokens.json
ls ~/.claude.json
```

All should exist. If any are missing, go back and check the tar on Hetzner.

### Step 4.4 — Clone bootstrap repo
```bash
cd ~
git clone https://github.com/davekim917/bootstrap.git
```

### Step 4.5 — Set up git remote for nanoclaw
```bash
cd ~/nanoclaw
git remote set-url origin https://github.com/davekim917/nanoclaw.git
git remote add upstream https://github.com/qwibitai/nanoclaw.git 2>/dev/null
git pull origin main
```

---

## PHASE 5: Fix all paths (`/root/` → `/home/ubuntu/`)

This is the most critical phase. Every file that references `/root/` must be updated.

### Step 5.1 — Fix nanoclaw config files

```bash
cd ~/nanoclaw

# Find every config file that references /root/
grep -rl "/root/" \
  --include="*.env" \
  --include="*.json" \
  --include="*.yaml" \
  --include="*.yml" \
  --include="*.sh" \
  --include="*.conf" \
  --include="*.toml" \
  --include="*.service" \
  . 2>/dev/null | grep -v node_modules | grep -v .git | sort
```

Review this list. Then apply the fix:
```bash
grep -rl "/root/" \
  --include="*.env" \
  --include="*.json" \
  --include="*.yaml" \
  --include="*.yml" \
  --include="*.sh" \
  --include="*.conf" \
  --include="*.toml" \
  --include="*.service" \
  . 2>/dev/null | grep -v node_modules | grep -v .git | while read f; do
    echo "Fixing: $f"
    sed -i 's|/root/|/home/ubuntu/|g' "$f"
done
```

**IMPORTANT:** We replace `/root/` (with trailing slash) not `/root` (without). This avoids mangling strings like `-root-nanoclaw` in Claude project paths.

### Step 5.2 — Fix Snowflake config
```bash
sed -i 's|/root/|/home/ubuntu/|g' ~/.snowflake/config.toml
sed -i 's|/root/|/home/ubuntu/|g' ~/.snowflake/connections.toml
```

Verify all 5 connections now point to `/home/ubuntu/`:
```bash
grep private_key_path ~/.snowflake/connections.toml
```

Should show `/home/ubuntu/.snowflake/keys/...` for every line.

Also verify log path:
```bash
grep path ~/.snowflake/config.toml
```

Should show `/home/ubuntu/.snowflake/logs`.

### Step 5.3 — Fix Claude Code settings
```bash
sed -i 's|/root/|/home/ubuntu/|g' ~/.claude/settings.json
sed -i 's|/root/|/home/ubuntu/|g' ~/.claude.json
```

Verify:
```bash
grep -n "root" ~/.claude/settings.json
```

Should return nothing (or only non-path references).

### Step 5.4 — Fix Claude Code project directory name

Claude Code encodes the working directory in the project folder name. The old name `-root-nanoclaw` must become `-home-ubuntu-nanoclaw`.

```bash
# Check the old directory exists
ls ~/.claude/projects/-root-nanoclaw/

# Rename it
mv ~/.claude/projects/-root-nanoclaw ~/.claude/projects/-home-ubuntu-nanoclaw

# Also rename the root-only project if it exists
if [ -d ~/.claude/projects/-root ]; then
  mv ~/.claude/projects/-root ~/.claude/projects/-home-ubuntu
fi
```

Verify:
```bash
ls ~/.claude/projects/
```

Should show `-home-ubuntu-nanoclaw` (not `-root-nanoclaw`).

### Step 5.5 — Fix mount allowlist
```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

It currently says `"path": "/root"`. Fix it:
```bash
sed -i 's|"/root"|"/home/ubuntu"|g' ~/.config/nanoclaw/mount-allowlist.json
```

Verify:
```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

Should show `"path": "/home/ubuntu"`.

### Step 5.6 — Fix the auto-update script
```bash
sed -i 's|/root/|/home/ubuntu/|g' ~/scripts/nanoclaw-auto-update.sh
```

Verify:
```bash
cat ~/scripts/nanoclaw-auto-update.sh
```

Should reference `/home/ubuntu/nanoclaw` not `/root/nanoclaw`.

Make it executable:
```bash
chmod +x ~/scripts/nanoclaw-auto-update.sh
```

### Step 5.7 — Fix systemd service files
```bash
cd ~/systemd-backup

# Fix all three files
sed -i 's|/root/|/home/ubuntu/|g' nanoclaw.service
sed -i 's|/root|/home/ubuntu|g' nanoclaw.service
sed -i 's|/root/|/home/ubuntu/|g' nanoclaw-update.service
sed -i 's|/root|/home/ubuntu|g' nanoclaw-update.service
```

**Add User/Group directives** to both .service files (because we're running as ubuntu, not root):

Edit `nanoclaw.service` — add these two lines inside the `[Service]` section:
```bash
sed -i '/^\[Service\]/a User=ubuntu\nGroup=ubuntu' nanoclaw.service
```

Edit `nanoclaw-update.service` — same thing:
```bash
sed -i '/^\[Service\]/a User=ubuntu\nGroup=ubuntu' nanoclaw-update.service
```

Now verify **nanoclaw.service**:
```bash
cat nanoclaw.service
```

It should look like:
```
[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
User=ubuntu
Group=ubuntu
Type=simple
ExecStart=/usr/bin/node /home/ubuntu/nanoclaw/dist/index.js
WorkingDirectory=/home/ubuntu/nanoclaw
Restart=always
RestartSec=5
Environment=HOME=/home/ubuntu
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/home/ubuntu/.local/bin
StandardOutput=append:/home/ubuntu/nanoclaw/logs/nanoclaw.log
StandardError=append:/home/ubuntu/nanoclaw/logs/nanoclaw.error.log

[Install]
WantedBy=multi-user.target
```

Verify **nanoclaw-update.service**:
```bash
cat nanoclaw-update.service
```

Should reference `/home/ubuntu/scripts/nanoclaw-auto-update.sh` and `/home/ubuntu/nanoclaw/logs/`.

Verify **nanoclaw-update.timer** (should need no changes):
```bash
cat nanoclaw-update.timer
```

Should just have the timer schedule, no paths.

### Step 5.8 — Install systemd files
```bash
sudo cp ~/systemd-backup/nanoclaw.service /etc/systemd/system/
sudo cp ~/systemd-backup/nanoclaw-update.service /etc/systemd/system/
sudo cp ~/systemd-backup/nanoclaw-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

### Step 5.9 — Fix the deploy script
```bash
sed -i 's|/root/|/home/ubuntu/|g' ~/nanoclaw/scripts/deploy.sh
chmod +x ~/nanoclaw/scripts/deploy.sh
```

### Step 5.10 — Fix any remaining files in .claude directory
```bash
find ~/.claude -type f \( -name "*.json" -o -name "*.sh" -o -name "*.md" \) -exec grep -l "/root/" {} \; 2>/dev/null | while read f; do
    echo "Fixing: $f"
    sed -i 's|/root/|/home/ubuntu/|g' "$f"
done
```

### Step 5.11 — Final sweep: check nothing was missed
```bash
echo "=== nanoclaw directory ==="
grep -r "/root/" ~/nanoclaw/ \
  --include="*.env" --include="*.json" --include="*.yaml" \
  --include="*.yml" --include="*.sh" --include="*.conf" \
  --include="*.toml" --include="*.service" --include="*.md" \
  2>/dev/null | grep -v node_modules | grep -v ".git/" | grep -v ".trash/"

echo "=== snowflake ==="
grep -r "/root/" ~/.snowflake/ 2>/dev/null

echo "=== claude ==="
grep -r "/root/" ~/.claude/settings.json ~/.claude.json 2>/dev/null

echo "=== systemd ==="
grep -r "/root" /etc/systemd/system/nanoclaw* 2>/dev/null

echo "=== mount allowlist ==="
grep "/root" ~/.config/nanoclaw/mount-allowlist.json 2>/dev/null
```

**Every single one of these should return nothing.** If any output appears, fix that file before proceeding.

---

## PHASE 6: Fix ownership and build

### Step 6.1 — Fix ownership of everything
```bash
sudo chown -R ubuntu:ubuntu ~/nanoclaw
sudo chown -R ubuntu:ubuntu ~/.claude
sudo chown -R ubuntu:ubuntu ~/.claude.json
sudo chown -R ubuntu:ubuntu ~/.gmail-mcp
sudo chown -R ubuntu:ubuntu ~/.gmail-mcp-personal2
sudo chown -R ubuntu:ubuntu ~/.gmail-mcp-sunday
sudo chown -R ubuntu:ubuntu ~/.gmail-mcp-illysium
sudo chown -R ubuntu:ubuntu ~/.gmail-mcp-numberdrinks
sudo chown -R ubuntu:ubuntu ~/.snowflake
sudo chown -R ubuntu:ubuntu ~/.config
sudo chown -R ubuntu:ubuntu ~/.docker 2>/dev/null
sudo chown -R ubuntu:ubuntu ~/scripts
sudo chown -R ubuntu:ubuntu ~/bootstrap
```

### Step 6.2 — Create logs directory
```bash
mkdir -p ~/nanoclaw/logs
```

### Step 6.3 — Install npm dependencies
```bash
cd ~/nanoclaw
npm install
```

If you get native module compilation errors (ARM vs x86):
```bash
rm -rf node_modules package-lock.json
npm install
```

### Step 6.4 — Build the project
```bash
npm run build
```

Must complete with no errors.

### Step 6.5 — Build the Docker agent container
```bash
cd ~/nanoclaw
./container/build.sh
```

Verify the image exists:
```bash
docker images | grep nanoclaw
```

Should show `nanoclaw-agent` with a recent timestamp.

---

## PHASE 7: Authenticate services

### Step 7.1 — Authenticate Claude Code
```bash
cd ~/nanoclaw
claude
```

It will show a URL. Open it in your browser, log in with your Anthropic account (david.kim6@gmail.com), authorize. Once you see "authenticated", exit with `/exit`.

### Step 7.2 — Re-authenticate Granola MCP

The Granola OAuth token is tied to the old working directory path and won't transfer. You need to re-auth.

Open a **second terminal** on your Mac for the SSH tunnel:
```bash
ssh -i nanoclaw-ssh-key -L 3000:localhost:3000 ubuntu@129.153.28.75
```

In the **first terminal** (still SSHed into Oracle):
```bash
cd ~/nanoclaw
claude
```

Inside Claude Code, run:
```
/mcp
```

Find Granola in the list and authenticate. It will open a browser URL — use `http://localhost:3000/...` via the tunnel. Once done, `/exit`.

### Step 7.3 — Test WhatsApp auth (try before re-pairing)

The `store/auth/` directory was migrated with all Baileys session data. It **might** work without re-pairing. We'll test this when we start the service.

If it doesn't connect (you'll see auth errors in the logs), then re-pair:
```bash
cd ~/nanoclaw
npm run auth
```

Scan the QR code with your phone.

### Step 7.4 — Test Snowflake connections
```bash
snow sql -c sunday -q "SELECT 1 AS test;"
snow sql -c apollo -q "SELECT 1 AS test;"
```

Both should return a row. If you get "IP not allowed", go back to Step 0.1 and check the network policy.

---

## PHASE 8: Stop Hetzner, start Oracle

### Step 8.1 — Stop NanoClaw on Hetzner

**CRITICAL:** Do NOT run both servers simultaneously. WhatsApp and Discord will have session conflicts.

From your Mac:
```bash
ssh -i nanoclaw-ssh-key root@88.198.229.116 "systemctl stop nanoclaw && systemctl stop nanoclaw-update.timer && systemctl disable nanoclaw && systemctl disable nanoclaw-update.timer"
```

Verify it's stopped:
```bash
ssh -i nanoclaw-ssh-key root@88.198.229.116 "systemctl status nanoclaw"
```

Should say "inactive (dead)" and "disabled".

### Step 8.2 — Start NanoClaw on Oracle

SSH into Oracle:
```bash
ssh -i nanoclaw-ssh-key ubuntu@129.153.28.75
```

Enable and start:
```bash
sudo systemctl enable nanoclaw
sudo systemctl enable nanoclaw-update.timer
sudo systemctl start nanoclaw
sudo systemctl start nanoclaw-update.timer
```

### Step 8.3 — Check service status
```bash
sudo systemctl status nanoclaw
```

Should say "active (running)".

### Step 8.4 — Watch logs for errors
```bash
tail -f ~/nanoclaw/logs/nanoclaw.log
```

Watch for 1-2 minutes. Look for:
- "listening" or "connected" messages (good)
- "ENOENT" or "not found" errors (missing files — path issue)
- "/root/" appearing anywhere (missed a path fix)
- WhatsApp auth errors (need to re-pair — see Step 7.3)
- "EACCES" or "permission denied" (ownership issue — re-run Step 6.1)

Press `Ctrl+C` to stop watching.

### Step 8.5 — Test it

Send a message to any channel (Discord, WhatsApp, Telegram, Slack) with your trigger word. Verify you get a response.

### Step 8.6 — Verify database integrity

Send a follow-up message in an **existing thread** to confirm old conversation history is accessible.

### Step 8.7 — Verify scheduled tasks

Check the auto-update timer is active:
```bash
sudo systemctl status nanoclaw-update.timer
```

Should show "active (waiting)" with the next trigger time.

### Step 8.8 — Check all channels

Test each channel individually:
- [ ] Discord — send message in #general
- [ ] WhatsApp — send message
- [ ] Telegram — send message
- [ ] Slack — send message in a tracked channel
- [ ] Gmail — check that daily digest runs (or trigger manually)

---

## PHASE 9: Post-migration (after 24 hours of stability)

### Step 9.1 — Update MEMORY.md

The project memory references the Hetzner IP. Update it:
```bash
cd ~/nanoclaw
claude
```

Tell Claude: "Update MEMORY.md — server IP is now 129.153.28.75 (Oracle Cloud), not 88.198.229.116 (Hetzner)"

### Step 9.2 — Remove Hetzner IP from Snowflake network policies

Once you're confident Oracle is stable, remove the old IP:

**Sunday account:**
```sql
ALTER NETWORK POLICY <your_policy_name> SET ALLOWED_IP_LIST = ('129.153.28.75');
```

**XZO/Apollo account:**
```sql
ALTER NETWORK POLICY <your_policy_name> SET ALLOWED_IP_LIST = ('129.153.28.75');
```

### Step 9.3 — Clean up transfer artifacts on Oracle
```bash
rm ~/nanoclaw-full.tar.gz
rm ~/home-state.tar.gz
rm -rf ~/systemd-backup
rm ~/npm-globals.txt ~/docker-images.txt
```

### Step 9.4 — Clean up Hetzner SSH key (if you added one in Step 1.13)
```bash
ssh -i nanoclaw-ssh-key root@88.198.229.116
# Remove the Oracle transfer key from authorized_keys
nano ~/.ssh/authorized_keys  # remove the oracle_transfer line
exit
```

### Step 9.5 — Decommission Hetzner

Only after Oracle has been stable for 24+ hours with all channels working.

Delete the Hetzner server from the Hetzner Console UI.

---

## TROUBLESHOOTING

### Service won't start
```bash
# Check the exact error
sudo journalctl -u nanoclaw --no-pager -n 50

# Most common: leftover /root/ path
grep -r "/root/" /etc/systemd/system/nanoclaw* ~/nanoclaw/.env
```

### "Permission denied" errors
```bash
sudo chown -R ubuntu:ubuntu ~/nanoclaw ~/.claude ~/.config ~/.gmail-mcp* ~/.snowflake ~/scripts ~/bootstrap
```

### Docker permission denied
```bash
# Verify ubuntu is in docker group
groups
# If "docker" not listed:
sudo usermod -aG docker ubuntu
# Then log out and back in
exit
```

### WhatsApp disconnected
```bash
cd ~/nanoclaw
npm run auth
# Scan QR code with phone
sudo systemctl restart nanoclaw
```

### Claude Code auth expired
```bash
cd ~/nanoclaw
claude
# Follow the auth URL prompt, then /exit
```

### Snowflake "IP not allowed"
```bash
# Check your public IP from Oracle
curl -s ifconfig.me
# Add that IP to Snowflake network policy (Step 0.1)
```

### Container agent can't find files
```bash
# Check mount allowlist
cat ~/.config/nanoclaw/mount-allowlist.json
# Should show /home/ubuntu, not /root
```

### Logs show "/root/" in error messages
```bash
# Nuclear option: find and fix every remaining reference
find ~ -type f -not -path "*/node_modules/*" -not -path "*/.git/*" \
  \( -name "*.env" -o -name "*.json" -o -name "*.toml" -o -name "*.sh" \
     -o -name "*.service" -o -name "*.conf" -o -name "*.yaml" -o -name "*.yml" \) \
  -exec grep -l "/root/" {} \; 2>/dev/null
# Fix each file found
```

### Node modules won't compile (architecture mismatch)
```bash
cd ~/nanoclaw
rm -rf node_modules package-lock.json
npm install
npm run build
```

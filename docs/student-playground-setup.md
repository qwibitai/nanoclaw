# Agent Playground Setup

## Part 1: Terminal Commands

SSH into your VPS and run these commands:

```bash
# Open firewall ports (web hosting + playground)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3002/tcp

# Install Caddy web server
cd /tmp
wget "https://github.com/caddyserver/caddy/releases/download/v2.9.1/caddy_2.9.1_linux_amd64.deb"
sudo dpkg -i caddy_2.9.1_linux_amd64.deb

# Create web hosting directory
sudo mkdir -p /var/www/sites
sudo chown $USER:$USER /var/www/sites

# Configure Caddy
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
:80 {
    root * /var/www/sites
    file_server browse
}
EOF

# Start Caddy
sudo systemctl enable caddy
sudo systemctl restart caddy

# Upgrade Claude Code
claude update
```

## Part 2: Claude Code

Open Claude Code:

```bash
cd ~/nanoclaw
claude
```

Then paste this prompt:

```
Pull the latest from my instructor's repo and set up the playground. Here's what to do:

git pull https://github.com/chiptoe-svg/nanoclaw_gccourse.git main

If there are merge conflicts, resolve them:
- For src/transcription.ts and src/channels/telegram.ts: keep MY version (local) if I already have voice transcription working, otherwise take theirs
- For everything else: take the incoming (upstream) version
- For package-lock.json: just delete it and let npm regenerate it

After the merge is clean:

1. npm install
2. npm run build
3. Add Environment=PLAYGROUND_ENABLED=1 to ~/.config/systemd/user/nanoclaw.service (under [Service], after the existing Environment lines — skip if already there)
4. systemctl --user daemon-reload
5. systemctl --user restart nanoclaw
6. Verify: systemctl --user status nanoclaw
7. Verify: ss -tlnp | grep 3002

Also update the main agent's persona (the CLAUDE.md in whichever group folder has is_main=1 in the database) — add this section if it doesn't already have it:

## Web Hosting

You can create and host websites. Find your IP with: curl -4 ifconfig.me

To create a site, write HTML/CSS/JS files to /var/www/sites/<site-name>/.
The site will be immediately available at http://<YOUR_IP>/<site-name>/.

Keep sites self-contained (inline CSS/JS or relative paths). No build tools needed — just static files.
```

## Part 3: Verify

1. Open `http://YOUR_VPS_IP:3002` in your browser
2. Enter password: `godfrey`
3. You should see the Agent Playground with three modes: **Test**, **Agent Persona**, and **Skills**

## What You Can Do

- **Test mode**: Chat with your draft agent and watch the execution trace
- **Agent Persona mode**: Edit your agent's persona, browse a library of persona templates, copy/paste sections into your draft
- **Skills mode**: View your agent's skills, browse available skill libraries, add skills to your agent
- **Apply to Main**: When you're happy with your draft, click Apply to push changes to your live Telegram agent

# Add Web Hosting to NanoClaw

Your agent will be able to create and host websites on your VPS.

## Step 1: Pull the Latest Changes

```bash
cd nanoclaw
git pull
npm run build
```

## Step 2: Install Caddy (Web Server)

```bash
cd /tmp
wget "https://github.com/caddyserver/caddy/releases/download/v2.9.1/caddy_2.9.1_linux_amd64.deb"
sudo dpkg -i caddy_2.9.1_linux_amd64.deb
```

## Step 3: Create Sites Directory

```bash
sudo mkdir -p /var/www/sites
sudo chown $USER:$USER /var/www/sites
```

## Step 4: Configure Caddy

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
:80 {
	root * /var/www/sites
	file_server browse
}
EOF
```

## Step 5: Open Firewall and Start Caddy

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo systemctl enable caddy
sudo systemctl restart caddy
```

## Step 6: Tell Your Agent About It

Edit `groups/global/CLAUDE.md` and add this section:

```
## Web Hosting

You can create and host websites. The server is at http://YOUR_VPS_IP

To create a site, write HTML/CSS/JS files to /var/www/sites/<site-name>/.
The site will be immediately available at http://YOUR_VPS_IP/<site-name>/.

Keep sites self-contained (inline CSS/JS or relative paths). No build tools needed — just static files.
```

Replace `YOUR_VPS_IP` with your actual VPS IP address (find it with `curl -4 ifconfig.me`).

## Step 7: Restart NanoClaw

```bash
systemctl --user restart nanoclaw
```

## Step 8: Test It

Send a message to your bot in Telegram:

```
@Andy create a simple website about cats
```

Your agent will build the site and give you the link.

## Adding a Domain (Optional)

1. Point your domain's A record to your VPS IP
2. Update `/etc/caddy/Caddyfile`:

```
yourdomain.com {
	root * /var/www/sites
	file_server browse
}
```

3. `sudo systemctl restart caddy` — Caddy handles SSL automatically.

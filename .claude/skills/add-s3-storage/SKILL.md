# Add S3-Compatible Storage

Sets up two things for your NanoClaw installation:

1. **Automated backups** — runtime data (WhatsApp session, group memory, OAuth credentials, databases) backed up to S3 every 6 hours via systemd timer
2. **Live file mount** — your bucket's `files/` prefix mounted at `~/s3/` on the VPS, accessible from anywhere (Windows, Mac, Linux) via rclone

Works with any S3-compatible provider: Cloudflare R2, Backblaze B2, AWS S3, Wasabi, MinIO, etc.

## Storage Architecture

```
Everything on your VPS
│
├── CODE & CONFIG ──────────────── GitHub
│   └── src/, skills, CLAUDE.md, etc.
│
├── RUNTIME BACKUPS ────────────── S3: <bucket>/backups/
│   ├── nanoclaw/store/            WhatsApp session + messages DB
│   ├── nanoclaw/groups/           Group memory (CLAUDE.md files)
│   └── credentials/               Gmail + GDrive OAuth tokens
│
└── LIVE FILES ─────────────────── S3: <bucket>/files/  →  ~/s3/
    ├── docs/                      Notes, reference documents
    ├── consulting/                Client files, proposals
    └── shared/                    Files the agent should access
```

**Decision rules:**
| File type | Goes to |
|-----------|---------|
| Source code, config, skills | GitHub |
| Runtime data (DBs, sessions, auth tokens) | S3 backups/ |
| Documents you author or want anywhere | S3 files/ (~/s3/) |
| Secrets (.env) | Nowhere — local only |

## Phase 1: Provider Setup

Ask the user which S3-compatible provider they are using. Use `AskUserQuestion` with these options:

- **Cloudflare R2** — free egress, 10GB free tier, great for backups + files
- **Backblaze B2** — cheapest storage ($0.006/GB), best throughput for backups
- **AWS S3** — most features, highest cost
- **Wasabi** — no egress fees, $0.0069/GB
- **Other (S3-compatible)** — ask for endpoint URL

For **Cloudflare R2**, guide them to:
> Cloudflare Dashboard → R2 → Overview → Manage R2 API Tokens → Create API Token
> Set: Object Read & Write on specific bucket, no expiry
> Copy: Access Key ID, Secret Access Key, Account ID

Endpoint format for R2: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`

For **Backblaze B2**:
> B2 Cloud Storage → App Keys → Add a New Application Key
> Endpoint format: `https://s3.<REGION>.backblazeb2.com`

For **AWS S3**: No endpoint needed (rclone uses AWS defaults), use `provider = AWS`.

Collect:
- `BUCKET_NAME` — name of the bucket (must already exist)
- `ACCESS_KEY_ID`
- `SECRET_ACCESS_KEY`
- `ENDPOINT_URL` (not needed for AWS S3)

## Phase 2: Install rclone

Check if rclone is installed:

```bash
which rclone && rclone --version | head -1 || echo "NOT_INSTALLED"
```

If not installed:

```bash
curl -fsSL https://downloads.rclone.org/rclone-current-linux-amd64.zip -o /tmp/rclone.zip
cd /tmp && python3 -c "import zipfile; zipfile.ZipFile('rclone.zip').extractall('.')"
cp /tmp/rclone-*-linux-amd64/rclone ~/.local/bin/rclone
chmod +x ~/.local/bin/rclone
rm -rf /tmp/rclone.zip /tmp/rclone-*-linux-amd64
rclone --version | head -1
```

## Phase 3: Configure rclone

Write `~/.config/rclone/rclone.conf`:

```ini
[s3]
type = s3
provider = Other
access_key_id = <ACCESS_KEY_ID>
secret_access_key = <SECRET_ACCESS_KEY>
endpoint = <ENDPOINT_URL>
acl = private
```

For AWS S3, use `provider = AWS` and omit `endpoint`.

Test the connection:

```bash
rclone ls s3:<BUCKET_NAME>/ 2>&1 | head -5
```

If you get `AccessDenied` on listing (common with per-bucket tokens), test a specific path:

```bash
rclone ls s3:<BUCKET_NAME>/backups/ 2>&1
```

Empty output = success (bucket exists, no files yet).

## Phase 4: Create bucket structure

Create the folder structure by uploading placeholder files (S3 has no real empty folders):

```bash
mkdir -p ~/s3/docs ~/s3/consulting ~/s3/shared
```

Wait for mount to be active first (Phase 6), then create placeholders via the mount. Or create directly:

```bash
echo "# Docs" | rclone rcat s3:<BUCKET_NAME>/files/docs/.keep
echo "# Consulting" | rclone rcat s3:<BUCKET_NAME>/files/consulting/.keep
echo "# Shared" | rclone rcat s3:<BUCKET_NAME>/files/shared/.keep
```

## Phase 5: Create backup script

Write `~/backup.sh`:

```bash
#!/bin/bash
# VPS backup to S3-compatible storage via rclone
# Runs via systemd timer every 6 hours.

RCLONE=$HOME/.local/bin/rclone
LOG=$HOME/backup.log

echo "[$(date -Iseconds)] Starting backup" >> "$LOG"

# NanoClaw runtime data
$RCLONE sync $HOME/nanoclaw/store/      s3:<BUCKET_NAME>/backups/nanoclaw/store/      --checksum 2>> "$LOG"
$RCLONE sync $HOME/nanoclaw/groups/     s3:<BUCKET_NAME>/backups/nanoclaw/groups/     --checksum 2>> "$LOG"

# OAuth credentials
[ -d $HOME/.gmail-mcp ]  && $RCLONE sync $HOME/.gmail-mcp/  s3:<BUCKET_NAME>/backups/credentials/gmail-mcp/  --checksum 2>> "$LOG"
[ -d $HOME/.gdrive-mcp ] && $RCLONE sync $HOME/.gdrive-mcp/ s3:<BUCKET_NAME>/backups/credentials/gdrive-mcp/ --checksum 2>> "$LOG"

echo "[$(date -Iseconds)] Backup complete" >> "$LOG"
```

Make executable: `chmod +x ~/backup.sh`

Test it: `~/backup.sh && tail -3 ~/backup.log`

## Phase 6: Set up systemd units

Create mount service `~/.config/systemd/user/rclone-s3.service`:

```ini
[Unit]
Description=rclone mount S3-compatible storage files/ at ~/s3
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=/home/<USER>/.local/bin/rclone mount s3:<BUCKET_NAME>/files/ /home/<USER>/s3 \
  --vfs-cache-mode writes \
  --vfs-cache-max-size 500M \
  --dir-cache-time 5m \
  --allow-non-empty \
  --skip-links \
  --log-level INFO
ExecStop=/bin/fusermount -u /home/<USER>/s3
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

Create backup service `~/.config/systemd/user/vps-backup.service`:

```ini
[Unit]
Description=VPS backup to S3-compatible storage
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/home/<USER>/backup.sh
```

Create backup timer `~/.config/systemd/user/vps-backup.timer`:

```ini
[Unit]
Description=Run VPS backup every 6 hours

[Timer]
OnBootSec=5min
OnUnitActiveSec=6h
Persistent=true

[Install]
WantedBy=timers.target
```

Replace `<USER>` with the actual username (`whoami`).

Create mount point and enable everything:

```bash
mkdir -p ~/s3
systemctl --user daemon-reload
systemctl --user enable --now rclone-s3.service
systemctl --user enable --now vps-backup.timer
```

Verify:

```bash
systemctl --user status rclone-s3.service --no-pager | grep Active
systemctl --user status vps-backup.timer --no-pager | grep Active
ls ~/s3/
```

## Phase 7: Desktop mount (Windows / macOS / Linux desktop)

Tell the user they can access the same `files/` bucket from any device. The rclone config is the same — just copy it across.

### Windows

> 1. Install [WinFsp](https://winfsp.dev/rel/) — provides FUSE support on Windows
> 2. Install [rclone for Windows](https://rclone.org/downloads/)
> 3. Copy `~/.config/rclone/rclone.conf` from the VPS to `%APPDATA%\rclone\rclone.conf` on Windows
> 4. Mount: `rclone mount s3:<BUCKET_NAME>/files/ Z: --vfs-cache-mode writes --skip-links`
>
> **Auto-mount on startup:** Create a `.bat` file with the mount command and save it to:
> `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`

### macOS

> 1. Install [macFUSE](https://osxfuse.github.io/) (free) — provides FUSE support on macOS
> 2. Install rclone: `brew install rclone`
> 3. Copy the VPS rclone config to `~/.config/rclone/rclone.conf`
> 4. Create mount point: `mkdir -p ~/s3`
> 5. Mount: `rclone mount s3:<BUCKET_NAME>/files/ ~/s3 --vfs-cache-mode writes --skip-links`
>
> **Auto-mount on startup** via launchd. Create `~/Library/LaunchAgents/com.rclone.s3.plist`:
>
> ```xml
> <?xml version="1.0" encoding="UTF-8"?>
> <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
> <plist version="1.0">
> <dict>
>   <key>Label</key><string>com.rclone.s3</string>
>   <key>ProgramArguments</key>
>   <array>
>     <string>/usr/local/bin/rclone</string>
>     <string>mount</string>
>     <string>s3:<BUCKET_NAME>/files/</string>
>     <string>/Users/<USER>/s3</string>
>     <string>--vfs-cache-mode</string><string>writes</string>
>     <string>--skip-links</string>
>   </array>
>   <key>RunAtLoad</key><true/>
>   <key>KeepAlive</key><true/>
> </dict>
> </plist>
> ```
>
> Then: `launchctl load ~/Library/LaunchAgents/com.rclone.s3.plist`
>
> Replace `/usr/local/bin/rclone` with the output of `which rclone` if installed differently (e.g. `/opt/homebrew/bin/rclone` on Apple Silicon).

### Linux desktop

> 1. Install rclone: `curl -fsSL https://rclone.org/install.sh | sudo bash`
>    Or via package manager: `sudo apt install rclone` / `sudo dnf install rclone`
> 2. Copy the VPS rclone config to `~/.config/rclone/rclone.conf`
> 3. Install FUSE if needed: `sudo apt install fuse3` / `sudo dnf install fuse3`
> 4. Create mount point: `mkdir -p ~/s3`
> 5. Mount: `rclone mount s3:<BUCKET_NAME>/files/ ~/s3 --vfs-cache-mode writes --skip-links &`
>
> **Auto-mount on startup** via systemd user unit — same as the VPS setup in Phase 6 above.
> Create `~/.config/systemd/user/rclone-s3.service` with the same content (adjusting paths), then:
> ```bash
> systemctl --user enable --now rclone-s3.service
> loginctl enable-linger $USER   # keep user services alive without login
> ```

## Phase 8: Verify

Run a final check:

```bash
# Backup works
~/backup.sh && tail -3 ~/backup.log

# Mount works
ls ~/s3/

# Files in R2
rclone ls s3:<BUCKET_NAME>/files/ 2>&1 | head -10
rclone size s3:<BUCKET_NAME>/backups/ 2>&1
```

Report to the user:
- Total data backed up (size + object count)
- Mount status
- Next backup time: `systemctl --user status vps-backup.timer | grep Next`

## Troubleshooting

**403 AccessDenied on lsd (list all buckets):** Normal with per-bucket tokens. Test with `rclone ls s3:<BUCKET>/` instead.

**Mount shows "symlinks not supported" error:** Add `--skip-links` flag (already included above).

**Mount not persisting after reboot:** Check `loginctl enable-linger <USER>` is set so user services run without login.

**Restore from backup:**
```bash
rclone sync s3:<BUCKET_NAME>/backups/nanoclaw/store/ ~/nanoclaw/store/ --checksum
rclone sync s3:<BUCKET_NAME>/backups/credentials/gmail-mcp/ ~/.gmail-mcp/ --checksum
```

**Check backup logs:** `tail -50 ~/backup.log`

**Windows mount errors:** Ensure WinFsp is installed before rclone mount. Run command prompt as Administrator if mount fails.

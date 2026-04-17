# NanoClaw Cheat Sheet

A handy reference of commands you'll actually want when running NanoClaw and the T-Watch S3. Organized by what you're trying to do.

---

## Service control

| What you want to do | Command |
|---|---|
| Restart NanoClaw | `systemctl --user restart nanoclaw` |
| Stop NanoClaw | `systemctl --user stop nanoclaw` |
| Start NanoClaw | `systemctl --user start nanoclaw` |
| Is NanoClaw running? | `systemctl --user is-active nanoclaw` |
| Full status (PID, uptime, last log lines) | `systemctl --user status nanoclaw` |
| Restart signal-cli daemon | `systemctl --user restart signal-cli` |
| Restart White Noise daemon | `systemctl --user restart wnd` |
| Restart Nostr signing daemon | `systemctl --user restart nostr-signer` |

---

## Logs

| What you want to do | Command |
|---|---|
| Watch the live log | `tail -f ~/NanoClaw/logs/nanoclaw.log` |
| Last 50 lines | `tail -50 ~/NanoClaw/logs/nanoclaw.log` |
| Live log filtered to watch activity | `tail -f ~/NanoClaw/logs/nanoclaw.log \| grep watch:` |
| Live log filtered to one chat (find errors) | `tail -f ~/NanoClaw/logs/nanoclaw.log \| grep -i error` |
| Today's backup log | `tail -30 ~/NanoClaw/logs/backup.log` |
| systemd's view of recent NanoClaw output | `journalctl --user -u nanoclaw -n 100` |

---

## T-Watch S3

| What you want to do | Command |
|---|---|
| Build firmware (no flash) | `cd ~/projects/nanoclaw-watch && ~/.local/bin/pio run` |
| Build & flash firmware | `cd ~/projects/nanoclaw-watch && ~/.local/bin/pio run --target upload` |
| Watch serial output (Python — works headless) | `python3 -c "import serial,time;s=serial.Serial('/dev/ttyACM0',115200,timeout=0.5);end=time.time()+60` followed by a `while time.time()<end: line=s.readline().decode(errors='replace').rstrip();` <br>(*Easier: ask Claude to capture serial for N seconds*) |
| Confirm watch is plugged in | `ls /dev/ttyACM*` |
| Force a clean rebuild (clears cached `.o` files) | `cd ~/projects/nanoclaw-watch && ~/.local/bin/pio run --target clean && ~/.local/bin/pio run` |
| **Enable Signal mirror** of watch conversations | `echo 'WATCH_SIGNAL_MIRROR_JID=signal:198c1cdb-8856-4ac7-9b84-a504a0017c79' >> ~/NanoClaw/.env && systemctl --user restart nanoclaw` |
| **Disable Signal mirror** | `sed -i '/WATCH_SIGNAL_MIRROR_JID/d' ~/NanoClaw/.env && systemctl --user restart nanoclaw` |
| Confirm mirror is currently on | `grep WATCH_SIGNAL_MIRROR_JID ~/NanoClaw/.env` |
| Recover stuck watch (force bootloader) | Hold the side button while plugging in USB, then reflash |
| Hard power-cycle a wedged watch | Hold side button **8+ seconds** to force AXP2101 power off, wait 3 sec, short press to boot |
| **Flash workaround** if `pio run --target upload` fails with `OSError: [Errno 71] Protocol error` (EPROTO) | Use the EPROTO-tolerant wrapper at `/tmp/flash-watch.py`. **CRITICAL: must flash all 4 files at correct offsets, NOT just firmware.bin to 0x0 — that overwrites the bootloader and bricks the watch.** Correct invocation:<br>`~/.platformio/penv/bin/python /tmp/flash-watch.py --chip esp32s3 --port /dev/ttyACM0 --baud 460800 write-flash 0x0 ~/projects/nanoclaw-watch/.pio/build/twatch-s3/bootloader.bin 0x8000 ~/projects/nanoclaw-watch/.pio/build/twatch-s3/partitions.bin 0xe000 ~/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin 0x10000 ~/projects/nanoclaw-watch/.pio/build/twatch-s3/firmware.bin` |
| Recover a watch where the bootloader was overwritten | Same all-4-files command above. The ESP32-S3 BOOTROM is in silicon and always responds to esptool even when the flash is corrupt. Plug USB, run the command, you're back. |

---

## Database queries (SQLite)

NanoClaw stores everything in `~/NanoClaw/store/messages.db`. The `sqlite3` CLI isn't installed system-wide, so use Node:

| What you want to do | Command |
|---|---|
| List all registered groups + folders | `node -e "const db=require('better-sqlite3')('store/messages.db');console.table(db.prepare('SELECT jid,name,folder FROM registered_groups').all())"` |
| Last 10 watch messages (transcribed) | `node -e "const db=require('better-sqlite3')('store/messages.db');console.table(db.prepare(\"SELECT timestamp,substr(content,1,80) AS preview FROM messages WHERE chat_jid='watch:scott' ORDER BY rowid DESC LIMIT 10\").all())"` |
| Token usage by group, last 30 days | `node -e "const db=require('better-sqlite3')('store/messages.db');console.table(db.prepare(\"SELECT group_folder,SUM(input_tokens) AS input,SUM(output_tokens) AS output,COUNT(*) AS runs FROM token_usage WHERE run_at>=date('now','-30 days') GROUP BY group_folder ORDER BY (input+output) DESC\").all())"` |
| Daily token totals, last 7 days | `node -e "const db=require('better-sqlite3')('store/messages.db');console.table(db.prepare(\"SELECT date(run_at) AS day,SUM(input_tokens) AS input,SUM(output_tokens) AS output FROM token_usage WHERE run_at>=date('now','-7 days') GROUP BY day ORDER BY day DESC\").all())"` |

(All Node commands assume you're in `~/NanoClaw/`. `cd ~/NanoClaw` first if you're elsewhere.)

---

## Quad-inbox (Jorgenclaw → Quad task handoff)

| What you want to do | Command |
|---|---|
| List pending tasks Jorgenclaw left for me | `ls ~/NanoClaw/groups/main/quad-inbox/` |
| Read a specific task | `cat ~/NanoClaw/groups/main/quad-inbox/<filename>.md` |
| Have Quad process them all | `/quad-inbox` (slash command) |
| Triage view (without executing) | `/quad-inbox-status` (slash command) |

---

## Memory & state

| What you want to do | Command |
|---|---|
| View Jorgenclaw's ongoing-projects memory | `less ~/NanoClaw/groups/main/memory/ongoing.md` |
| View Jorgenclaw's contacts memory | `less ~/NanoClaw/groups/main/memory/contacts.md` |
| View Quad's auto-memory index | `less ~/.claude/projects/-home-jorgenclaw-NanoClaw/memory/MEMORY.md` |
| Clear all sessions for a group (forces fresh agent context) | `node -e "require('better-sqlite3')('store/messages.db').prepare('DELETE FROM sessions WHERE group_folder=?').run('GROUP_NAME')" && systemctl --user restart nanoclaw` |

---

## Backup

| What you want to do | Command |
|---|---|
| Run a backup right now (don't wait for nightly cron) | `~/NanoClaw/scripts/backup.sh` |
| Check the most recent backup ran cleanly | `tail -20 ~/NanoClaw/logs/backup.log` |
| Confirm USB drive is mounted | `mountpoint -q /media/jorgenclaw/NanoClaw && echo OK` |
| List backups on the USB drive | `ls -lh /media/jorgenclaw/NanoClaw/backups/ \| tail -10` |

---

## Build / development

| What you want to do | Command |
|---|---|
| Compile NanoClaw TypeScript after editing `src/` | `cd ~/NanoClaw && npm run build` |
| Run tests | `cd ~/NanoClaw && npm test` |
| Run with hot reload (alternative to systemd service) | `cd ~/NanoClaw && npm run dev` |
| Reset signal-cli daemon connection | `systemctl --user restart signal-cli && sleep 2 && systemctl --user restart nanoclaw` |

---

## Network diagnostics

| What you want to do | Command |
|---|---|
| Find this machine's LAN IP | `hostname -I \| awk '{print $1}'` |
| Test that the watch HTTP endpoint is reachable | `curl -i http://localhost:3000/api/watch/poll` |
| Test from another device on the same WiFi | `curl -i http://<this-machine-ip>:3000/api/watch/poll` |
| List open firewall ports | `sudo ufw status numbered` |

---

## When things go sideways

| Symptom | First thing to try |
|---|---|
| NanoClaw won't start | `journalctl --user -u nanoclaw -n 50` to see the crash reason |
| Watch posts succeed but no reply visible | Check `WATCH_SYNC_TIMEOUT_MS` in `.env` (should be ≥ 30000), then `grep 'sync reply timeout' ~/NanoClaw/logs/nanoclaw.log` |
| Signal messages stop arriving | `systemctl --user restart signal-cli && systemctl --user restart nanoclaw` |
| White Noise group "not found" after reboot | The MLS keyring is wiped on reboot — see `docs/whitenoise-setup.md` reboot recovery section |
| Watch button doesn't respond at all | Reflash: `cd ~/projects/nanoclaw-watch && pio run --target upload`. If still dead, hold side button while plugging USB |
| Want to see exactly what Quad knows | `cat ~/.claude/projects/-home-jorgenclaw-NanoClaw/memory/MEMORY.md` |

---

*Keep adding to this as you discover commands worth remembering. If you run something three times and it feels useful, it belongs here.*

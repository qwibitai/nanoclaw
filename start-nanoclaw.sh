#!/bin/bash
# start-nanoclaw.sh — delegates to systemd (use systemctl directly for full control)
# To stop:   systemctl --user stop nanoclaw
# To restart: systemctl --user restart nanoclaw
# Logs:      journalctl --user -u nanoclaw -f

exec systemctl --user start nanoclaw

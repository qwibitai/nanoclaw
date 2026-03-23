---
type: tip
title: "Setting Up Codex on a Digital Ocean VPS"
tags: [codex, deployment, digital-ocean, ubuntu, setup]
related: []
created: 2026-02-22
source: knowledge-warehouse
score: 0
last_reviewed: null
---

Goal: Install Codex CLI on a barebones Ubuntu 22.04/24.04 droplet and authenticate with device code.

Important: Device-code auth must be enabled in your ChatGPT account security settings (or workspace permissions for Business/Edu/Enterprise).

Notes:
- Assumes you have sudo
- You will open the device-code URL in your local browser and enter the one-time code

```bash
set -euo pipefail

# Base packages
sudo apt-get update
sudo apt-get install -y ca-certificates curl git unzip

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify Node
node -v
npm -v

# Install Codex CLI
sudo npm install -g @openai/codex

# Verify Codex
codex --version

# Authenticate with device code
codex login --device-auth

# Quick smoke test
mkdir -p ~/codex-test
cd ~/codex-test
codex --help
```

If login fails on a headless server, it is often because device-code auth is disabled at the workspace level.

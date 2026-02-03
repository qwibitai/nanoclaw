---
name: debug
description: Debug Firecracker microVM agent issues. Use when things aren't working, VMs fail to boot, authentication problems, SSH issues, or to understand how the VM system works. Covers logs, networking, mounts, and common issues.
---

# NanoClaw Firecracker VM Debugging

This guide covers debugging the Firecracker microVM agent execution system.

## Architecture Overview

```
Host (Ubuntu Server 24.04)                  Firecracker microVM (own kernel)
─────────────────────────────────────────────────────────────────────────────
src/firecracker-runner.ts                    /home/agent/run-task.sh
    │                                             │
    │ spawns Firecracker VM                       │ runs Claude Code CLI
    │ injects files into rootfs                   │ --print --dangerously-skip-permissions
    │ executes task via SSH                       │
    │                                             │
    ├── groups/{folder} ──────copy──────> /workspace/group
    ├── groups/global ────────copy──────> /workspace/global (non-main, ro)
    ├── data/sessions/{folder}/.claude/ ──> /home/agent/.claude/ (per-group)
    ├── .env (VERCEL_AI_GATEWAY_KEY) ───> /home/agent/.vercel-ai-gateway-key
    └── (main only) project root ───────> /mnt/project
```

**Important:** Files are **copied** into the VM rootfs before boot, not live-mounted. Changes are synced back via SCP after task completion.

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | `logs/nanoclaw.log` | Host-side WhatsApp, routing, VM spawning |
| **Main app errors** | `logs/nanoclaw.error.log` | Host-side errors |
| **VM run logs** | `groups/{folder}/logs/firecracker-*.log` | Per-run: input, mounts, output, exit code |

## Enabling Debug Logging

```bash
LOG_LEVEL=debug npm run dev
```

Debug level shows:
- Full mount configurations
- VM boot timing
- SSH connection attempts
- Firecracker API calls

## Common Issues

### 1. VM Fails to Boot

**Check /dev/kvm access:**
```bash
ls -la /dev/kvm
# Should show crw-rw---- with kvm group
groups | grep kvm
# Your user should be in the kvm group
```

**Fix:** `sudo usermod -aG kvm $USER` then log out and back in.

**Check Firecracker binary:**
```bash
/usr/local/bin/firecracker --version
```

**Check kernel and rootfs:**
```bash
ls -la /opt/firecracker/vmlinux.bin /opt/firecracker/agent-rootfs.ext4
```

If rootfs is missing: `npm run build-rootfs`

### 2. SSH Connection Timeout

The VM boots but SSH doesn't become available within 30 seconds.

**Check network bridge:**
```bash
ip link show fcbr0
ip addr show fcbr0
# Should show 172.16.0.1/24
```

If bridge is missing: `npm run setup-network`

**Check IP forwarding:**
```bash
sysctl net.ipv4.ip_forward
# Should be 1
```

**Check NAT rules:**
```bash
sudo iptables -t nat -L POSTROUTING | grep MASQUERADE
sudo iptables -L FORWARD | grep fcbr0
```

**Test VM networking manually:**
If a VM is running, try:
```bash
ping -c 1 172.16.0.2  # First VM IP
ssh -i ~/.ssh/nanoclaw_agent -o StrictHostKeyChecking=no agent@172.16.0.2 'echo hello'
```

### 3. Claude Code Authentication Fails

**Check Vercel AI Gateway key:**
```bash
grep VERCEL_AI_GATEWAY_KEY .env
# Should show your key
```

**Test connectivity from a running VM:**
If you have SSH access to a VM:
```bash
ssh -i ~/.ssh/nanoclaw_agent agent@172.16.0.2 'curl -s https://ai-gateway.vercel.sh'
```

**Check Claude credentials directory:**
```bash
ls -la data/sessions/main/.claude/
```

### 4. Files Not Syncing Back

After task completion, changed files should be SCP'd back to the host.

**Check VM run logs:**
```bash
cat groups/main/logs/firecracker-*.log | tail -20
# Look for "Synced" or "Failed to sync" messages
```

**Read-only mounts** won't sync back by design. Check if the mount is configured as readonly.

### 5. Leftover VM Processes

```bash
ps aux | grep firecracker
# Should show nothing if all VMs are cleaned up

# Check for leftover TAP devices
ip link show | grep tap
# Should show nothing if all VMs are cleaned up

# Check for leftover rootfs images
ls /tmp/nanoclaw-vm-*.ext4 2>/dev/null
ls /tmp/nanoclaw-fc-*.socket 2>/dev/null
```

**Manual cleanup:**
```bash
# Kill all firecracker processes
sudo pkill -9 firecracker

# Remove all nanoclaw TAP devices
for tap in $(ip link show | grep -o 'tap[0-9]*'); do
    sudo ip link delete $tap
done

# Remove temp files
rm -f /tmp/nanoclaw-vm-*.ext4 /tmp/nanoclaw-fc-*.socket
```

### 6. Session Not Resuming

Sessions are stored at `data/sessions/{group}/.claude/` and copied into the VM rootfs.

**Check session directory:**
```bash
ls -la data/sessions/main/.claude/
```

**Check sessions.json:**
```bash
cat data/sessions.json
```

**Clear sessions:**
```bash
rm -rf data/sessions/
echo '{}' > data/sessions.json
```

## Quick Diagnostic Script

```bash
echo "=== NanoClaw Firecracker Diagnostics ==="

echo -e "\n1. /dev/kvm accessible?"
[ -r /dev/kvm ] && [ -w /dev/kvm ] && echo "OK" || echo "FAIL - add user to kvm group"

echo -e "\n2. Firecracker binary?"
[ -x /usr/local/bin/firecracker ] && echo "OK" || echo "MISSING"

echo -e "\n3. Kernel image?"
[ -f /opt/firecracker/vmlinux.bin ] && echo "OK" || echo "MISSING"

echo -e "\n4. Agent rootfs?"
[ -f /opt/firecracker/agent-rootfs.ext4 ] && echo "OK ($(du -h /opt/firecracker/agent-rootfs.ext4 | cut -f1))" || echo "MISSING - run npm run build-rootfs"

echo -e "\n5. Network bridge?"
ip link show fcbr0 &>/dev/null && echo "OK" || echo "MISSING - run npm run setup-network"

echo -e "\n6. SSH keypair?"
[ -f ~/.ssh/nanoclaw_agent ] && echo "OK" || echo "MISSING - will be auto-generated on first run"

echo -e "\n7. Environment configured?"
[ -f .env ] && (grep -q "VERCEL_AI_GATEWAY_KEY\|ANTHROPIC_API_KEY" .env && echo "OK" || echo "MISSING credentials in .env") || echo "MISSING .env file"

echo -e "\n8. Active VMs?"
ps aux | grep '[f]irecracker' | wc -l | xargs echo "Running:"

echo -e "\n9. TAP devices?"
ip link show 2>/dev/null | grep -c 'tap[0-9]' | xargs echo "Active:"

echo -e "\n10. Recent VM logs?"
ls -t groups/*/logs/firecracker-*.log 2>/dev/null | head -3 || echo "No VM logs yet"
```

## Rebuilding

```bash
# Rebuild TypeScript
npm run build

# Rebuild agent rootfs (if Claude Code or base system needs updating)
npm run build-rootfs

# Reconfigure networking (if bridge was lost after reboot)
npm run setup-network

# Restart service
sudo systemctl restart nanoclaw
```

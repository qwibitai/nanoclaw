# NanoClaw Troubleshooting Guide

This guide covers common issues and their solutions when running NanoClaw.

## Container Agent Issues

### Container agent hangs after "Session initialized" (Oracle Cloud / restrictive iptables)

**Symptoms:**
- Discord/WhatsApp/Telegram message is received and stored
- Container agent is spawned
- Agent log shows `Session initialized: <uuid>` then nothing
- No explicit error message anywhere

**Root Cause:**
On Oracle Cloud Linux VMs (and potentially other cloud providers with restrictive default iptables rules), the container agent fails to reach the credential proxy on port 3001. Oracle Cloud's default iptables INPUT chain ends with a blanket REJECT rule that blocks traffic from the Docker bridge subnet to the host.

**Verification:**
```bash
# From the host (works - loopback is allowed)
curl localhost:3001

# From inside the container (fails)
docker run --rm curlimages/curl http://host.docker.internal:3001
```

**Solution:**

Allow Docker bridge traffic to port 3001:

```bash
# Add iptables rule to allow Docker bridge traffic
sudo iptables -I INPUT 5 -s 172.16.0.0/12 -p tcp --dport 3001 -j ACCEPT

# Persist across reboots (method depends on distribution)
# For Oracle Cloud / RHEL / CentOS:
sudo iptables-save > /etc/iptables.rules

# Add to /etc/rc.local or create a systemd service to restore on boot
echo "iptables-restore < /etc/iptables.rules" | sudo tee -a /etc/rc.local
sudo chmod +x /etc/rc.local
```

**Alternative - Use host networking (Linux only):**

If you don't need container network isolation, you can use host networking:

```bash
# In your config, set container network mode to host
# This bypasses Docker bridge entirely
```

**Note:** The Docker bridge subnet is typically `172.16.0.0/12`, but you can verify yours with:
```bash
docker network inspect bridge --format='{{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

---

## See Also

- [DEBUG_CHECKLIST.md](./DEBUG_CHECKLIST.md) - Comprehensive debugging steps
- [SECURITY.md](./SECURITY.md) - Security model and boundaries
- [SDK_DEEP_DIVE.md](./SDK_DEEP_DIVE.md) - Technical implementation details

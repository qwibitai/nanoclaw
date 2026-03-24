#!/bin/bash
# Setup persistent networking for Apple Container on macOS 26
# Run with sudo: sudo bash nanoclaw/scripts/setup-container-networking.sh

set -e

# Detect active internet interface
IFACE=$(route get 8.8.8.8 2>/dev/null | grep interface | awk '{print $2}')
if [ -z "$IFACE" ]; then
  echo "ERROR: Could not detect active network interface"
  exit 1
fi
echo "Detected network interface: $IFACE"

# 1. Enable IP forwarding (immediate)
sysctl -w net.inet.ip.forwarding=1

# 2. Make IP forwarding persistent across reboots
if ! grep -q "net.inet.ip.forwarding=1" /etc/sysctl.conf 2>/dev/null; then
  echo "net.inet.ip.forwarding=1" >> /etc/sysctl.conf
  echo "Added IP forwarding to /etc/sysctl.conf"
else
  echo "IP forwarding already in /etc/sysctl.conf"
fi

# 3. Add NAT rule for Apple Container's vmnet subnet
NAT_RULE="nat on $IFACE from 192.168.64.0/24 to any -> ($IFACE)"

# Check if already in pf.conf
if ! grep -q "192.168.64.0/24" /etc/pf.conf 2>/dev/null; then
  # Add NAT rule at the beginning of pf.conf (before other rules)
  cp /etc/pf.conf /etc/pf.conf.bak.$(date +%Y%m%d)
  echo "$NAT_RULE" | cat - /etc/pf.conf > /tmp/pf.conf.new
  mv /tmp/pf.conf.new /etc/pf.conf
  echo "Added NAT rule to /etc/pf.conf"
else
  echo "NAT rule already in /etc/pf.conf"
fi

# 4. Load the updated rules
pfctl -f /etc/pf.conf 2>&1 || true
pfctl -e 2>&1 || true

echo ""
echo "=== Verification ==="
echo "IP forwarding: $(sysctl net.inet.ip.forwarding)"
echo "NAT interface: $IFACE"
echo "pfctl rules loaded"
echo ""
echo "Done! Test with:"
echo "  container run --rm --entrypoint curl nanoclaw-agent:latest \\"
echo "    -s4 --connect-timeout 5 -o /dev/null -w '%{http_code}' https://api.anthropic.com"
echo "  # Expected: 404"

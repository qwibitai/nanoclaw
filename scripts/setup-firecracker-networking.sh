#!/bin/bash
# setup-firecracker-networking.sh — Sets up Firecracker networking (run once on host)
#
# Creates the fcbr0 bridge, enables IP forwarding, and configures NAT
# so microVMs can reach the internet.
#
# Usage: bash scripts/setup-firecracker-networking.sh

set -e

BRIDGE=fcbr0
BRIDGE_IP=172.16.0.1
MASK=24

echo "=== NanoClaw Firecracker Networking Setup ==="

# Check if bridge already exists
if ip link show $BRIDGE &>/dev/null; then
    echo "Bridge $BRIDGE already exists, skipping creation."
else
    echo "Creating bridge $BRIDGE..."
    sudo ip link add name $BRIDGE type bridge
    sudo ip addr add ${BRIDGE_IP}/${MASK} dev $BRIDGE
    sudo ip link set $BRIDGE up
    echo "Bridge $BRIDGE created at ${BRIDGE_IP}/${MASK}"
fi

# Enable IP forwarding
echo "Enabling IP forwarding..."
sudo sysctl -w net.ipv4.ip_forward=1
grep -q "^net.ipv4.ip_forward=1" /etc/sysctl.conf 2>/dev/null || \
    echo "net.ipv4.ip_forward=1" | sudo tee -a /etc/sysctl.conf

# Setup NAT (detect host interface automatically)
HOST_IFACE=$(ip route | grep default | awk '{print $5}' | head -1)
if [ -z "$HOST_IFACE" ]; then
    echo "WARNING: Could not detect default network interface for NAT."
    echo "You may need to configure NAT manually."
else
    echo "Setting up NAT via $HOST_IFACE..."

    sudo iptables -t nat -C POSTROUTING -o $HOST_IFACE -j MASQUERADE 2>/dev/null || \
        sudo iptables -t nat -A POSTROUTING -o $HOST_IFACE -j MASQUERADE

    sudo iptables -C FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \
        sudo iptables -A FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

    sudo iptables -C FORWARD -i $BRIDGE -o $HOST_IFACE -j ACCEPT 2>/dev/null || \
        sudo iptables -A FORWARD -i $BRIDGE -o $HOST_IFACE -j ACCEPT

    echo "NAT configured: $BRIDGE -> $HOST_IFACE"
fi

echo ""
echo "=== Firecracker networking ready ==="
echo "Bridge: $BRIDGE ($BRIDGE_IP/$MASK)"
echo "VMs will use IPs in range 172.16.0.2 - 172.16.0.254"
echo ""
echo "To make iptables rules persistent across reboots:"
echo "  sudo apt install iptables-persistent"
echo "  sudo netfilter-persistent save"

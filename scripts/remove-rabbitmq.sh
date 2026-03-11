#!/bin/bash
# Удаление RabbitMQ с сервера Kamatera Chess (KS-431)
# RabbitMQ не используется в проекте Kingside (подтверждено в KS-430)

set -e

echo "=== RabbitMQ removal from Kamatera Chess ==="
echo "Date: $(date)"
echo ""

echo "=== Stopping RabbitMQ service ==="
sudo systemctl stop rabbitmq-server || echo "Service not running"

echo ""
echo "=== Disabling RabbitMQ autostart ==="
sudo systemctl disable rabbitmq-server || echo "Service not enabled"

echo ""
echo "=== Removing RabbitMQ packages ==="
sudo apt-get remove --purge -y rabbitmq-server erlang-* || echo "Packages not found"
sudo apt-get autoremove -y

echo ""
echo "=== Cleaning RabbitMQ data and configs ==="
sudo rm -rf /var/lib/rabbitmq
sudo rm -rf /etc/rabbitmq
sudo rm -rf /var/log/rabbitmq

echo ""
echo "=== Removing RabbitMQ APT repo (if exists) ==="
sudo rm -f /etc/apt/sources.list.d/rabbitmq*.list
sudo rm -f /etc/apt/sources.list.d/erlang*.list
sudo apt-get update -q

echo ""
echo "=== Verifying removal ==="
if systemctl list-units --type=service | grep -q rabbitmq; then
    echo "WARNING: RabbitMQ service still present"
else
    echo "OK: RabbitMQ service not found"
fi

if dpkg -l | grep -q rabbitmq; then
    echo "WARNING: RabbitMQ package still installed"
else
    echo "OK: RabbitMQ package removed"
fi

echo ""
echo "=== Memory freed — check with: free -h ==="
free -h

echo ""
echo "=== Done ==="

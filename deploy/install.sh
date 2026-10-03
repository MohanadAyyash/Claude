#!/usr/bin/env bash
# One-shot installer for a fresh Ubuntu 22.04/24.04 server.  Run as root from the project folder:
#   sudo bash deploy/install.sh erp.yourdomain.com
set -euo pipefail
DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || { echo "usage: sudo bash deploy/install.sh erp.yourdomain.com"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
cd "$(dirname "$0")"

echo "==> Checking that $DOMAIN points to this server"
SERVER_IP=$(curl -fsS https://api.ipify.org || true); DNS_IP=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
if [ -n "$SERVER_IP" ] && [ "$SERVER_IP" != "$DNS_IP" ]; then
  echo "!! $DOMAIN resolves to '${DNS_IP:-nothing}' but this server is $SERVER_IP."
  echo "   Add a DNS 'A' record  $DOMAIN -> $SERVER_IP , wait a few minutes, then run this again."; exit 1
fi

echo "==> Installing Docker"
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

echo "==> Firewall (SSH, HTTP, HTTPS only)"
if command -v ufw >/dev/null; then ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null; fi

echo "==> Configuration"
if [ ! -f .env ]; then
  TOKEN=$(openssl rand -hex 16)
  printf 'DOMAIN=%s\nSETUP_TOKEN=%s\n' "$DOMAIN" "$TOKEN" > .env; chmod 600 .env
else
  sed -i "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" .env
fi

echo "==> Building and starting"
docker compose up -d --build

echo "==> Daily backup at 02:30 (kept 30 days in the data volume)"
CRON="30 2 * * * cd $(pwd) && docker compose exec -T app node scripts/backup.js >> /var/log/erp-backup.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'scripts/backup.js' ; echo "$CRON" ) | crontab -

echo
echo "=============================================================="
echo " Done.  Open:  https://$DOMAIN   (the certificate may take ~1 minute)"
echo " First-time setup token (needed once to create the admin account):"
grep '^SETUP_TOKEN=' .env | cut -d= -f2
echo " Keep a copy of the token; it is also stored in $(pwd)/.env"
echo "=============================================================="

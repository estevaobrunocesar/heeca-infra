#!/usr/bin/env bash
# Watchdog de disco do heeca-prod — roda a cada 5 min, só age se o disco passar de 80%.
# Complementa a limpeza cheia de hora em hora (docker-prune.sh): em dias com vários produtos
# publicando quase ao mesmo tempo, builds concorrentes já encheram 35 GB de cache do BuildKit
# em menos de 1 h entre execuções do cron horário (28/09/2026) — o watchdog reage bem mais rápido.
#   instalar:  bash infra/disk-watchdog.sh install
#   rodar:     bash infra/disk-watchdog.sh            (no servidor)
set -euo pipefail
LIMIAR=80

if [ "${1:-}" = "install" ]; then
  ssh heeca-prod 'sudo tee /usr/local/bin/heeca-disk-watchdog >/dev/null && sudo chmod +x /usr/local/bin/heeca-disk-watchdog && printf "%s\n" "SHELL=/bin/bash" "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" "*/5 * * * * root /usr/local/bin/heeca-disk-watchdog >> /var/log/heeca-disk-watchdog.log 2>&1" | sudo tee /etc/cron.d/heeca-disk-watchdog >/dev/null && sudo chmod 644 /etc/cron.d/heeca-disk-watchdog && echo instalado' < "$0"
  exit 0
fi

USO=$(df / | awk 'NR==2{gsub("%","",$5); print $5}')
if [ "$USO" -lt "$LIMIAR" ]; then
  exit 0
fi
echo "[$(date -Is)] disco em ${USO}% (limiar ${LIMIAR}%) — limpando agora"
echo "[$(date -Is)] antes: $(df -h / | awk 'NR==2{print $3" usados, "$4" livres ("$5")"}')"
docker image prune -af | tail -1
docker builder prune -af | tail -1
docker container prune -f --filter "until=1h" | tail -1
echo "[$(date -Is)] depois: $(df -h / | awk 'NR==2{print $3" usados, "$4" livres ("$5")"}')"

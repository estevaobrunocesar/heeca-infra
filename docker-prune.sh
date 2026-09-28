#!/usr/bin/env bash
# Limpeza de hora em hora do Docker no servidor heeca-prod (Coolify guarda uma imagem de ~1,4 GB por commit de cada app;
# com 10+ produtos no mesmo disco de 75 GB, o disco encheu em 19/09/2026 e os deploys viraram "zumbis").
#   instalar:  bash infra/docker-prune.sh install   (copia para /usr/local/bin e cria /etc/cron.d/heeca-docker-prune)
#   rodar:     bash infra/docker-prune.sh            (no servidor)
# Mantém só as imagens dos containers em execução; cache de build zerado por completo a cada rodada.
set -euo pipefail
if [ "${1:-}" = "install" ]; then
  ssh heeca-prod 'sudo tee /usr/local/bin/heeca-docker-prune >/dev/null && sudo chmod +x /usr/local/bin/heeca-docker-prune && printf "%s\n" "SHELL=/bin/bash" "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" "17 * * * * root /usr/local/bin/heeca-docker-prune >> /var/log/heeca-docker-prune.log 2>&1" | sudo tee /etc/cron.d/heeca-docker-prune >/dev/null && sudo chmod 644 /etc/cron.d/heeca-docker-prune && echo instalado' < "$0"
  exit 0
fi
echo "[$(date -Is)] antes: $(df -h / | awk 'NR==2{print $3" usados, "$4" livres ("$5")"}')"
# Imagens: Coolify guarda uma por commit (~1,4 GB) só para rollback; rollback refaz o build, então limpamos todas as sem uso.
docker image prune -af | tail -1
# Cache de build: achado em 23/09 — "--max-used-space=8GB" existe na CLI mas não teve efeito nesta versão
# (rodou sem erro, reclamou 0B com 53 GB acumulados). Sem a flag, -af zera o cache inteiro sempre: mais
# rebuild do zero em troca de nunca mais o disco encher batendo numa flag que não funciona.
docker builder prune -af | tail -1
docker container prune -f --filter "until=72h" | tail -1
echo "[$(date -Is)] depois: $(df -h / | awk 'NR==2{print $3" usados, "$4" livres ("$5")"}')"

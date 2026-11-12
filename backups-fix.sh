#!/usr/bin/env bash
# Roda NO SERVIDOR heeca-prod (copiado para /tmp junto com backups-tinker.php).
#   bash /tmp/backups-fix.sh                 -> corrige/garante o backup diário de todo Postgres (nome certo do banco)
#   BACKUP_NOW=1 bash /tmp/backups-fix.sh    -> idem, e dispara um backup agora (valida de ponta a ponta sem esperar 03:00 UTC)
# Só mexe na configuração de backup do Coolify e no agendador; não toca nos dados dos produtos.
set -euo pipefail
docker cp /tmp/backups-tinker.php coolify:/tmp/backups-tinker.php
docker exec -e BACKUP_NOW="${BACKUP_NOW:-}" coolify php artisan tinker --execute='include "/tmp/backups-tinker.php";'

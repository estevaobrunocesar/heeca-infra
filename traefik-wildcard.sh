#!/usr/bin/env bash
# Wildcard *.ticket.heeca.com.br no Traefik do Coolify (DNS-01 via Cloudflare).
#
#   bash infra/traefik-wildcard.sh plan     # mostra o que vai fazer, sem tocar no servidor
#   bash infra/traefik-wildcard.sh apply    # aplica e REINICIA o coolify-proxy (5–15 s fora p/ todos os apps do host)
#   bash infra/traefik-wildcard.sh verify   # confere certificado e roteamento
#
# Idempotente: cada passo verifica antes de alterar. Precisa de: ssh com a chave abaixo,
# CLOUDFLARE_API_TOKEN (ou CF_TRAEFIK_TOKEN, preferível: token dedicado) em infra/.env.
#
# O que faz no servidor (/data/coolify/proxy):
#   1. cf-heeca.env (modo 600) com CF_DNS_API_TOKEN=<token>  — lido pelo Traefik para o desafio DNS-01
#   2. docker-compose.yml: env_file + resolver `letsencrypt-dns` (provider cloudflare, storage acme-dns.json)
#   3. dynamic/heeca-ticket-wildcard.yaml: roteador HostRegexp(*.ticket.heeca.com.br) → serviço do app
#      heeca-ticket já registrado pelo Coolify (https-0-<uuid>@docker), com certificado wildcard
#   4. docker compose up -d (recria o proxy com o resolver novo)
# Backup do compose em docker-compose.yml.bak-<timestamp>. Para voltar: restaurar o backup e `up -d`.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
set -a; source "$HERE/.env"; set +a
TOKEN="${CF_TRAEFIK_TOKEN:-${CLOUDFLARE_API_TOKEN:?defina CLOUDFLARE_API_TOKEN ou CF_TRAEFIK_TOKEN em infra/.env}}"
HOST="root@${SERVER_IP:-5.161.233.128}"
KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_credfusion_auto}"
SSH=(ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=20 "$HOST")

APP_UUID="jdxtjfpdvcl5mg9b1mub8b3e"            # heeca-ticket no Coolify
DOMAIN="ticket.heeca.com.br"
PROXY_DIR="/data/coolify/proxy"

# Roteador por arquivo dinâmico: não mexe nos labels que o Coolify gera para o app.
read -r -d '' DYNAMIC <<EOF || true
# Gerado por infra/traefik-wildcard.sh — portais white-label do Heeca Ticket ({slug}.$DOMAIN)
http:
  routers:
    heeca-ticket-wildcard-http:
      rule: "HostRegexp(\`^.+\\\\.${DOMAIN//./\\\\.}$\`)"
      entryPoints: [http]
      middlewares: [redirect-to-https@file]
      service: "https-0-${APP_UUID}@docker"
    heeca-ticket-wildcard:
      rule: "HostRegexp(\`^.+\\\\.${DOMAIN//./\\\\.}$\`)"
      entryPoints: [https]
      middlewares: [gzip@docker]
      service: "https-0-${APP_UUID}@docker"
      tls:
        certResolver: letsencrypt-dns
        domains:
          - main: "$DOMAIN"
            sans: ["*.$DOMAIN"]
EOF

# Script remoto (recebe o token por stdin, nunca por argumento/linha de comando)
read -r -d '' REMOTE <<'EOF' || true
set -euo pipefail
MODE="$1"; PROXY_DIR="$2"; DYNAMIC_B64="$3"
cd "$PROXY_DIR"
say() { printf '  %s\n' "$*"; }

# 1. token
if [ "$MODE" = apply ]; then
  umask 077; cat > cf-heeca.env; say "cf-heeca.env gravado (modo 600)"
else
  [ -s cf-heeca.env ] && say "cf-heeca.env já existe" || say "cf-heeca.env será criado"; cat >/dev/null
fi

# 2. compose
if grep -q "letsencrypt-dns" docker-compose.yml; then
  say "compose já tem o resolver letsencrypt-dns"
else
  say "compose: adicionar env_file + resolver letsencrypt-dns"
  if [ "$MODE" = apply ]; then
    cp docker-compose.yml "docker-compose.yml.bak-$(date +%Y%m%d%H%M%S)"
    touch acme-dns.json; chmod 600 acme-dns.json
    grep -q "cf-heeca.env" docker-compose.yml || sed -i "/^    image: .traefik:v3/a\\    env_file:\\n      - $PROXY_DIR/cf-heeca.env" docker-compose.yml
    sed -i "/--certificatesresolvers.letsencrypt.acme.storage=\/traefik\/acme.json/a\\      - '--certificatesresolvers.letsencrypt-dns.acme.dnschallenge=true'\\n      - '--certificatesresolvers.letsencrypt-dns.acme.dnschallenge.provider=cloudflare'\\n      - '--certificatesresolvers.letsencrypt-dns.acme.dnschallenge.resolvers=1.1.1.1:53,1.0.0.1:53'\\n      - '--certificatesresolvers.letsencrypt-dns.acme.storage=/traefik/acme-dns.json'" docker-compose.yml
    docker compose -f docker-compose.yml config >/dev/null && say "compose válido"
  fi
fi

# 3. roteador dinâmico
if [ "$MODE" = apply ]; then
  echo "$DYNAMIC_B64" | base64 -d > dynamic/heeca-ticket-wildcard.yaml; say "dynamic/heeca-ticket-wildcard.yaml gravado"
else
  [ -f dynamic/heeca-ticket-wildcard.yaml ] && say "dynamic/heeca-ticket-wildcard.yaml já existe" || say "dynamic/heeca-ticket-wildcard.yaml será criado"
fi

# 4. restart
if [ "$MODE" = apply ]; then
  say "reiniciando coolify-proxy…"
  docker compose -f docker-compose.yml up -d 2>&1 | tail -2
  sleep 6
  docker ps --filter name=coolify-proxy --format '  proxy: {{.Status}}'
  docker logs --since 2m coolify-proxy 2>&1 | grep -i -E "error|letsencrypt-dns|acme" | tail -8 || true
fi
EOF

case "${1:-plan}" in
  plan|apply)
    echo "== traefik-wildcard ${1} em $HOST"
    # 1) script remoto vai para um arquivo temporário; 2) roda com o token no stdin (nunca na linha de comando)
    "${SSH[@]}" "cat > /tmp/traefik-wildcard-remote.sh" <<<"$REMOTE"
    printf 'CF_DNS_API_TOKEN=%s\n' "$TOKEN" | "${SSH[@]}" "bash /tmp/traefik-wildcard-remote.sh $1 $PROXY_DIR $(printf '%s' "$DYNAMIC" | base64 -w0); rm -f /tmp/traefik-wildcard-remote.sh"
    ;;
  verify)
    echo "== certificado de teste.$DOMAIN"
    echo | openssl s_client -servername "teste.$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -issuer -ext subjectAltName | sed 's/^/  /'
    echo "== resposta HTTP"
    curl -s -o /dev/null -w '  https://teste.%s → %s (%s)\n' "$DOMAIN" "$(curl -s -o /dev/null -w '%{http_code}' "https://teste.$DOMAIN/")" "$(curl -s -o /dev/null -w '%{ssl_verify_result}' "https://teste.$DOMAIN/" | sed 's/^0$/TLS ok/')"
    ;;
  *) echo "uso: $0 plan|apply|verify"; exit 1 ;;
esac

#!/bin/sh
# Instala/atualiza o agente de métricas no servidor (container heeca-metrics na rede interna "coolify").
#   uso (do seu PC): scp infra/metrics/agent.mjs heeca-prod:/data/heeca-metrics/agent.mjs && ssh heeca-prod 'METRICS_TOKEN=<token> sh -s' < infra/metrics/install.sh
# Sem porta publicada: só containers da rede coolify (o portal) alcançam http://heeca-metrics:9100/metrics.
set -e
mkdir -p /data/heeca-metrics
docker rm -f heeca-metrics >/dev/null 2>&1 || true
docker run -d --name heeca-metrics --restart unless-stopped --network coolify \
  -e METRICS_TOKEN="$METRICS_TOKEN" -e HOST_ROOT=/host \
  -v /:/host:ro -v /var/run/docker.sock:/var/run/docker.sock:ro -v /data/heeca-metrics/agent.mjs:/app/agent.mjs:ro \
  --memory 128m --cpus 0.25 --label heeca.role=metrics \
  node:24-alpine node /app/agent.mjs
sleep 3
docker logs heeca-metrics 2>&1 | tail -2

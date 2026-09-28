| `bash infra/docker-prune.sh install` | instala no servidor o cron diário de limpeza do Docker (imagens sem uso, cache de build limitado a 8 GB); `bash infra/docker-prune.sh` roda a limpeza à mão no servidor |
# Infra da Heeca

Servidor: Coolify em `coolify.credfusion.com.br` (mesmo host do CredFusion, `5.161.233.128`). DNS na Cloudflare. Código no GitHub (`estevaobrunocesar/heeca-*`), clonado pelo Coolify via GitHub App `credfusion`.

Segredos ficam em `infra/.env` (tokens de API) e `infra/production.env` (segredos gerados para os apps) — os dois ignorados pelo git.

## Scripts

| Script | Faz |
|---|---|
| `node infra/dns.mjs check\|apply` | valida/cria os registros DNS na Cloudflare (`SERVER_IP` no `.env`) |
| `node infra/github.mjs list\|create` | repositórios privados no GitHub |
| `node infra/coolify.mjs inspect` | o que existe no Coolify (servidores, projetos, apps, bancos) |
| `node infra/coolify-setup.mjs plan\|apply [app]\|deploy [app]\|retirar\|status` | projeto Heeca, Postgres, apps, variáveis, deploy (`apply heeca-ink` limita a um app e ao banco dele); `retirar` para e tira o domínio dos apps absorvidos (`RETIRADOS`: nail, lash, brow, cut, skin → Beauty; massage → Wellness) sem apagar nada |
| `bash infra/traefik-wildcard.sh plan|apply|verify` | wildcard `*.ticket.heeca.com.br` no Traefik (DNS-01 Cloudflare) — `apply` **reinicia o coolify-proxy** (5–15 s fora para todos os apps do host) |

Todos são idempotentes: procuram por nome antes de criar.

## Servidor e Coolify

Servidor próprio da Heeca: Hetzner **CPX33** (4 vCPU AMD, 8 GB, 75 GB), Ubuntu 24.04, Ashburn, IP **2.29.52.100**, nome `heeca-prod`.
SSH: `ssh heeca-prod` (alias em `~/.ssh/config`, chave `~/.ssh/id_ed25519_heeca` — exclusiva deste servidor). Coolify 4.3.21 instalado nele, painel em https://coolify.heeca.com.br
(também `http://2.29.52.100:8000`). Registro de novos usuários desativado. GitHub App `heeca` (uuid `ltkzlneeyichmtqfxzhcoavc`, app_id 4983599) — webhook aponta para o IP:8000
enquanto o filtro de rede corporativo (FortiGuard) bloquear `*.heeca.com.br`; trocar para o domínio quando o TI liberar.

**Rede corporativa bloqueia o domínio**: o FortiGuard categoriza `heeca.com.br` como bloqueado. Por isso o `coolify.mjs` aceita `COOLIFY_API_URL` e os scripts falam com o
painel por um túnel SSH: `ssh -N -L 8090:127.0.0.1:8000 heeca-prod` + `COOLIFY_API_URL=http://127.0.0.1:8090` no `.env` (8090 está fora das faixas reservadas do Windows).

O ambiente anterior (Coolify do CredFusion, servidor 5.161.233.128, projeto Heeca com uuids `b9imc876…`/`jdxtjfpd…`/`dukjcgax…`) deve ser **apagado** depois que o novo estiver validado; credenciais em `COOLIFY_OLD_URL/TOKEN`.

## O que existe no Coolify (projeto Heeca `m7sjrgbkhjrhqfpzustl4ivk`, ambiente production)

| Recurso | uuid | Domínio |
|---|---|---|
| heeca-portal-db (Postgres 17) | `teinb811aterkal16vz8kj61` | — |
| heeca-ticket-db | `zijf9dvcd9bq2z2cjjzkca7o` | — |
| heeca-dental-db | `vnitjgrxno9mkeuuzdshner4` | — |
| heeca-beauty-db | `mvnotz9rj9sermmw4yvpivcm` | — |
| heeca-wellness-db | `p6mjht8zchrivyzg1j3i8u8j` | — |
| heeca-portal (repo heeca-portal, Dockerfile) | `9ktsckm1xkkwrxjb9y1gcnhn` | heeca.com.br, www |
| heeca-ticket | `lwh4wic3gp2cdkod9k82drrl` | ticket.heeca.com.br |
| heeca-dental | `458fcyuqdayjy5baizj5zvgj` | dental.heeca.com.br |
| heeca-beauty (repo heeca-beauty = motor Schedule, `MARCA_DEFAULT=beauty`) | `bmrdv9tcvw61iklrzxpa2xsd` | beauty.heeca.com.br + nail/lash/brow/cut/skin (301) |
| heeca-wellness (mesma imagem, `MARCA_DEFAULT=wellness`) | `5stkougjrzbwbp1wtikttcfe` | wellness.heeca.com.br + massage (301) |
| heeca-store-db | `3xrkqf9noembczqyylsk9pep` | — |
| heeca-vendas (multi-tenant; volume `vendas-uploads`) | `wgpmxbuunpkkgaca5ss7dce3` | store.heeca.com.br |

Healthcheck `/api/health` com interval 10 s / 12 tentativas / start 60 s (aplicado pelo `apply`; o padrão do Coolify matava o Next antes de subir).

## Depois do primeiro deploy

1. **Portal → admin → Catálogo → Integração** de cada produto: URL do app, URL de provisionamento (`https://ticket.heeca.com.br/api/heeca`, `https://dental.heeca.com.br/api/heeca`) e o segredo = `TICKET_PLATFORM_SECRET` / `DENTAL_PLATFORM_SECRET` de `production.env`.
2. **Admin do portal**: o seed de produção não cria usuário. Crie a conta em `/criar-conta` e marque `isPlatformAdmin` no banco (`UPDATE "User" SET "isPlatformAdmin" = true WHERE email = '…'`).
3. **Cron** no Coolify (Scheduled Tasks do app heeca-portal): `curl -X POST -H "Authorization: Bearer $PORTAL_JOBS_SECRET" https://heeca.com.br/api/jobs/reconcile` uma vez por dia.
4. **Wildcard `*.ticket.heeca.com.br`** ✅ feito à mão no servidor (não é gerado pelo Coolify — se o painel "resetar" a configuração do proxy, refazer): `/data/coolify/proxy/.env.dns` (600, `CF_DNS_API_TOKEN` = token da Cloudflare), resolver `letsencrypt-dns` (DNS-01, storage `acme-dns.json`) no `docker-compose.yml` do proxy (backup `.bak-*` ao lado), e `dynamic/heeca-ticket-wildcard.yaml` com `HostRegexp` → serviço `https-0-lwh4wic3gp2cdkod9k82drrl@docker` (nome por uuid: sobrevive a redeploys do Ticket; se o app for recriado com outro uuid, trocar aqui). Cert emitido em 18/09/2026, renovação automática.
5. **Arquivos e backups (R2)** ✅ (revisto 19/09, regra "cada produto é individual"): **um bucket e um token por produto** — `heeca-ticket`, `heeca-dental` (privados, `STORAGE_DRIVER=s3`), `heeca-store-public`/`cdn-store.heeca.com.br`, `heeca-cut-public`/`cdn-cut.heeca.com.br` (públicos, `STORAGE_PROVIDER=s3`); chaves `R2_<PRODUTO>_*` em `production.env`, montadas pelo `apply` (que avisa quem ainda está no bucket compartilhado). **Backups**: S3 storage `heeca-backups` (uuid `frpm3a4fxgmgmx6wz8mvsui5`, bucket `heeca-backups`, token exclusivo do Coolify) — TODO Postgres tem backup diário 03:00 UTC, **últimos 7 no R2 (o 8.º apaga o mais antigo), 1 local**; caminho `data/coolify/backups/databases/...`. Bancos novos: rodar `scratchpad/backups.php` no tinker (ou criar o agendamento no painel). Restaurar: Coolify → banco → Backups → Restore, ou `pg_restore` do `.dmp`. Buckets antigos `heccaticket`/`heeca-public` esvaziados — apagar junto com os tokens compartilhados.
6. **Alertas** ✅: monitor externo (acima) + alertas internos do portal (`src/server/ops/alert.ts`, API do Resend, throttle 1/h) em falha de SMTP, `sync_failed` de provisionamento e Asaas 5xx, para `PLATFORM_ADMIN_EMAILS`. `/api/health` do portal expõe `syncFailed` e `reconcileAgeMin` (status `degraded` sem derrubar).
7. Pendências antes de abrir para clientes: Asaas em produção (`ASAAS_ENV=production` + chave/token reais), conta Resend própria da Heeca, publicar Budget, `PRODUCT_NAIL_*` no portal.

## E-mail (Resend)

Conta Resend **própria da Heeca** (desde 18/09; antes era a do CredFusion — `RESEND_API_KEY_CREDFUSION` no `.env` é só histórico, pode apagar). Domínio `heeca.com.br` em sa-east-1. Os apps enviam pelo SMTP do Resend com a mesma chave: `RESEND_API_KEY=re_…` em `production.env` → `coolify-setup.mjs apply` monta `SMTP_URL=smtps://resend:<chave>@smtp.resend.com:2465`, `MAIL_FROM="<produto> <no-reply@heeca.com.br>"` e liga `MAIL_DRIVER=smtp` (Ticket) / `MAIL_PROVIDER=smtp` (Schedule). A chave também vai em `.env` para o `resend.mjs`. Sem chave, os apps ficam em log/console. Remetente único `no-reply@heeca.com.br`; respostas caem no `contato@` se um dia houver caixa (hoje não há MX de recebimento).

## Tokens usados (rotacionar quando terminar a implantação)

Cloudflare (DNS edit), Coolify novo (`5|infra-scripts`, read+write+deploy), GitHub clássico (`repo`, `workflow` — só necessário para `github.mjs`; pode ser revogado), Resend (full access), Asaas (pendente). **Revogar** ao desligar o ambiente antigo: Coolify do CredFusion `15|`, `17|`, `18|` (o `18|` e o GitHub clássico apareceram parcialmente em saídas de comando — trocar).

## Agente de métricas (monitor do admin)

`infra/metrics/agent.mjs` roda no container `heeca-metrics` (node:24-alpine, rede interna `coolify`, sem porta pública, `/` e `docker.sock` somente leitura). Expõe `http://heeca-metrics:9100/metrics` com `Authorization: Bearer METRICS_TOKEN` (gerado pelo `coolify-setup`, em `production.env`; o portal recebe `METRICS_URL`/`METRICS_TOKEN`). Instalar/atualizar: `scp infra/metrics/agent.mjs heeca-prod:/data/heeca-metrics/agent.mjs && ssh heeca-prod "METRICS_TOKEN=<token> sh -s" < infra/metrics/install.sh`. A página `/admin/monitor` do portal lê o agente e o status Worker.

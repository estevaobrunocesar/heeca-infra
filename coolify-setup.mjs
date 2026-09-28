// Provisiona a infra da Heeca no Coolify (idempotente: procura por nome antes de criar).
//   node infra/coolify-setup.mjs plan     → mostra o que faria
//   node infra/coolify-setup.mjs apply    → cria projeto, bancos, apps e variáveis (sem deploy)
//   node infra/coolify-setup.mjs deploy [app]  → dispara o deploy de todos os apps (ou só do app informado, ex.: heeca-beauty)
//   node infra/coolify-setup.mjs retirar       → para e tira o domínio dos apps absorvidos (RETIRADOS); não apaga nada
//   node infra/coolify-setup.mjs status   → estado dos apps e bancos
// Segredos gerados ficam em infra/production.env (ignorado pelo git): são a fonte para
// reconfigurar variáveis e para cadastrar o HEECA_PLATFORM_SECRET de cada produto no portal.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "./coolify.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SECRETS_FILE = join(here, "production.env");

// ---------- segredos persistentes ----------
const secrets = {};
if (existsSync(SECRETS_FILE)) for (const line of readFileSync(SECRETS_FILE, "utf8").split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) secrets[m[1]] = m[2]; }
function secret(key, bytes = 32) {
  if (!secrets[key]) { secrets[key] = randomBytes(bytes).toString("hex"); dirty = true; }
  return secrets[key];
}
let dirty = false;
/** Segredo que vem de fora (não gerado): cadastrado à mão em infra/production.env. */
const external = (key) => secrets[key] ?? "";
// E-mail transacional: os três apps enviam pelo SMTP do Resend com a mesma chave (RESEND_API_KEY em production.env).
// Sem a chave, o portal cai no console, o Ticket em MAIL_DRIVER=log e o Schedule em MAIL_PROVIDER=mock.
// Porta 2465 (TLS implícito) porque a Hetzner bloqueia a 465/25 de saída em contas novas; 587/2587 (STARTTLS) também funcionam.
const SMTP_URL = external("RESEND_API_KEY") ? `smtps://resend:${external("RESEND_API_KEY")}@smtp.resend.com:2465` : "";
const mailEnv = (name) => ({ SMTP_URL, MAIL_FROM: `${name} <no-reply@heeca.com.br>` });
// Ambiente do Asaas derivado da própria chave: as de homologação são "$aact_hmlg_…", as reais não.
// Derivar em vez de manter um segundo interruptor elimina o pior erro da virada — a troca feita pela
// metade, com chave real apontando para o sandbox (ou o inverso, que cobra de verdade quem testava).
// Sem chave nenhuma o provider já cai em "manual", mas o padrão fica em sandbox por segurança.
const ASAAS_ENV = !external("ASAAS_API_KEY") || external("ASAAS_API_KEY").includes("_hmlg_") ? "sandbox" : "production";
// Armazenamento de arquivos: bucket R2 da Cloudflare (API S3). R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET em production.env.
// Sem as quatro, o Ticket fica em STORAGE_DRIVER=local (anexos se perdem no redeploy — só para teste).
// Regra da plataforma (19/09): cada produto é individual — bucket e token PRÓPRIOS por produto.
// Convenção em production.env (por produto, <P> = TICKET, DENTAL, STORE, CUT…):
//   privado: R2_<P>_BUCKET, R2_<P>_ACCESS_KEY_ID, R2_<P>_SECRET_ACCESS_KEY            (token restrito ao bucket)
//   público: R2_<P>_PUBLIC_BUCKET, R2_<P>_PUBLIC_URL, R2_<P>_PUBLIC_ACCESS_KEY_ID, R2_<P>_PUBLIC_SECRET_ACCESS_KEY
// Enquanto o produto não tem credencial própria, cai no bucket compartilhado antigo (R2_* / R2_PUBLIC_*) com
// prefixo — é o estado de transição, e o "apply" avisa quais produtos ainda estão nele.
const compartilhados = [];
const R2 = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"].every((k) => external(k));
const R2PUB = ["R2_PUBLIC_BUCKET", "R2_PUBLIC_URL", "R2_PUBLIC_ACCESS_KEY_ID", "R2_PUBLIC_SECRET_ACCESS_KEY", "R2_ACCOUNT_ID"].every((k) => external(k));
const s3Endpoint = () => `https://${external("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
/** Bucket privado (anexos): driver STORAGE_DRIVER (Ticket/Dental). */
const s3Env = (prefix) => {
  const P = prefix.toUpperCase();
  if (["BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"].every((k) => external(`R2_${P}_${k}`)))
    return { STORAGE_DRIVER: "s3", S3_ENDPOINT: s3Endpoint(), S3_REGION: "auto", S3_BUCKET: external(`R2_${P}_BUCKET`), S3_ACCESS_KEY_ID: external(`R2_${P}_ACCESS_KEY_ID`), S3_SECRET_ACCESS_KEY: external(`R2_${P}_SECRET_ACCESS_KEY`), S3_PREFIX: "" };
  if (!R2) return { STORAGE_DRIVER: "local" };
  compartilhados.push(`${prefix} (privado: ${external("R2_BUCKET")}/${prefix}/)`);
  return { STORAGE_DRIVER: "s3", S3_ENDPOINT: s3Endpoint(), S3_REGION: "auto", S3_BUCKET: external("R2_BUCKET"), S3_ACCESS_KEY_ID: external("R2_ACCESS_KEY_ID"), S3_SECRET_ACCESS_KEY: external("R2_SECRET_ACCESS_KEY"), S3_PREFIX: prefix };
};
/** Bucket público (imagens por URL): provider STORAGE_PROVIDER (Store/Cut/Ink). */
const s3PublicEnv = (prefix) => {
  const P = prefix.toUpperCase();
  if (["PUBLIC_BUCKET", "PUBLIC_URL", "PUBLIC_ACCESS_KEY_ID", "PUBLIC_SECRET_ACCESS_KEY"].every((k) => external(`R2_${P}_${k}`)))
    return { STORAGE_PROVIDER: "s3", S3_ENDPOINT: s3Endpoint(), S3_REGION: "auto", S3_BUCKET: external(`R2_${P}_PUBLIC_BUCKET`), S3_PUBLIC_URL: external(`R2_${P}_PUBLIC_URL`), S3_ACCESS_KEY_ID: external(`R2_${P}_PUBLIC_ACCESS_KEY_ID`), S3_SECRET_ACCESS_KEY: external(`R2_${P}_PUBLIC_SECRET_ACCESS_KEY`), S3_PREFIX: "" };
  if (!R2PUB) return { STORAGE_PROVIDER: "local" };
  compartilhados.push(`${prefix} (público: ${external("R2_PUBLIC_BUCKET")}/${prefix}/)`);
  return { STORAGE_PROVIDER: "s3", S3_ENDPOINT: s3Endpoint(), S3_REGION: "auto", S3_BUCKET: external("R2_PUBLIC_BUCKET"), S3_PUBLIC_URL: external("R2_PUBLIC_URL"), S3_ACCESS_KEY_ID: external("R2_PUBLIC_ACCESS_KEY_ID"), S3_SECRET_ACCESS_KEY: external("R2_PUBLIC_SECRET_ACCESS_KEY"), S3_PREFIX: prefix };
};
function saveSecrets() {
  if (!dirty) return;
  writeFileSync(SECRETS_FILE, Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  dirty = false;
}

// ---------- plano ----------
const PROJECT = { name: "Heeca", description: "Plataforma Heeca - portal, Ticket, Dental, Store, Invoice, Nail, Cut, Beauty, Piercing, Ink, Move e Skin (heeca.com.br)" };
const ENV_NAME = "production";
const GITHUB_APP_UUID = "ltkzlneeyichmtqfxzhcoavc"; // GitHub App "heeca" (Coolify da Heeca; o antigo "credfusion" era pw8y11sr2s2jq7a9osnh82rn)
const OWNER = "estevaobrunocesar";
// Next standalone leva ~20-40 s para responder; com o padrão do Coolify (start 5 s, 10 tentativas) o container era morto antes.
const HEALTH = { health_check_enabled: true, health_check_path: "/api/health", health_check_interval: 10, health_check_retries: 12, health_check_start_period: 60 };

const DBS = [
  { name: "heeca-portal-db", user: "heeca_portal", db: "heeca_portal" },
  { name: "heeca-ticket-db", user: "heeca_ticket", db: "heeca_ticket" },
  { name: "heeca-dental-db", user: "heeca_schedule", db: "heeca_schedule" },
  // Marcas do motor heeca_nail: cada produto é individual — banco próprio por marca (regra da plataforma, 19/09)
  { name: "heeca-notify-db", user: "heeca_notify", db: "heeca_notify" },
  { name: "heeca-store-db", user: "heeca_vendas", db: "heeca_vendas" },
  { name: "heeca-beauty-db", user: "heeca_beauty", db: "heeca_beauty" },
  { name: "heeca-wellness-db", user: "heeca_wellness", db: "heeca_wellness" },
  { name: "heeca-piercing-db", user: "heeca_piercing", db: "heeca_piercing" },
  { name: "heeca-ink-db", user: "heeca_ink", db: "heeca_ink" },
  { name: "heeca-move-db", user: "heeca_move", db: "heeca_move" },
  { name: "heeca-mind-db", user: "heeca_mind", db: "heeca_mind" },
  { name: "heeca-kids-db", user: "heeca_kids", db: "heeca_kids" },
  { name: "heeca-nutri-db", user: "heeca_nutri", db: "heeca_nutri" },
  { name: "heeca-bronze-db", user: "heeca_bronze", db: "heeca_bronze" },
  { name: "heeca-atelier-db", user: "heeca_atelier", db: "heeca_atelier" },
  { name: "heeca-make-db", user: "heeca_make", db: "heeca_make" },
  { name: "heeca-cut-db", user: "heeca_cut", db: "heeca_cut" },
  { name: "heeca-pet-db", user: "heeca_pet", db: "heeca_pet" },
  { name: "heeca-service-db", user: "heeca_service", db: "heeca_service" },
];

/** Variáveis por app. `dbUrl` é preenchida com a URL interna do Postgres do Coolify. */
const APPS = [
  {
    name: "heeca-portal", repo: "heeca-portal", db: "heeca-portal-db", port: "3000",
    domains: "https://heeca.com.br,https://www.heeca.com.br",
    env: (dbUrl) => ({
      NODE_ENV: "production", DATABASE_URL: dbUrl, APP_URL: "https://heeca.com.br", NEXT_PUBLIC_SITE_URL: "https://heeca.com.br",
      SEED_DEMO: "false", MIGRATE_ON_START: "true",
      // Asaas: com ASAAS_API_KEY + ASAAS_WEBHOOK_TOKEN em production.env o provider vira "asaas",
      // e o ambiente sai da PRÓPRIA chave (ASAAS_ENV abaixo) — trocar a chave é a virada inteira.
      BILLING_PROVIDER: external("ASAAS_API_KEY") && external("ASAAS_WEBHOOK_TOKEN") ? "asaas" : "manual",
      ASAAS_ENV, ASAAS_API_KEY: external("ASAAS_API_KEY"), ASAAS_WEBHOOK_TOKEN: external("ASAAS_WEBHOOK_TOKEN"), JOBS_SECRET: secret("PORTAL_JOBS_SECRET"), ...mailEnv("Heeca"),
      JOBS_INPROCESS: "true", JOBS_INTERVAL_MS: "3600000",
      // Integração dos produtos (sincronizada no boot do portal; ver src/server/jobs/bootstrap.ts)
      PRODUCT_TICKET_APP_URL: "https://ticket.heeca.com.br", PRODUCT_TICKET_PROVISION_URL: "https://ticket.heeca.com.br/api/heeca", PRODUCT_TICKET_SECRET: secret("TICKET_PLATFORM_SECRET"),
      PRODUCT_DENTAL_APP_URL: "https://dental.heeca.com.br", PRODUCT_DENTAL_PROVISION_URL: "https://dental.heeca.com.br/api/heeca", PRODUCT_DENTAL_SECRET: secret("DENTAL_PLATFORM_SECRET"),
      // Lash, Massage e Brow: mesma imagem do Nail, mas container, banco e segredo próprios (cada produto é individual)
      PRODUCT_STORE_APP_URL: "https://store.heeca.com.br", PRODUCT_STORE_PROVISION_URL: "https://store.heeca.com.br/api/heeca", PRODUCT_STORE_SECRET: secret("STORE_PLATFORM_SECRET"),
      PRODUCT_BEAUTY_APP_URL: "https://beauty.heeca.com.br", PRODUCT_BEAUTY_PROVISION_URL: "https://beauty.heeca.com.br/api/heeca", PRODUCT_BEAUTY_SECRET: secret("BEAUTY_PLATFORM_SECRET"),
      PRODUCT_WELLNESS_APP_URL: "https://wellness.heeca.com.br", PRODUCT_WELLNESS_PROVISION_URL: "https://wellness.heeca.com.br/api/heeca", PRODUCT_WELLNESS_SECRET: secret("WELLNESS_PLATFORM_SECRET"),
      PRODUCT_PIERCING_APP_URL: "https://piercing.heeca.com.br", PRODUCT_PIERCING_PROVISION_URL: "https://piercing.heeca.com.br/api/heeca", PRODUCT_PIERCING_SECRET: secret("PIERCING_PLATFORM_SECRET"),
      PRODUCT_INK_APP_URL: "https://ink.heeca.com.br", PRODUCT_INK_PROVISION_URL: "https://ink.heeca.com.br/api/heeca", PRODUCT_INK_SECRET: secret("INK_PLATFORM_SECRET"),
      PRODUCT_MOVE_APP_URL: "https://move.heeca.com.br", PRODUCT_MOVE_PROVISION_URL: "https://move.heeca.com.br/api/heeca", PRODUCT_MOVE_SECRET: secret("MOVE_PLATFORM_SECRET"),
      PRODUCT_MIND_APP_URL: "https://mind.heeca.com.br", PRODUCT_MIND_PROVISION_URL: "https://mind.heeca.com.br/api/heeca", PRODUCT_MIND_SECRET: secret("MIND_PLATFORM_SECRET"),
      PRODUCT_NUTRI_APP_URL: "https://nutri.heeca.com.br", PRODUCT_NUTRI_PROVISION_URL: "https://nutri.heeca.com.br/api/heeca", PRODUCT_NUTRI_SECRET: secret("NUTRI_PLATFORM_SECRET"),
      PRODUCT_BRONZE_APP_URL: "https://bronze.heeca.com.br", PRODUCT_BRONZE_PROVISION_URL: "https://bronze.heeca.com.br/api/heeca", PRODUCT_BRONZE_SECRET: secret("BRONZE_PLATFORM_SECRET"),
      PRODUCT_KIDS_APP_URL: "https://kids.heeca.com.br", PRODUCT_KIDS_PROVISION_URL: "https://kids.heeca.com.br/api/heeca", PRODUCT_KIDS_SECRET: secret("KIDS_PLATFORM_SECRET"),
      PRODUCT_ATELIER_APP_URL: "https://atelier.heeca.com.br", PRODUCT_ATELIER_PROVISION_URL: "https://atelier.heeca.com.br/api/heeca", PRODUCT_ATELIER_SECRET: secret("ATELIER_PLATFORM_SECRET"),
      PRODUCT_MAKE_APP_URL: "https://make.heeca.com.br", PRODUCT_MAKE_PROVISION_URL: "https://make.heeca.com.br/api/heeca", PRODUCT_MAKE_SECRET: secret("MAKE_PLATFORM_SECRET"),
      PRODUCT_CUT_APP_URL: "https://cut.heeca.com.br", PRODUCT_CUT_PROVISION_URL: "https://cut.heeca.com.br/api/heeca", PRODUCT_CUT_SECRET: secret("CUT_PLATFORM_SECRET"),
      PRODUCT_PET_APP_URL: "https://pet.heeca.com.br", PRODUCT_PET_PROVISION_URL: "https://pet.heeca.com.br/api/heeca", PRODUCT_PET_SECRET: secret("PET_PLATFORM_SECRET"),
      PRODUCT_SERVICE_APP_URL: "https://service.heeca.com.br", PRODUCT_SERVICE_PROVISION_URL: "https://service.heeca.com.br/api/heeca", PRODUCT_SERVICE_SECRET: secret("SERVICE_PLATFORM_SECRET"),
      // Invoice é um Worker na Cloudflare (heeca_budget/worker); o segredo vai lá por `wrangler secret put`
      PRODUCT_INVOICE_APP_URL: "https://invoice.heeca.com.br", PRODUCT_INVOICE_PROVISION_URL: "https://invoice.heeca.com.br/api/heeca", PRODUCT_INVOICE_SECRET: secret("INVOICE_PLATFORM_SECRET"),
      PLATFORM_ADMIN_EMAILS: "estevaobrunocesar@gmail.com",
      // Alertas operacionais para os admins pela API do Resend (canal separado do SMTP; src/server/ops/alert.ts)
      RESEND_API_KEY: external("RESEND_API_KEY"), ALERT_FROM: "Heeca Ops <no-reply@heeca.com.br>",
      // Monitor do servidor no admin: agente de métricas na rede interna (infra/metrics) + quadro do status Worker
      METRICS_URL: "http://heeca-metrics:9100/metrics", METRICS_TOKEN: secret("METRICS_TOKEN"), STATUS_URL: "https://status.heeca.com.br",
    }),
  },
  {
    name: "heeca-ticket", repo: "heeca-ticket", db: "heeca-ticket-db", port: "3000",
    domains: "https://ticket.heeca.com.br",
    env: (dbUrl) => ({
      NODE_ENV: "production", DATABASE_URL: dbUrl, APP_URL: "https://ticket.heeca.com.br", APP_DOMAIN: "ticket.heeca.com.br",
      PORTAL_ROOT_DOMAIN: "ticket.heeca.com.br", SESSION_SECRET: secret("TICKET_SESSION_SECRET"), MIGRATE_ON_START: "true",
      ...s3Env("ticket"), // um bucket para a plataforma; prefixo por produto
      MAIL_DRIVER: SMTP_URL ? "smtp" : "log", ...mailEnv("Heeca Ticket"),
      JOBS_INPROCESS: "true", JOBS_INTERVAL_MS: "60000", JOBS_SECRET: secret("TICKET_JOBS_SECRET"),
      BILLING_PROVIDER: "manual", AI_PROVIDER: "", AUDIT_RETENTION_DAYS: "365", ERROR_RETENTION_DAYS: "90",
      HEECA_PLATFORM_SECRET: secret("TICKET_PLATFORM_SECRET"), HEECA_PORTAL_URL: "https://heeca.com.br",
    }),
  },
  {
    name: "heeca-dental", repo: "heeca-schedule", db: "heeca-dental-db", port: "3000",
    domains: "https://dental.heeca.com.br",
    env: (dbUrl) => ({
      NODE_ENV: "production", DATABASE_URL: dbUrl, APP_URL: "https://dental.heeca.com.br", SESSION_SECRET: secret("DENTAL_SESSION_SECRET"),
      SEED_DEMO: "false", MIGRATE_ON_START: "true", JOBS_INPROCESS: "true", JOBS_INTERVAL_MS: "60000", JOBS_SECRET: secret("DENTAL_JOBS_SECRET"),
      BILLING_PROVIDER: "manual", MAIL_PROVIDER: SMTP_URL ? "smtp" : "mock", ...mailEnv("Heeca Dental"),
      // WhatsApp pelo Heeca Notify (clínica sem número próprio); NOTIFY_SECRET = NOTIFY_SECRET_DENTAL do Notify
      WHATSAPP_PROVIDER: "notify", NOTIFY_URL: "https://notify.heeca.com.br", NOTIFY_PRODUCT: "dental", NOTIFY_SECRET: secret("NOTIFY_SECRET_DENTAL"),
      ...s3Env("dental"), // fotos/anexos do prontuário no mesmo bucket R2, prefixo por produto
      HEECA_PLATFORM_SECRET: secret("DENTAL_PLATFORM_SECRET"), HEECA_PORTAL_URL: "https://heeca.com.br",
    }),
  },
  {
    // Heeca Mind: saúde mental (repo heeca-mind, ex-hecca_psico). Motor Health/Mind próprio; ENCRYPTION_KEY cifra o prontuário —
    // gerada aqui e guardada só em production.env (perder = perder os dados cifrados). Cron: /api/cron a cada minuto (Scheduled Task no Coolify).
    name: "heeca-mind", repo: "heeca-mind", db: "heeca-mind-db", port: "3000",
    domains: "https://mind.heeca.com.br",
    env: (dbUrl) => ({
      NODE_ENV: "production", DATABASE_URL: dbUrl, NEXT_PUBLIC_APP_URL: "https://mind.heeca.com.br", AUTH_TRUST_HOST: "true",
      AUTH_SECRET: secret("MIND_AUTH_SECRET"), CRON_SECRET: secret("MIND_CRON_SECRET"),
      ENCRYPTION_KEY: Buffer.from(secret("MIND_ENCRYPTION_KEY"), "hex").toString("base64"), // 32 bytes em base64
      // WhatsApp pelo Heeca Notify (o produto nunca fala com a Meta); NOTIFY_SECRET = NOTIFY_SECRET_MIND do Notify
      WHATSAPP_PROVIDER: "notify", NOTIFY_URL: "https://notify.heeca.com.br", NOTIFY_PRODUCT: "mind", NOTIFY_SECRET: secret("NOTIFY_SECRET_MIND"),
      // E-mail pelo SMTP do Resend
      EMAIL_DRIVER: external("RESEND_API_KEY") ? "smtp" : "console", SMTP_URL, EMAIL_FROM: "Heeca Mind <no-reply@heeca.com.br>",
      // Anexos do prontuário (cifrados antes de subir): bucket privado heeca-mind; sem credencial fica em disco (volume)
      ...s3Env("mind"), PRIVATE_STORAGE_DIR: "/app/storage/private",
      // Portal Heeca (provision/entitlement/SSO)
      HEECA_PLATFORM_SECRET: secret("MIND_PLATFORM_SECRET"), HEECA_PORTAL_URL: "https://heeca.com.br",
    }),
  },
  {
    // Heeca Nutri: nutricionistas (repo heeca-nutri, fork do Mind — decisão N0 de 20/09/2026; mesmo motor
    // Health/Mind, biblioteca de alimentos/receitas/plano alimentar por cima). Handoff definitivo em
    // heeca_nutri/docs/nutri/HANDOFF-PLATAFORMA.md (23/09/2026): 19/19 critérios, 260 testes, LGPD/tenant
    // cobertos. ENCRYPTION_KEY cifra prontuário/plano — gerada aqui, guardada só em production.env.
    name: "heeca-nutri", repo: "heeca-nutri", db: "heeca-nutri-db", port: "3000",
    domains: "https://nutri.heeca.com.br",
    env: (dbUrl) => ({
      NODE_ENV: "production", DATABASE_URL: dbUrl, APP_URL: "https://nutri.heeca.com.br", AUTH_TRUST_HOST: "true",
      AUTH_SECRET: secret("NUTRI_AUTH_SECRET"), CRON_SECRET: secret("NUTRI_CRON_SECRET"),
      ENCRYPTION_KEY: Buffer.from(secret("NUTRI_ENCRYPTION_KEY"), "hex").toString("base64"), // 32 bytes em base64
      // WhatsApp pelo Heeca Notify (o produto nunca fala com a Meta); NOTIFY_SECRET = NOTIFY_SECRET_NUTRI do Notify
      WHATSAPP_PROVIDER: "notify", NOTIFY_URL: "https://notify.heeca.com.br", NOTIFY_PRODUCT: "nutri", NOTIFY_SECRET: secret("NOTIFY_SECRET_NUTRI"),
      // E-mail pelo SMTP do Resend
      EMAIL_DRIVER: external("RESEND_API_KEY") ? "smtp" : "console", SMTP_URL, EMAIL_FROM: "Heeca Nutri <no-reply@heeca.com.br>",
      // Fotos de receita (públicas) e documentos clínicos (cifrados antes de subir): bucket privado heeca-nutri;
      // sem credencial fica em disco (volume). Base de alimentos (⚑ N3, TBCA/TACO) é importada à parte, pós-deploy.
      ...s3Env("nutri"), PRIVATE_STORAGE_DIR: "/app/storage/private",
      // Portal Heeca (provision/entitlement/SSO)
      HEECA_PLATFORM_SECRET: secret("NUTRI_PLATFORM_SECRET"), HEECA_PORTAL_URL: "https://heeca.com.br",
    }),
  },
  {
    // Heeca Bronze: studios de bronzeamento (repo heeca-bronze, fork do heeca_spa — produto próprio, não
    // marca do motor Nail: método de bronzeamento, registro de sessão, produtos e estoque não existem no
    // motor). Decisão do Bruno em 23/09/2026: mantém como fork. Sem upload (imagens por URL) — nenhum bucket R2.
    name: "heeca-bronze", repo: "heeca-bronze", db: "heeca-bronze-db", port: "3000",
    domains: "https://bronze.heeca.com.br",
    env: (dbUrl) => ({
      NODE_ENV: "production", DATABASE_URL: dbUrl, APP_URL: "https://bronze.heeca.com.br", MIGRATE_ON_START: "true",
      AUTH_SECRET: secret("BRONZE_AUTH_SECRET"),
      // WhatsApp pelo Heeca Notify (console até os templates da Meta existirem — ver docs/DEPLOY.md do Bronze)
      WHATSAPP_PROVIDER: "notify", NOTIFY_URL: "https://notify.heeca.com.br", NOTIFY_PRODUCT: "bronze", NOTIFY_SECRET: secret("NOTIFY_SECRET_BRONZE"),
      EMAIL_DRIVER: external("RESEND_API_KEY") ? "smtp" : "console", SMTP_URL, EMAIL_FROM: "Heeca Bronze <no-reply@heeca.com.br>",
      // Portal Heeca (provision/entitlement/SSO)
      HEECA_PLATFORM_SECRET: secret("BRONZE_PLATFORM_SECRET"), HEECA_PORTAL_URL: "https://heeca.com.br",
    }),
  },
  {
    // Heeca Kids: gestão de creche/berçário/educação infantil (spec Fase 1-3: matrícula,
    // rotina, frequência, financeiro básico, BI). Multiunidade dentro do próprio tenant
    // (Unit), não confundir com multi-tenant da plataforma. Sem seed de demo em produção
    // (decisão do Bruno) — a conta real é criada depois, como os outros produtos fazem.
    name: "heeca-kids", repo: "heeca-kids", db: "heeca-kids-db", port: "3000",
    domains: "https://kids.heeca.com.br",
    env: (dbUrl) => ({
      NODE_ENV: "production", DATABASE_URL: dbUrl, APP_URL: "https://kids.heeca.com.br",
      SESSION_SECRET: secret("KIDS_SESSION_SECRET"), SEED_DEMO: "false", MIGRATE_ON_START: "true",
      // WhatsApp pelo Heeca Notify (a creche nunca fala com a Meta); NOTIFY_SECRET = NOTIFY_SECRET_KIDS do Notify
      NOTIFY_URL: "https://notify.heeca.com.br", NOTIFY_PRODUCT: "kids", NOTIFY_SECRET: secret("NOTIFY_SECRET_KIDS"),
      // Heeca AI (Fase 3, spec 54.1): STUB enquanto ANTHROPIC_API_KEY não existir em production.env — sem
      // ela a UI mostra "em breve" e nenhuma chamada externa é feita (ver src/server/ai/service.ts).
      ANTHROPIC_API_KEY: external("ANTHROPIC_API_KEY"),
      // Portal Heeca (provision/entitlement/SSO) — implementado em 24/09 (src/lib/heeca/), testado
      // de ponta a ponta localmente (provision idempotente, entitlement com bloqueio real, SSO com
      // replay de jti recusado). Ainda sem catálogo/DNS/deploy em produção — ver PENDENCIAS.md G12.
      HEECA_PLATFORM_SECRET: secret("KIDS_PLATFORM_SECRET"), HEECA_PORTAL_URL: "https://heeca.com.br",
    }),
  },
  {
    // Heeca Atelier: costureiras/alfaiates/ateliês sob medida (repo heeca-atelier, motor Project —
    // primeiro produto nesse motor). Handoff em hecca_atelier/docs/HANDOFF-PLATAFORMA.md (24/09/2026).
    name: "heeca-atelier", repo: "heeca-atelier", db: "heeca-atelier-db", port: "3000",
    domains: "https://atelier.heeca.com.br",
    env: (dbUrl) => ({
      NODE_ENV: "production", DATABASE_URL: dbUrl, APP_URL: "https://atelier.heeca.com.br", AUTH_TRUST_HOST: "true",
      AUTH_SECRET: secret("ATELIER_AUTH_SECRET"), MIGRATE_ON_START: "true",
      // WhatsApp pelo Heeca Notify (o produto nunca fala com a Meta); NOTIFY_SECRET_ATELIER = mesmo nome do Notify
      NOTIFY_URL: "https://notify.heeca.com.br", NOTIFY_PRODUCT: "atelier", NOTIFY_SECRET_ATELIER: secret("NOTIFY_SECRET_ATELIER"),
      // Portal Heeca (provision/entitlement/SSO)
      HEECA_PLATFORM_SECRET: secret("ATELIER_PLATFORM_SECRET"), HEECA_PORTAL_URL: "https://heeca.com.br",
    }),
  },
  {
    // Heeca Make: maquiagem para eventos/casamentos (repo heeca-make, ex-Heeca_Make — produto próprio,
    // NÃO segmento do Beauty: Event/EventStaff/Quote/Installment de primeira classe, deslocamento como
    // ocupação de agenda. Achado e corrigido em 24/09 (registro anterior dizia "absorvido", estava errado).
    name: "heeca-make", repo: "heeca-make", db: "heeca-make-db", port: "3000",
    domains: "https://make.heeca.com.br",
    env: (dbUrl) => ({
      NODE_ENV: "production", DATABASE_URL: dbUrl, APP_URL: "https://make.heeca.com.br",
      AUTH_SECRET: secret("MAKE_AUTH_SECRET"), CRON_SECRET: secret("MAKE_CRON_SECRET"), MIGRATE_ON_START: "true",
      // WhatsApp pelo Heeca Notify (o produto nunca fala com a Meta); NOTIFY_SECRET = NOTIFY_SECRET_MAKE do Notify
      WHATSAPP_PROVIDER: "notify", NOTIFY_URL: "https://notify.heeca.com.br", NOTIFY_PRODUCT: "make", NOTIFY_SECRET: secret("NOTIFY_SECRET_MAKE"),
      EMAIL_PROVIDER: external("RESEND_API_KEY") ? "resend" : "console", RESEND_API_KEY: external("RESEND_API_KEY"), EMAIL_FROM: "Heeca Make <no-reply@heeca.com.br>",
      PIX_PROVIDER: "mercadopago", MERCADOPAGO_ACCESS_TOKEN: "", MERCADOPAGO_WEBHOOK_SECRET: external("MERCADOPAGO_WEBHOOK_SECRET"),
      // Portal Heeca (provision/entitlement/SSO)
      HEECA_PLATFORM_SECRET: secret("MAKE_PLATFORM_SECRET"), HEECA_PORTAL_URL: "https://heeca.com.br",
    }),
  },
  {
    // Heeca Cut: barbearias (repo heeca-barbershop, ex-Barbearia — produto próprio, NUNCA foi de fato
    // absorvido pelo Beauty apesar de "cut" ter ficado nos hosts dele por engano por meses, corrigido 24/09).
    // Billing dos profissionais gerenciado pelo portal (provider "heeca" na Subscription local).
    name: "heeca-cut", repo: "heeca-barbershop", db: "heeca-cut-db", port: "3000",
    domains: "https://cut.heeca.com.br",
    env: (dbUrl) => ({
      NODE_ENV: "production", DATABASE_URL: dbUrl, APP_URL: "https://cut.heeca.com.br",
      AUTH_SECRET: secret("CUT_AUTH_SECRET"), CRON_SECRET: secret("CUT_CRON_SECRET"),
      // WhatsApp pelo Heeca Notify (o produto nunca fala com a Meta); NOTIFY_SECRET = NOTIFY_SECRET_CUT do Notify
      WHATSAPP_PROVIDER: "notify", NOTIFY_URL: "https://notify.heeca.com.br", NOTIFY_PRODUCT: "cut", NOTIFY_SECRET: secret("NOTIFY_SECRET_CUT"),
      EMAIL_PROVIDER: external("RESEND_API_KEY") ? "resend" : "console", RESEND_API_KEY: external("RESEND_API_KEY"), EMAIL_FROM: "Heeca Cut <no-reply@heeca.com.br>",
      PIX_PROVIDER: "mercadopago", MERCADOPAGO_ACCESS_TOKEN: "", MERCADOPAGO_WEBHOOK_SECRET: external("MERCADOPAGO_WEBHOOK_SECRET"),
      // Bucket público compartilhado (logo, foto do profissional, imagem do serviço), prefixo "cut"
      ...s3PublicEnv("cut"),
      // Assinatura dos profissionais é a própria plataforma Heeca — billing local (BILLING_PROVIDER) fica
      // desligado/mock: o gate real vem do entitlement (Subscription.provider="heeca")
      BILLING_PROVIDER: "mock",
      // Portal Heeca (provision/entitlement/SSO)
      HEECA_PLATFORM_SECRET: secret("CUT_PLATFORM_SECRET"), HEECA_PORTAL_URL: "https://heeca.com.br",
    }),
  },
  {
    // Heeca Pet: pet shops/banho e tosa/vet/hotel/adestramento (repo heeca-pet). Fase 1 (MVP): cadastro
    // de responsáveis/pets, serviços, agenda com status, fluxo de banho e tosa, financeiro básico.
    name: "heeca-pet", repo: "heeca-pet", db: "heeca-pet-db", port: "3000",
    domains: "https://pet.heeca.com.br",
    env: (dbUrl) => ({
      NODE_ENV: "production", DATABASE_URL: dbUrl, APP_URL: "https://pet.heeca.com.br", MIGRATE_ON_START: "true",
      PET_AUTH_SECRET: secret("PET_AUTH_SECRET"),
      // WhatsApp pelo Heeca Notify (o produto nunca fala com a Meta); NOTIFY_SECRET_PET = mesmo nome do Notify
      NOTIFY_PROVIDER: "notify", NOTIFY_URL: "https://notify.heeca.com.br", NOTIFY_PRODUCT: "pet", NOTIFY_SECRET_PET: secret("NOTIFY_SECRET_PET"),
      // Portal Heeca (provision/entitlement/SSO) — repo aceita os dois nomes, HEECA_PLATFORM_SECRET é o principal
      HEECA_PLATFORM_SECRET: secret("PET_PLATFORM_SECRET"), PET_PLATFORM_SECRET: secret("PET_PLATFORM_SECRET"), HEECA_PORTAL_URL: "https://heeca.com.br",
    }),
  },
  {
    // Heeca Service: ordem de serviço (eletricistas, encanadores, técnicos etc.) — repo heeca-service,
    // primeiro produto do motor "Service" (orçamento → visita → execução com fotos → cobrança/recibo).
    name: "heeca-service", repo: "heeca-service", db: "heeca-service-db", port: "3000",
    domains: "https://service.heeca.com.br",
    env: (dbUrl) => ({
      NODE_ENV: "production", DATABASE_URL: dbUrl, APP_URL: "https://service.heeca.com.br", MIGRATE_ON_START: "true",
      AUTH_SECRET: secret("SERVICE_AUTH_SECRET"), CRON_SECRET: secret("SERVICE_CRON_SECRET"),
      // WhatsApp pelo Heeca Notify (o produto nunca fala com a Meta)
      NOTIFY_PROVIDER: "notify", NOTIFY_URL: "https://notify.heeca.com.br/api/v1/messages", NOTIFY_SECRET_SERVICE: secret("NOTIFY_SECRET_SERVICE"),
      // Portal Heeca (provision/entitlement/SSO)
      HEECA_PLATFORM_SECRET: secret("SERVICE_PLATFORM_SECRET"), HEECA_PORTAL_URL: "https://heeca.com.br",
    }),
  },
  {
    // Heeca Notify: serviço central de WhatsApp/notificações (heeca_notify). Único lugar com credenciais da Meta.
    name: "heeca-notify", repo: "heeca-notify", db: "heeca-notify-db", port: "3000",
    domains: "https://notify.heeca.com.br",
    env: (dbUrl) => ({
      NODE_ENV: "production", DATABASE_URL: dbUrl, APP_URL: "https://notify.heeca.com.br", MIGRATE_ON_START: "true",
      NOTIFY_WORKER_INPROCESS: "true", NOTIFY_MAX_PER_TENANT_MONTH: "0",
      // Um segredo por produto — o mesmo valor vai ao produto como NOTIFY_SECRET
      ...Object.fromEntries(["beauty", "wellness", "dental", "ink", "piercing", "mind", "kids", "nutri", "bronze", "atelier", "make", "cut", "pet", "move", "service"].map((p) => [`NOTIFY_SECRET_${p.toUpperCase()}`, secret(`NOTIFY_SECRET_${p.toUpperCase()}`)])),
      // Meta Cloud API (WhatsApp Business) OU Twilio (BSP — achado em 24/09: a verificação de negócio
      // do Meta for Developers travou a conta pessoal do Bruno duas vezes; a Twilio faz essa
      // verificação por trás, sem tocar numa conta pessoal do Facebook). Meta ganha se as duas
      // credenciais existirem (ela já está mais madura no cadastro); senão Twilio; senão console.
      WHATSAPP_PROVIDER: external("WHATSAPP_ACCESS_TOKEN") && external("WHATSAPP_PHONE_NUMBER_ID") ? "meta" : external("TWILIO_ACCOUNT_SID") && (external("TWILIO_AUTH_TOKEN") || (external("TWILIO_API_KEY_SID") && external("TWILIO_API_KEY_SECRET"))) && external("TWILIO_WHATSAPP_FROM") ? "twilio" : "console",
      WHATSAPP_PHONE_NUMBER_ID: external("WHATSAPP_PHONE_NUMBER_ID"), WHATSAPP_ACCESS_TOKEN: external("WHATSAPP_ACCESS_TOKEN"),
      WHATSAPP_BUSINESS_ACCOUNT_ID: external("WHATSAPP_BUSINESS_ACCOUNT_ID"), WHATSAPP_APP_SECRET: external("WHATSAPP_APP_SECRET"),
      WHATSAPP_VERIFY_TOKEN: secret("NOTIFY_WHATSAPP_VERIFY_TOKEN", 16),
      // Twilio: TWILIO_CONTENT_SID_<NOME_DO_TEMPLATE> (um por template) fica fora daqui de propósito —
      // não sabemos os nomes de antemão; o Bruno acrescenta direto em production.env conforme cadastra
      // cada template no Content Template Builder da Twilio, e o apply publica junto sem precisar de código novo.
      TWILIO_ACCOUNT_SID: external("TWILIO_ACCOUNT_SID"), TWILIO_AUTH_TOKEN: external("TWILIO_AUTH_TOKEN"), TWILIO_WHATSAPP_FROM: external("TWILIO_WHATSAPP_FROM"),
      TWILIO_API_KEY_SID: external("TWILIO_API_KEY_SID"), TWILIO_API_KEY_SECRET: external("TWILIO_API_KEY_SECRET"),
      ...Object.fromEntries(Object.keys(secrets).filter((k) => k.startsWith("TWILIO_CONTENT_SID_")).map((k) => [k, external(k)])),
    }),
  },
  {
    name: "heeca-store", repo: "heeca-vendas", db: "heeca-store-db", port: "3000",
    domains: "https://store.heeca.com.br",
    env: (dbUrl) => ({
      NODE_ENV: "production", DATABASE_URL: dbUrl, APP_URL: "https://store.heeca.com.br",
      AUTH_SECRET: secret("STORE_AUTH_SECRET"), MIGRATE_ON_START: "true",
      // E-mail de orçamentos pelo SDK do Resend (mesma chave dos outros apps)
      RESEND_API_KEY: external("RESEND_API_KEY"), RESEND_REMETENTE: "Heeca Store <no-reply@heeca.com.br>",
      // Fotos de produto/equipamento e logo da loja: bucket público heeca-public via cdn.heeca.com.br, pasta "store/" (chave por empresa)
      ...s3PublicEnv("store"),
      // Portal Heeca (provision/entitlement/SSO)
      HEECA_PLATFORM_SECRET: secret("STORE_PLATFORM_SECRET"), HEECA_PORTAL_URL: "https://heeca.com.br",
    }),
  },
  // Motor Heeca Schedule (repo heeca-beauty): MESMA imagem para Beauty e Wellness, mas cada marca é um produto individual —
  // container, Postgres e segredos próprios (MARCA_DEFAULT diz ao container qual marca ele é). Dentro da marca, os segmentos
  // são configuração do estabelecimento. Hosts absorvidos apontam para o app da marca e o proxy redireciona 301.
  ...[
    { marca: "beauty", nome: "Heeca Beauty", hosts: ["beauty", "nail", "lash", "brow", "skin"] }, // "cut" NÃO entra: Heeca Cut/Barbearia é produto próprio (G2b, 24/09), nunca foi absorvido de verdade
    { marca: "wellness", nome: "Heeca Wellness", hosts: ["wellness", "massage"] },
  ].map(({ marca, nome, hosts }) => {
    const K = marca.toUpperCase();
    return {
      name: `heeca-${marca}`, repo: "heeca-beauty", db: `heeca-${marca}-db`, port: "3000",
      domains: hosts.map((h) => `https://${h}.heeca.com.br`).join(","),
      env: (dbUrl) => ({
        NODE_ENV: "production", DATABASE_URL: dbUrl, APP_URL: `https://${marca}.heeca.com.br`, APP_URL_TEMPLATE: "https://{marca}.heeca.com.br", MARCA_DEFAULT: marca,
        AUTH_SECRET: secret(`${K}_AUTH_SECRET`), CRON_SECRET: secret(`${K}_CRON_SECRET`),
        MIGRATE_ON_START: "true", CRON_INPROCESS: "true", // lembretes e expiração rodam dentro do processo
        // WhatsApp pelo Heeca Notify (D9): o produto nunca fala com a Meta. NOTIFY_SECRET = NOTIFY_SECRET_<PRODUTO> do Notify.
        WHATSAPP_PROVIDER: "notify", NOTIFY_URL: "https://notify.heeca.com.br", NOTIFY_PRODUCT: marca, NOTIFY_SECRET: secret(`NOTIFY_SECRET_${K}`),
        WHATSAPP_TEMPLATE_LANGUAGE: "pt_BR",
        // E-mail pelo SDK do Resend (mesma chave dos outros apps)
        EMAIL_PROVIDER: external("RESEND_API_KEY") ? "resend" : "console", RESEND_API_KEY: external("RESEND_API_KEY"), EMAIL_FROM: `${nome} <no-reply@heeca.com.br>`,
        // Pix do sinal: cada estabelecimento salva o próprio token do Mercado Pago no painel; sem fallback de plataforma
        PIX_PROVIDER: "mercadopago", MERCADOPAGO_ACCESS_TOKEN: "", MERCADOPAGO_WEBHOOK_SECRET: external("MERCADOPAGO_WEBHOOK_SECRET"),
        // Portal Heeca (provision/entitlement/SSO) — segredo próprio por marca
        HEECA_PLATFORM_SECRET: secret(`${K}_PLATFORM_SECRET`), HEECA_PORTAL_URL: "https://heeca.com.br",
      }),
    };
  }),
  {
    // Heeca Piercing: studios de piercing (joias, consentimento, registro por perfuração, orçamento, retorno). Clone do Nail com schema próprio — container e banco separados.
    name: "heeca-piercing", repo: "heeca-piercing", db: "heeca-piercing-db", port: "3000",
    domains: "https://piercing.heeca.com.br",
    env: (dbUrl) => ({
      NODE_ENV: "production", DATABASE_URL: dbUrl, APP_URL: "https://piercing.heeca.com.br",
      AUTH_SECRET: secret("PIERCING_AUTH_SECRET"), CRON_SECRET: secret("PIERCING_CRON_SECRET"),
      MIGRATE_ON_START: "true", CRON_INPROCESS: "true", // lembretes, expiração e retorno rodam dentro do processo
      // WhatsApp em "console" até os templates da Meta serem aprovados (credenciais próprias em production.env: PIERCING_WHATSAPP_*)
      // WhatsApp pelo Heeca Notify (o produto nunca fala com a Meta); NOTIFY_SECRET = NOTIFY_SECRET_PIERCING do Notify
      WHATSAPP_PROVIDER: "notify", NOTIFY_URL: "https://notify.heeca.com.br", NOTIFY_PRODUCT: "piercing", NOTIFY_SECRET: secret("NOTIFY_SECRET_PIERCING"),
      WHATSAPP_PHONE_NUMBER_ID: external("PIERCING_WHATSAPP_PHONE_NUMBER_ID"), WHATSAPP_ACCESS_TOKEN: external("PIERCING_WHATSAPP_ACCESS_TOKEN"),
      WHATSAPP_APP_SECRET: external("PIERCING_WHATSAPP_APP_SECRET"), WHATSAPP_VERIFY_TOKEN: secret("PIERCING_WHATSAPP_VERIFY_TOKEN", 16),
      WHATSAPP_BUSINESS_ACCOUNT_ID: external("PIERCING_WHATSAPP_BUSINESS_ACCOUNT_ID"), WHATSAPP_TEMPLATE_LANGUAGE: "pt_BR",
      // E-mail pelo SDK do Resend (mesma chave dos outros apps)
      EMAIL_PROVIDER: external("RESEND_API_KEY") ? "resend" : "console", RESEND_API_KEY: external("RESEND_API_KEY"), EMAIL_FROM: "Heeca Piercing <no-reply@heeca.com.br>",
      // Pix do sinal: cada studio salva o próprio token do Mercado Pago no painel; sem fallback de plataforma
      PIX_PROVIDER: "mercadopago", MERCADOPAGO_ACCESS_TOKEN: "", MERCADOPAGO_WEBHOOK_SECRET: external("MERCADOPAGO_WEBHOOK_SECRET"),
      // Portal Heeca (provision/entitlement/SSO)
      HEECA_PLATFORM_SECRET: secret("PIERCING_PLATFORM_SECRET"), HEECA_PORTAL_URL: "https://heeca.com.br",
    }),
  },
  {
    // Heeca Ink: tatuadores e studios (orçamento → projeto → arte → sinal → sessões). Clone do Nail com schema próprio — container e banco separados.
    name: "heeca-ink", repo: "heeca-ink", db: "heeca-ink-db", port: "3000",
    domains: "https://ink.heeca.com.br",
    env: (dbUrl) => ({
      NODE_ENV: "production", DATABASE_URL: dbUrl, APP_URL: "https://ink.heeca.com.br",
      AUTH_SECRET: secret("INK_AUTH_SECRET"), CRON_SECRET: secret("INK_CRON_SECRET"),
      MIGRATE_ON_START: "true", CRON_INPROCESS: "true", // lembretes, expiração e retorno rodam dentro do processo
      // WhatsApp em "console" até os templates da Meta serem aprovados (credenciais próprias em production.env: INK_WHATSAPP_*)
      // WhatsApp pelo Heeca Notify (o produto nunca fala com a Meta); NOTIFY_SECRET = NOTIFY_SECRET_INK do Notify
      WHATSAPP_PROVIDER: "notify", NOTIFY_URL: "https://notify.heeca.com.br", NOTIFY_PRODUCT: "ink", NOTIFY_SECRET: secret("NOTIFY_SECRET_INK"),
      WHATSAPP_PHONE_NUMBER_ID: external("INK_WHATSAPP_PHONE_NUMBER_ID"), WHATSAPP_ACCESS_TOKEN: external("INK_WHATSAPP_ACCESS_TOKEN"),
      WHATSAPP_APP_SECRET: external("INK_WHATSAPP_APP_SECRET"), WHATSAPP_VERIFY_TOKEN: secret("INK_WHATSAPP_VERIFY_TOKEN", 16),
      WHATSAPP_BUSINESS_ACCOUNT_ID: external("INK_WHATSAPP_BUSINESS_ACCOUNT_ID"), WHATSAPP_TEMPLATE_LANGUAGE: "pt_BR",
      // E-mail pelo SDK do Resend (mesma chave dos outros apps)
      EMAIL_PROVIDER: external("RESEND_API_KEY") ? "resend" : "console", RESEND_API_KEY: external("RESEND_API_KEY"), EMAIL_FROM: "Heeca Ink <no-reply@heeca.com.br>",
      // Pix do sinal: cada studio salva o próprio token do Mercado Pago no painel; sem fallback de plataforma
      PIX_PROVIDER: "mercadopago", MERCADOPAGO_ACCESS_TOKEN: "", MERCADOPAGO_WEBHOOK_SECRET: external("MERCADOPAGO_WEBHOOK_SECRET"),
      // Referências do cliente, versões de arte e fotos do resultado: bucket público heeca-public via cdn.heeca.com.br, pasta "ink/" (chave por tenant/projeto)
      ...s3PublicEnv("ink"),
      // Portal Heeca (provision/entitlement/SSO)
      HEECA_PLATFORM_SECRET: secret("INK_PLATFORM_SECRET"), HEECA_PORTAL_URL: "https://heeca.com.br",
    }),
  },
  {
    // Heeca Move: fisioterapeutas e quiropraxistas (agenda, planos de tratamento, WhatsApp, domiciliar). Fundação do hecca_psico — container e banco próprios.
    name: "heeca-move", repo: "heeca-move", db: "heeca-move-db", port: "3000",
    domains: "https://move.heeca.com.br",
    env: (dbUrl) => ({
      NODE_ENV: "production", DATABASE_URL: dbUrl, NEXT_PUBLIC_APP_URL: "https://move.heeca.com.br", AUTH_URL: "https://move.heeca.com.br",
      AUTH_SECRET: secret("MOVE_AUTH_SECRET"), ENCRYPTION_KEY: secret("MOVE_ENCRYPTION_KEY"), CRON_SECRET: secret("MOVE_CRON_SECRET"),
      MIGRATE_ON_START: "true", CRON_INPROCESS: "true", // envio do WhatsApp, lembretes, retorno e expiração de planos rodam dentro do processo
      // WhatsApp pelo Heeca Notify (migrado 25/09 — Meta direta era fallback legado, achado na validação de padrão de 24/09)
      NOTIFY_URL: "https://notify.heeca.com.br", NOTIFY_PRODUCT: "move", NOTIFY_SECRET: secret("NOTIFY_SECRET_MOVE"),
      // E-mail pela API do Resend (mesma chave dos outros apps)
      RESEND_API_KEY: external("RESEND_API_KEY"), EMAIL_FROM: "Heeca Move <no-reply@heeca.com.br>",
      // Portal Heeca (provision/entitlement/SSO)
      HEECA_PLATFORM_SECRET: secret("MOVE_PLATFORM_SECRET"), HEECA_PORTAL_URL: "https://heeca.com.br",
    }),
  },
];

// ---------- helpers ----------
const byName = (list, name) => list.find((x) => x.name === name);
async function server() {
  const [s] = await api("/servers");
  return s;
}
async function project() {
  const existing = byName(await api("/projects"), PROJECT.name);
  return existing ?? null;
}

// ---------- comandos ----------
const cmd = process.argv[2] ?? "plan";
const srv = await server();
let proj = await project();

if (cmd === "plan") {
  console.log(`servidor: ${srv.name} (${srv.uuid})`);
  console.log(`projeto ${PROJECT.name}: ${proj ? "existe" : "criar"}`);
  const dbs = await api("/databases");
  for (const d of DBS) console.log(`db ${d.name}: ${byName(dbs, d.name) ? "existe" : "criar"}`);
  const apps = await api("/applications");
  for (const a of APPS) console.log(`app ${a.name}: ${byName(apps, a.name) ? "existe" : "criar"} → ${a.domains}`);
}

if (cmd === "apply") {
  process.on("exit", () => { if (compartilhados.length) console.warn(`
! ainda no bucket COMPARTILHADO (criar bucket + token próprios em production.env): ${[...new Set(compartilhados)].join("; ")}`); });
  // `apply <app>` restringe a um app (e ao banco dele): útil quando outros apps da lista ainda não têm repositório.
  const only = process.argv[3];
  const APPS_TODO = only ? APPS.filter((a) => a.name === only) : APPS;
  const DBS_TODO = only ? DBS.filter((d) => APPS_TODO.some((a) => a.db === d.name)) : DBS;
  if (only && APPS_TODO.length === 0) { console.error(`app ${only} não está na lista`); process.exit(1); }
  if (!proj) {
    proj = await api("/projects", { method: "POST", body: JSON.stringify(PROJECT) });
    console.log(`+ projeto ${PROJECT.name} (${proj.uuid})`);
  } else console.log(`= projeto ${PROJECT.name} (${proj.uuid})`);

  // Bancos
  const dbUrls = {};
  for (const d of DBS_TODO) {
    let db = byName(await api("/databases"), d.name);
    if (!db) {
      db = await api("/databases/postgresql", {
        method: "POST",
        body: JSON.stringify({ server_uuid: srv.uuid, project_uuid: proj.uuid, environment_name: ENV_NAME, name: d.name, description: `Postgres do ${d.name.replace("-db", "")}`, image: "postgres:17-alpine", postgres_user: d.user, postgres_password: secret(`${d.db.toUpperCase()}_PASSWORD`, 24), postgres_db: d.db, is_public: false, instant_deploy: true }),
      });
      console.log(`+ db ${d.name} (${db.uuid})`);
    } else console.log(`= db ${d.name} (${db.uuid})`);
    const full = await api(`/databases/${db.uuid}`);
    dbUrls[d.name] = full.internal_db_url ?? `postgresql://${d.user}:${secret(`${d.db.toUpperCase()}_PASSWORD`, 24)}@${db.uuid}:5432/${d.db}`;
  }
  saveSecrets();

  // Apps
  for (const a of APPS_TODO) {
    let app = byName(await api("/applications"), a.name);
    if (!app) {
      // Repo ainda não existe no GitHub ou o GitHub App "heeca" não tem acesso a ele: avisa e segue para os outros apps.
      try {
      app = await api("/applications/private-github-app", {
        method: "POST",
        body: JSON.stringify({
          project_uuid: proj.uuid, server_uuid: srv.uuid, environment_name: ENV_NAME, github_app_uuid: GITHUB_APP_UUID,
          git_repository: `${OWNER}/${a.repo}`, git_branch: "main", build_pack: "dockerfile", dockerfile_location: "/Dockerfile", ports_exposes: a.port,
          name: a.name, description: `Heeca - ${a.name}`, domains: a.domains, ...HEALTH, instant_deploy: false,
        }),
      });
      console.log(`+ app ${a.name} (${app.uuid}) → ${a.domains}`);
      } catch (e) {
        console.warn(`! app ${a.name} NÃO criado: ${e.message.includes("not found or not accessible") ? `repositório ${OWNER}/${a.repo} não existe ou não está liberado para o GitHub App heeca` : e.message}`);
        continue;
      }
    } else console.log(`= app ${a.name} (${app.uuid})`);
    // Domínio e healthcheck reaplicados sempre (idempotente): trocar o subdomínio aqui basta, o Traefik emite o certificado novo no próximo deploy.
    const domains = (app.fqdn ?? "") !== a.domains ? { domains: a.domains } : {};
    if (domains.domains) console.log(`  ~ domínio ${app.fqdn ?? "-"} → ${a.domains}`);
    await api(`/applications/${app.uuid}`, { method: "PATCH", body: JSON.stringify({ ...HEALTH, ...domains }) });
    const dbUrl = `${dbUrls[a.db]}?schema=public`;
    const env = a.env(dbUrl);
    await api(`/applications/${app.uuid}/envs/bulk`, { method: "PATCH", body: JSON.stringify({ data: Object.entries(env).map(([key, value]) => ({ key, value, is_preview: false, is_build_time: false, is_literal: true })) }) });
    console.log(`  ${Object.keys(env).length} variáveis definidas`);
  }
  saveSecrets();
  console.log(`\nsegredos em ${SECRETS_FILE}`);
}

if (cmd === "deploy") {
  const only = process.argv[3];
  const apps = await api("/applications");
  for (const a of APPS) {
    if (only && a.name !== only) continue;
    const app = byName(apps, a.name);
    if (!app) { console.log(`! app ${a.name} não existe (rode apply)`); continue; }
    const r = await api(`/deploy?uuid=${app.uuid}&force=true`, { method: "POST" });
    console.log(`▶ ${a.name}: ${JSON.stringify(r.deployments?.[0] ?? r).slice(0, 160)}`);
  }
}

/** Apps de produtos absorvidos: parados e sem domínio (o domínio passa ao app que absorveu). Não apaga nada — apagar app/banco é decisão do Bruno. */
const RETIRADOS = ["heeca-nail", "heeca-lash", "heeca-brow", "heeca-skin", "heeca-massage"];
if (cmd === "retirar") {
  const apps = await api("/applications");
  for (const name of RETIRADOS) {
    const app = byName(apps, name);
    if (!app) { console.log(`= ${name}: já não existe`); continue; }
    if (app.fqdn) { await api(`/applications/${app.uuid}`, { method: "PATCH", body: JSON.stringify({ domains: "" }) }); console.log(`  ~ ${name}: domínio ${app.fqdn} removido`); }
    if (!String(app.status).startsWith("exited")) { await api(`/applications/${app.uuid}/stop`, { method: "POST" }); console.log(`■ ${name}: parado`); } else console.log(`= ${name}: já parado`);
  }
}

/** Apaga de vez apps e bancos dos absorvidos (com volumes e backups). Só depois de o Bruno confirmar que não havia cliente real. */
const APAGAR_DBS = ["heeca-nail-db", "heeca-lash-db", "heeca-brow-db", "heeca-skin-db", "heeca-massage-db"];
if (cmd === "apagar") {
  const apps = await api("/applications");
  for (const name of RETIRADOS) {
    const app = byName(apps, name);
    if (!app) { console.log(`= ${name}: já não existe`); continue; }
    await api(`/applications/${app.uuid}?delete_configurations=true&delete_volumes=true&docker_cleanup=true&delete_connected_networks=true`, { method: "DELETE" });
    console.log(`✕ app ${name} apagado`);
  }
  const dbs = await api("/databases");
  for (const name of APAGAR_DBS) {
    const db = byName(dbs, name);
    if (!db) { console.log(`= ${name}: já não existe`); continue; }
    await api(`/databases/${db.uuid}?delete_configurations=true&delete_volumes=true&docker_cleanup=true&delete_connected_networks=true`, { method: "DELETE" });
    console.log(`✕ db ${name} apagado`);
  }
}

if (cmd === "status") {
  const apps = await api("/applications");
  for (const a of APPS) { const app = byName(apps, a.name); console.log(`app ${a.name}: ${app ? `${app.status} ${app.fqdn}` : "—"}`); }
  const dbs = await api("/databases");
  for (const d of DBS) { const db = byName(dbs, d.name); console.log(`db ${d.name}: ${db ? db.status : "—"}`); }
}

// Domínio de envio da Heeca no Resend (e-mail transacional dos três apps via SMTP).
//   node infra/resend.mjs check    → conta, domínio heeca.com.br e status de cada registro DNS
//   node infra/resend.mjs apply    → cria o domínio (se faltar), grava os registros na Cloudflare e pede verificação
//   node infra/resend.mjs test <e-mail> → envia um e-mail de teste pela API (prova que o domínio está verificado)
// Lê infra/.env (RESEND_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE). Tokens nunca são impressos.
// Os apps NÃO usam a API: usam SMTP_URL=smtps://resend:<RESEND_API_KEY>@smtp.resend.com:2465 (ver coolify-setup.mjs).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2]; // o .env manda: variável do sistema com o mesmo nome (ex.: token antigo) não pode vencer
}
const { RESEND_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE: ZONE = "heeca.com.br" } = process.env;
if (!RESEND_API_KEY) { console.error("RESEND_API_KEY vazio em infra/.env"); process.exit(1); }

const REGION = "sa-east-1"; // São Paulo (o domínio heeca.com.br está nessa região desde 18/09)
const MAIL_FROM = `Heeca <no-reply@${ZONE}>`;

async function resend(path, init = {}) {
  const res = await fetch(`https://api.resend.com${path}`, { ...init, headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json", ...init.headers } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${json.message ?? json.name ?? ""}`);
  return json;
}
async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json", ...init.headers } });
  const json = await res.json();
  if (!json.success) throw new Error(`${init.method ?? "GET"} ${path}: ${json.errors?.map((e) => `${e.code} ${e.message}`).join("; ")}`);
  return json.result;
}

const cmd = process.argv[2] ?? "check";

// ---------- domínio no Resend ----------
const { data: domains } = await resend("/domains");
let domain = domains.find((d) => d.name === ZONE);
if (!domain && cmd === "apply") {
  domain = await resend("/domains", { method: "POST", body: JSON.stringify({ name: ZONE, region: REGION }) });
  console.log(`+ domínio ${ZONE} criado no Resend (${domain.id})`);
}
if (!domain) { console.log(`domínio ${ZONE} ainda não existe no Resend (rode apply)`); process.exit(0); }
domain = await resend(`/domains/${domain.id}`);
console.log(`domínio ${domain.name}: ${domain.status} · região ${domain.region}`);
for (const r of domain.records) console.log(`  ${r.record.padEnd(4)} ${r.type.padEnd(5)} ${r.name.padEnd(22)} ${r.status.padEnd(12)} ${r.type === "MX" ? `prio ${r.priority} ` : ""}${r.value.slice(0, 60)}${r.value.length > 60 ? "…" : ""}`);

// ---------- registros na Cloudflare ----------
if (cmd === "apply") {
  if (!CLOUDFLARE_API_TOKEN) { console.error("CLOUDFLARE_API_TOKEN vazio em infra/.env"); process.exit(1); }
  const [zone] = await cf(`/zones?name=${ZONE}`);
  const existing = await cf(`/zones/${zone.id}/dns_records?per_page=100`);
  for (const r of domain.records) {
    // O Resend devolve `name` relativo ao domínio ("send", "resend._domainkey"); a Cloudflare quer o FQDN.
    const name = r.name === "@" || r.name === ZONE ? ZONE : r.name.endsWith(ZONE) ? r.name : `${r.name}.${ZONE}`;
    const want = { type: r.type, name, content: r.value, ttl: 1, proxied: false, comment: "Resend (e-mail transacional)", ...(r.type === "MX" ? { priority: Number(r.priority) } : {}) };
    const cur = existing.find((x) => x.type === want.type && x.name === want.name && (want.type !== "TXT" || x.content.replace(/^"|"$/g, "") === want.content));
    if (cur && cur.content.replace(/^"|"$/g, "") === want.content && (want.type !== "MX" || cur.priority === want.priority)) { console.log(`= ${want.type} ${want.name}`); continue; }
    if (cur) { await cf(`/zones/${zone.id}/dns_records/${cur.id}`, { method: "PUT", body: JSON.stringify(want) }); console.log(`~ ${want.type} ${want.name} atualizado`); }
    else { await cf(`/zones/${zone.id}/dns_records`, { method: "POST", body: JSON.stringify(want) }); console.log(`+ ${want.type} ${want.name} criado`); }
  }
  if (domain.status !== "verified") {
    await resend(`/domains/${domain.id}/verify`, { method: "POST" });
    console.log("▶ verificação pedida ao Resend — propaga em alguns minutos; rode `check` para acompanhar");
  }
}

// ---------- envio de teste ----------
if (cmd === "test") {
  const to = process.argv[3];
  if (!to) { console.error("uso: node infra/resend.mjs test <e-mail>"); process.exit(1); }
  const r = await resend("/emails", { method: "POST", body: JSON.stringify({ from: MAIL_FROM, to: [to], subject: "Heeca — teste de e-mail", text: `Domínio ${ZONE} verificado no Resend. Enviado em ${new Date().toISOString()}.` }) });
  console.log(`✉ enviado para ${to} (id ${r.id})`);
}

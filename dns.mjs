// DNS da Heeca na Cloudflare.
//   node infra/dns.mjs check   → valida o token e mostra a zona e os registros atuais
//   node infra/dns.mjs apply   → cria/atualiza os registros A para SERVER_IP (idempotente)
// Lê infra/.env (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE, SERVER_IP). O token nunca é impresso.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2]; // o .env manda: variável do sistema com o mesmo nome (ex.: token antigo) não pode vencer
}
const { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ZONE: ZONE = "heeca.com.br", SERVER_IP } = process.env;
if (!TOKEN) { console.error("CLOUDFLARE_API_TOKEN vazio em infra/.env"); process.exit(1); }

const API = "https://api.cloudflare.com/client/v4";
async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers } });
  const json = await res.json();
  if (!json.success) throw new Error(`${init.method ?? "GET"} ${path}: ${json.errors?.map((e) => `${e.code} ${e.message}`).join("; ")}`);
  return json.result;
}

// Registros desejados. proxied:false (nuvem cinza) até o TLS do servidor estar emitido;
// o wildcard *.ticket exige DNS-01 no servidor, que usa este mesmo token.
const RECORDS = (ip) => [
  { type: "A", name: ZONE, content: ip, proxied: false, comment: "portal heeca.com.br" },
  { type: "CNAME", name: `www.${ZONE}`, content: ZONE, proxied: false, comment: "www → portal" },
  { type: "A", name: `ticket.${ZONE}`, content: ip, proxied: false, comment: "Heeca Ticket" },
  { type: "A", name: `*.ticket.${ZONE}`, content: ip, proxied: false, comment: "portais por empresa do Ticket" },
  { type: "A", name: `dental.${ZONE}`, content: ip, proxied: false, comment: "Heeca Dental" },
  { type: "A", name: `store.${ZONE}`, content: ip, proxied: false, comment: "Heeca Store" },
  { type: "A", name: `cut.${ZONE}`, content: ip, proxied: false, comment: "Heeca Cut (produto próprio, nunca foi absorvido — correção 24/09)" },
  { type: "A", name: `beauty.${ZONE}`, content: ip, proxied: false, comment: "Heeca Beauty" },
  { type: "A", name: `piercing.${ZONE}`, content: ip, proxied: false, comment: "Heeca Piercing" },
  // Marcas do motor multi-marca heeca_nail (mesmo container do Nail; o Traefik roteia pelo host)
  { type: "A", name: `lash.${ZONE}`, content: ip, proxied: false, comment: "Host absorvido pelo Heeca Beauty (redireciona 301)" },
  { type: "A", name: `ink.${ZONE}`, content: ip, proxied: false, comment: "Heeca Ink" },
  { type: "A", name: `move.${ZONE}`, content: ip, proxied: false, comment: "Heeca Move" },
  { type: "A", name: `mind.${ZONE}`, content: ip, proxied: false, comment: "Heeca Mind" },
  { type: "A", name: `nutri.${ZONE}`, content: ip, proxied: false, comment: "Heeca Nutri" },
  { type: "A", name: `bronze.${ZONE}`, content: ip, proxied: false, comment: "Heeca Bronze" },
  { type: "A", name: `skin.${ZONE}`, content: ip, proxied: false, comment: "Host absorvido pelo Heeca Beauty (redireciona 301)" },
  { type: "A", name: `wellness.${ZONE}`, content: ip, proxied: false, comment: "Heeca Wellness (motor Schedule)" },
  { type: "A", name: `massage.${ZONE}`, content: ip, proxied: false, comment: "Host absorvido pelo Heeca Wellness (redireciona 301)" },
  { type: "A", name: `brow.${ZONE}`, content: ip, proxied: false, comment: "Host absorvido pelo Heeca Beauty (redireciona 301)" },
  { type: "A", name: `notify.${ZONE}`, content: ip, proxied: false, comment: "Heeca Notify (serviço interno)" },
  { type: "A", name: `coolify.${ZONE}`, content: ip, proxied: false, comment: "painel Coolify da Heeca" },
  { type: "A", name: `nail.${ZONE}`, content: ip, proxied: false, comment: "Host absorvido pelo Heeca Beauty (redireciona 301)" },
  { type: "A", name: `kids.${ZONE}`, content: ip, proxied: false, comment: "Heeca Kids" },
  { type: "A", name: `atelier.${ZONE}`, content: ip, proxied: false, comment: "Heeca Atelier" },
  { type: "A", name: `make.${ZONE}`, content: ip, proxied: false, comment: "Heeca Make" },
  { type: "A", name: `pet.${ZONE}`, content: ip, proxied: false, comment: "Heeca Pet" },
  { type: "A", name: `service.${ZONE}`, content: ip, proxied: false, comment: "Heeca Service" },
  // orcamento.heeca.com.br (Heeca Orçamento) NÃO entra aqui: é um Worker da Cloudflare com custom_domain — o "wrangler deploy" cria o registro sozinho.
];

const cmd = process.argv[2] ?? "check";
const me = await cf("/user/tokens/verify");
console.log(`token: ${me.status}`);
const [zone] = await cf(`/zones?name=${ZONE}`);
if (!zone) { console.error(`zona ${ZONE} não encontrada — o token tem acesso a ela?`); process.exit(1); }
console.log(`zona: ${zone.name} (${zone.status}) · nameservers: ${zone.name_servers?.join(", ")}`);
const existing = await cf(`/zones/${zone.id}/dns_records?per_page=100`);
console.log(`registros atuais (${existing.length}):`);
for (const r of existing) console.log(`  ${r.type.padEnd(5)} ${r.name.padEnd(28)} → ${r.content}${r.proxied ? "  (proxied)" : ""}`);

if (cmd === "apply") {
  if (!SERVER_IP) { console.error("SERVER_IP vazio em infra/.env"); process.exit(1); }
  for (const want of RECORDS(SERVER_IP)) {
    const cur = existing.find((r) => r.name === want.name && r.type === want.type);
    if (cur && cur.content === want.content && cur.proxied === want.proxied) { console.log(`= ${want.name}`); continue; }
    if (cur) { await cf(`/zones/${zone.id}/dns_records/${cur.id}`, { method: "PUT", body: JSON.stringify({ ...want, ttl: 1 }) }); console.log(`~ ${want.name} atualizado`); }
    else { await cf(`/zones/${zone.id}/dns_records`, { method: "POST", body: JSON.stringify({ ...want, ttl: 1 }) }); console.log(`+ ${want.name} criado`); }
  }
}

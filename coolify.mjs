// Cliente mínimo da API do Coolify (v4). Lê infra/.env (COOLIFY_URL, COOLIFY_TOKEN).
// COOLIFY_API_URL (opcional) troca só o transporte: use com um túnel SSH quando a rede local
// bloquear o domínio do painel →  ssh -N -L 8090:127.0.0.1:8000 heeca-prod  +  COOLIFY_API_URL=http://127.0.0.1:8090
//   node infra/coolify.mjs inspect     → servidores, projetos, recursos existentes (só leitura)
// Outros comandos são adicionados conforme a infra é criada (ver infra/README.md).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m) process.env[m[1]] = m[2]; // o .env manda: variável do sistema com o mesmo nome (ex.: token antigo) não pode vencer
}
const URL_ = (process.env.COOLIFY_API_URL || process.env.COOLIFY_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.COOLIFY_TOKEN ?? "";
if (!URL_ || !TOKEN) { console.error("COOLIFY_URL/COOLIFY_TOKEN vazios em infra/.env"); process.exit(1); }

export async function api(path, init = {}) {
  const res = await fetch(`${URL_}/api/v1${path}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${typeof json === "string" ? json.slice(0, 300) : JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// Só executa comandos quando chamado diretamente (o módulo também é importado por outros scripts).
const direct = !!process.argv[1] && fileURLToPath(import.meta.url).toLowerCase().replace(/\\/g, "/") === process.argv[1].toLowerCase().replace(/\\/g, "/");
const cmd = direct ? (process.argv[2] ?? "inspect") : null;

if (cmd === "inspect") {
  console.log("Coolify", await api("/version"));
  const servers = await api("/servers");
  for (const s of servers) console.log(`servidor: ${s.name} (${s.uuid}) ip=${s.ip} reachable=${s.settings?.is_reachable} usable=${s.settings?.is_usable}`);
  const projects = await api("/projects");
  for (const p of projects) {
    const full = await api(`/projects/${p.uuid}`).catch(() => p);
    const envs = (full.environments ?? []).map((e) => e.name).join(", ");
    console.log(`projeto: ${p.name} (${p.uuid}) ambientes: ${envs || "-"}`);
  }
  const apps = await api("/applications");
  for (const a of apps) console.log(`  app: ${a.name} (${a.uuid}) fqdn=${a.fqdn ?? "-"} status=${a.status ?? "-"} repo=${a.git_repository ?? a.docker_registry_image_name ?? "-"}@${a.git_branch ?? "-"}`);
  const dbs = await api("/databases");
  for (const d of dbs) console.log(`  db: ${d.name} (${d.uuid}) tipo=${d.database_type ?? d.type ?? "-"} status=${d.status ?? "-"}`);
  const services = await api("/services").catch(() => []);
  for (const s of services) console.log(`  service: ${s.name} (${s.uuid}) status=${s.status ?? "-"}`);
  const keys = await api("/security/keys").catch(() => []);
  for (const k of keys) console.log(`  chave ssh: ${k.name} (${k.uuid})`);
}

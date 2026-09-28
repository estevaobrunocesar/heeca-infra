// Repositórios da Heeca no GitHub.
//   node infra/github.mjs create   → cria os repositórios privados que faltarem
//   node infra/github.mjs list     → lista os que existem
// Lê infra/.env (GITHUB_TOKEN, GITHUB_OWNER). O token nunca é impresso.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { GITHUB_TOKEN: TOKEN, GITHUB_OWNER: OWNER } = process.env;
if (!TOKEN || !OWNER) { console.error("GITHUB_TOKEN/GITHUB_OWNER vazios em infra/.env"); process.exit(1); }

/** Pasta local → nome do repositório (privado). */
export const REPOS = [
  { dir: "heeca_site", name: "heeca-portal", description: "Portal heeca.com.br: site, prateleira de produtos, checkout, cobrança e área do cliente" },
  { dir: "heeca_ticket", name: "heeca-ticket", description: "Heeca Ticket: service desk multi-tenant" },
  { dir: "heeca schedule", name: "heeca-schedule", description: "Heeca Schedule: gestão odontológica multi-tenant" },
  { dir: "heeca_vendas", name: "heeca-vendas", description: "Heeca Vendas: PDV, estoque e financeiro para lojas" },
  { dir: "heeca_budget", name: "heeca-budget", description: "Heeca Budget: orçamentos por m² (Cloudflare Worker + KV)" },
  { dir: "heeca_cut", name: "heeca-barbershop", description: "Heeca Barbershop: agendamento com WhatsApp para barbearias e salões" },
  { dir: "heeca_nail", name: "heeca-nail", description: "Heeca Nail: gestão e agendamento com WhatsApp para Nail Designers" },
  { dir: "heeca_ink", name: "heeca-ink", description: "Heeca Ink: gestão para tatuadores e studios de tatuagem (orçamento, briefing, projeto, arte, sinal, sessões, WhatsApp)" },
  { dir: "heeca_move", name: "heeca-move", description: "Heeca Move: agenda, agendamento online, WhatsApp e planos de tratamento para fisioterapeutas e quiropraxistas" },
  { dir: "heeca_kids", name: "heeca-kids", description: "Heeca Kids: gestão de creche e educação infantil (matrícula, turma, rotina, frequência, financeiro, BI)" },
  { dir: "hecca_atelier", name: "heeca-atelier", description: "Heeca Atelier: costureiras, alfaiates, ateliês sob medida (orçamento, peça, prova, entrega)" },
  { dir: "heeca_make", name: "heeca-make", description: "Heeca Make: maquiagem para eventos e casamentos (orçamento, equipe, deslocamento, parcelas)" },
  { dir: "heeca_pet", name: "heeca-pet", description: "Heeca Pet: pet shops, banho e tosa, veterinários, hotel e adestramento" },
  { dir: "heeca_service", name: "heeca-service", description: "Heeca Service: ordem de serviço para eletricistas, encanadores, técnicos e afins" },
  { dir: "heeca_piercing", name: "heeca-piercing", description: "Heeca Piercing: gestão, agendamento e atendimento para studios de piercing (joias, consentimento, registro, orçamento, retorno)" },
  { dir: "heeca_nutri", name: "heeca-nutri", description: "Heeca Nutri: agenda, plano alimentar, biblioteca de alimentos e receitas, antropometria e portal do paciente para nutricionistas" },
  { dir: "heeca_bronze", name: "heeca-bronze", description: "Heeca Bronze: gestão e agendamento para studios de bronzeamento (métodos, registro de sessão, produtos e estoque, pacotes, gift cards)" },
  { dir: "heeca_skin", name: "heeca-skin", description: "Heeca Skin: gestão e agendamento para esteticistas e studios de estética (avaliação, protocolos, planos e pacotes de sessões, WhatsApp, retorno)" },
  { dir: "brand", name: "heeca-brand", description: "Kit de marca Heeca (gerador do símbolo, logos, favicons)" },
];

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(init.body ? { "Content-Type": "application/json" } : {}) } });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const cmd = process.argv[2] ?? "list";
for (const r of REPOS) {
  const existing = await gh(`/repos/${OWNER}/${r.name}`);
  if (existing.status === 200) { console.log(`= ${r.name}  ${existing.json.private ? "privado" : "PÚBLICO"}  ${existing.json.ssh_url}`); continue; }
  if (cmd !== "create") { console.log(`- ${r.name} (não existe)`); continue; }
  const created = await gh("/user/repos", { method: "POST", body: JSON.stringify({ name: r.name, description: r.description, private: true, has_issues: true, has_wiki: false, auto_init: false }) });
  if (created.status === 201) console.log(`+ ${r.name} criado  ${created.json.ssh_url}`);
  else console.log(`! ${r.name}: ${created.status} ${created.json.message ?? ""} ${JSON.stringify(created.json.errors ?? "")}`);
}

// Monitor de uptime da plataforma Heeca (Cloudflare Worker, cron a cada 5 min).
//
// Para cada alvo: GET com timeout de 15 s; "up" = HTTP 200 e, quando o corpo é JSON, `ok !== false`
// e `status !== "degraded"`. O estado anterior fica no KV; e-mail (API do Resend) só quando muda:
// up → down (confirmado em 2 rodadas seguidas, para não alertar por um soluço) e down → up.
// GET https://status.heeca.com.br devolve o quadro atual em JSON.

const ALVOS = [
  { nome: "Portal", url: "https://heeca.com.br/api/health" },
  { nome: "Ticket", url: "https://ticket.heeca.com.br/api/health" },
  { nome: "Dental", url: "https://dental.heeca.com.br/api/health" },
  { nome: "Store", url: "https://store.heeca.com.br/api/health" },
  { nome: "Wellness", url: "https://wellness.heeca.com.br/api/health" },
  { nome: "Beauty", url: "https://beauty.heeca.com.br/api/health" },
  { nome: "Ink", url: "https://ink.heeca.com.br/api/health" },
  { nome: "Piercing", url: "https://piercing.heeca.com.br/api/health" },
  { nome: "Move", url: "https://move.heeca.com.br/api/health" },
  { nome: "Mind", url: "https://mind.heeca.com.br/api/health" },
  { nome: "Notify", url: "https://notify.heeca.com.br/api/health" }, // degraded = fila parada
  { nome: "Invoice", url: "https://invoice.heeca.com.br/" },
  // CDNs públicas por produto (bucket R2 próprio de cada um; raiz de bucket vazio responde 404 e está de pé)
  { nome: "CDN Store", url: "https://cdn-store.heeca.com.br/", aceita: [200, 404] },
  { nome: "Coolify", url: "https://coolify.heeca.com.br/api/health", aceita: [200, 401, 404] }, // painel responde; a API exige token
];

const FALHAS_PARA_ALERTAR = 2;

async function sondar(alvo) {
  const inicio = Date.now();
  try {
    const r = await fetch(alvo.url, { headers: { "User-Agent": "HeecaMonitor/1.0 (+https://status.heeca.com.br)" }, signal: AbortSignal.timeout(15000), cf: { cacheTtl: 0 } });
    const ms = Date.now() - inicio;
    const aceita = alvo.aceita ?? [200];
    let detalhe = `HTTP ${r.status}`;
    let up = aceita.includes(r.status);
    let degradado = false;
    const ct = r.headers.get("content-type") ?? "";
    if (up && ct.includes("json")) {
      const j = await r.json().catch(() => null);
      if (j && j.ok === false) up = false;
      if (j && j.status === "degraded") { degradado = true; detalhe += ` · degraded (${Object.entries(j).filter(([k]) => !["ok", "status", "db"].includes(k)).map(([k, v]) => `${k}=${v}`).join(", ")})`; }
    }
    return { up, degradado, ms, detalhe };
  } catch (e) {
    return { up: false, degradado: false, ms: Date.now() - inicio, detalhe: e?.name === "TimeoutError" ? "timeout 15 s" : String(e?.message ?? e) };
  }
}

async function enviar(env, assunto, texto) {
  if (!env.RESEND_API_KEY) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.ALERT_FROM, to: env.ALERT_TO.split(",").map((s) => s.trim()), subject: `[Heeca] ${assunto}`, text: texto }),
  }).catch(() => {});
}

async function rodada(env) {
  const agora = new Date().toISOString();
  const anterior = (await env.ESTADO.get("estado", "json")) ?? {};
  const estado = {};
  const avisos = [];

  const resultados = await Promise.all(ALVOS.map(async (a) => [a, await sondar(a)]));
  for (const [alvo, r] of resultados) {
    const ant = anterior[alvo.nome] ?? { falhas: 0, alertado: false, degradado: false };
    const falhas = r.up ? 0 : ant.falhas + 1;
    let alertado = ant.alertado;

    if (!r.up && falhas >= FALHAS_PARA_ALERTAR && !alertado) {
      avisos.push({ assunto: `${alvo.nome} FORA DO AR`, texto: `${alvo.nome} não responde há ${falhas} verificações (${alvo.url}).\n${r.detalhe}\n\nQuadro: https://status.heeca.com.br` });
      alertado = true;
    }
    if (r.up && alertado) {
      avisos.push({ assunto: `${alvo.nome} voltou`, texto: `${alvo.nome} respondeu de novo (${r.detalhe}, ${r.ms} ms).` });
      alertado = false;
    }
    if (r.up && r.degradado && !ant.degradado) avisos.push({ assunto: `${alvo.nome} degradado`, texto: `${alvo.nome} está de pé mas sinaliza problema: ${r.detalhe}` });
    if (r.up && !r.degradado && ant.degradado) avisos.push({ assunto: `${alvo.nome} normalizou`, texto: `${alvo.nome} deixou de sinalizar degradação.` });

    estado[alvo.nome] = { url: alvo.url, up: r.up, degradado: r.up && r.degradado, ms: r.ms, detalhe: r.detalhe, falhas, alertado, desde: r.up === (ant.up ?? true) ? (ant.desde ?? agora) : agora, verificadoEm: agora };
  }

  await env.ESTADO.put("estado", JSON.stringify(estado));
  for (const a of avisos) await enviar(env, a.assunto, a.texto);
  return { estado, avisos };
}

export default {
  async scheduled(_evento, env, ctx) {
    ctx.waitUntil(rodada(env));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/rodar" && req.headers.get("authorization") === `Bearer ${env.RESEND_API_KEY}`) {
      // Disparo manual (teste): mesma rodada do cron. Protegido pelo mesmo segredo para não virar alvo de spam.
      return Response.json(await rodada(env));
    }
    const estado = (await env.ESTADO.get("estado", "json")) ?? {};
    const tudoOk = Object.values(estado).every((s) => s.up && !s.degradado);
    return Response.json({ ok: tudoOk, geradoEm: new Date().toISOString(), servicos: estado }, { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  },
};

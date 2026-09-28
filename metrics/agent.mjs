// Agente de métricas do servidor heeca-prod (Node puro, sem dependências).
// Roda num container na rede interna "coolify" (sem porta publicada); o portal lê em
// http://heeca-metrics:9100/metrics com Authorization: Bearer METRICS_TOKEN (infra/metrics/install.sh).
// Lê /host/proc (CPU, memória, load, uptime), o disco de /host e o Docker pelo socket (containers, CPU e memória de cada um).
import http from "node:http";
import { readFileSync } from "node:fs";
import { statfs } from "node:fs/promises";

const PORT = Number(process.env.PORT ?? 9100);
const TOKEN = process.env.METRICS_TOKEN ?? "";
const HOST = process.env.HOST_ROOT ?? "/host";
const CACHE_MS = 15_000;

// ---------- /proc ----------
function cpuTimes() {
  const l = readFileSync(`${HOST}/proc/stat`, "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = l[3] + l[4]; const total = l.reduce((a, b) => a + b, 0);
  return { idle, total };
}
async function cpuPercent() {
  const a = cpuTimes(); await new Promise((r) => setTimeout(r, 500)); const b = cpuTimes();
  const dt = b.total - a.total; return dt > 0 ? Math.round((1 - (b.idle - a.idle) / dt) * 1000) / 10 : 0;
}
function meminfo() {
  const m = Object.fromEntries(readFileSync(`${HOST}/proc/meminfo`, "utf8").split("\n").filter(Boolean).map((l) => { const [k, v] = l.split(":"); return [k.trim(), parseInt(v) * 1024]; }));
  return { total: m.MemTotal, available: m.MemAvailable, used: m.MemTotal - m.MemAvailable, swapTotal: m.SwapTotal ?? 0, swapUsed: (m.SwapTotal ?? 0) - (m.SwapFree ?? 0) };
}
const loadavg = () => readFileSync(`${HOST}/proc/loadavg`, "utf8").trim().split(/\s+/).slice(0, 3).map(Number);
const uptime = () => Math.floor(parseFloat(readFileSync(`${HOST}/proc/uptime`, "utf8")));
const cores = () => readFileSync(`${HOST}/proc/cpuinfo`, "utf8").split("\n").filter((l) => l.startsWith("processor")).length;

// ---------- Docker (socket) ----------
function docker(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: "/var/run/docker.sock", path, method: "GET" }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on("error", reject); req.setTimeout(8000, () => req.destroy(new Error("timeout"))); req.end();
  });
}
function statsToUsage(s) {
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const n = s.cpu_stats?.online_cpus ?? 1;
  const cpu = sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * n * 1000) / 10 : 0;
  const mem = (s.memory_stats?.usage ?? 0) - (s.memory_stats?.stats?.inactive_file ?? 0);
  return { cpu, mem };
}
async function containers() {
  const list = await docker("/containers/json?all=1");
  const out = [];
  await Promise.all(list.map(async (c) => {
    const name = (c.Names?.[0] ?? "").replace(/^\//, "");
    const labels = c.Labels ?? {};
    let usage = { cpu: 0, mem: 0 };
    if (c.State === "running") { try { usage = statsToUsage(await docker(`/containers/${c.Id}/stats?stream=false`)); } catch { /* container saiu no meio */ } }
    const health = /\((healthy|unhealthy|starting)\)/.exec(c.Status ?? "")?.[1] ?? null;
    out.push({ name, resource: labels["coolify.resourceName"] ?? labels["coolify.name"] ?? null, kind: labels["coolify.databaseId"] ? "database" : labels["coolify.applicationId"] ? "application" : name === "coolify" || name.startsWith("coolify-") ? "coolify" : "other", state: c.State, status: c.Status, health, image: c.Image, ...usage });
  }));
  return out.sort((a, b) => b.mem - a.mem);
}

// ---------- coleta com cache ----------
let cache = { at: 0, data: null };
async function collect() {
  if (Date.now() - cache.at < CACHE_MS && cache.data) return cache.data;
  const [cpu, disk, conts] = await Promise.all([cpuPercent(), statfs(HOST), containers()]);
  const data = {
    at: new Date().toISOString(),
    host: { cores: cores(), cpuPercent: cpu, load: loadavg(), uptimeSec: uptime(), mem: meminfo(), disk: { total: disk.blocks * disk.bsize, free: disk.bavail * disk.bsize, used: (disk.blocks - disk.bfree) * disk.bsize } },
    containers: conts,
    summary: { total: conts.length, running: conts.filter((c) => c.state === "running").length, unhealthy: conts.filter((c) => c.health === "unhealthy").length, building: conts.filter((c) => c.kind === "other" && c.state === "running" && !c.resource).length },
  };
  cache = { at: Date.now(), data };
  return data;
}

http.createServer(async (req, res) => {
  if (req.url !== "/metrics") { res.writeHead(404); return res.end(); }
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end(); }
  try {
    const data = await collect();
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
}).listen(PORT, () => console.log(`[metrics] ouvindo em :${PORT}`));

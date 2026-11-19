// LabXpro Bridge — runs on the lab computer the analyzers are connected to.
//   node src/main.js [path/to/bridge.config.json]
// Reads bridge.config.json (server + one machine key per analyzer), gets each machine's settings
// from LabXpro, listens to the analyzers and sends their results. Status page: http://localhost:4545
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { makeCloud, sendOutcome, VERSION } from "./cloud.js";
import { Queue, drain } from "./queue.js";
import { MachineDriver } from "./driver.js";
import { log, setLogDir } from "./log.js";

const configPath = path.resolve(process.argv[2] || "bridge.config.json");
if (!fs.existsSync(configPath)) {
  console.error(`No settings file at ${configPath}. Copy bridge.config.example.json to bridge.config.json and paste your machine keys.`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const home = path.dirname(configPath);
setLogDir(path.resolve(home, cfg.logDir || "logs"));
const keys = (cfg.machines || []).filter((m) => /^mk_/.test(m?.key || ""));
if (!cfg.server || !keys.length) {
  console.error('bridge.config.json needs "server" (e.g. https://www.labxpro.in) and at least one machine key (mk_…).');
  process.exit(1);
}

const cloud = makeCloud(cfg.server);
const queue = new Queue(path.resolve(home, cfg.dataDir || "data"));
const net = { ok: null, lastSent: null, lastError: "" };

// Results go out through one loop: right after a result, and every 15 s for anything left from a power or internet cut
let draining = false;
let again = false;
async function sendQueued() {
  if (draining) { again = true; return; }
  draining = true;
  try {
    do {
      again = false;
      await drain(queue, async (rec) => {
        const d = drivers.find((x) => x.id === rec.machineKeyId);
        if (!d) return { drop: true, reason: "machine key no longer in bridge.config.json" };
        const res = await cloud.result(d.key, rec);
        const out = sendOutcome(res);
        net.ok = !out.retry;
        if (out.ok) net.lastSent = new Date().toISOString();
        else { net.lastError = res.message || `HTTP ${res.status}`; log("warn", `send ${rec.sampleId}: ${net.lastError}`); }
        return out;
      });
    } while (again);
  } finally {
    draining = false;
  }
}

const drivers = keys.map((m) => new MachineDriver(m, { cloud, queue, rawLogOn: cfg.rawLog !== false, onQueued: sendQueued }));
log("info", `LabXpro Bridge ${VERSION} starting: ${drivers.length} machine(s), server ${cfg.server}`);
for (const d of drivers) d.start().catch((e) => log("error", `[${d.name}]`, e));
setInterval(sendQueued, 15_000);
sendQueued();

// ── Status page (this computer only) ──
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function status() {
  return {
    version: VERSION, server: cfg.server, internet: net.ok === null ? "checking" : net.ok ? "ok" : "offline", lastSent: net.lastSent, lastError: net.lastError,
    waiting: queue.size(), refused: queue.failedCount(),
    machines: drivers.map((d) => ({ ...d.status, protocol: d.cfg?.protocol || "", hostQuery: !!d.cfg?.hostQuery })),
  };
}
const port = Number(cfg.statusPort) || 4545;
http.createServer((req, res) => {
  const s = status();
  if (req.url === "/status") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(s)); }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="10"><title>LabXpro Bridge</title>
<style>body{font:14px system-ui;margin:24px;color:#151628;background:#f7f7fb}table{border-collapse:collapse;background:#fff;width:100%}td,th{border:1px solid #e2e8f0;padding:8px;text-align:left}.ok{color:#047857}.bad{color:#b91c1c}</style>
<h1>LabXpro Bridge ${esc(s.version)}</h1>
<p>Server: ${esc(s.server)} · Internet: <b class="${s.internet === "ok" ? "ok" : "bad"}">${esc(s.internet)}</b>${s.lastSent ? ` · last sent ${esc(new Date(s.lastSent).toLocaleString())}` : ""}</p>
<p>Results waiting to be sent: <b>${s.waiting}</b>${s.refused ? ` · refused by LabXpro: <b class="bad">${s.refused}</b> (see the data/failed folder)` : ""}${s.lastError && s.internet !== "ok" ? ` · <span class="bad">${esc(s.lastError)}</span>` : ""}</p>
<table><tr><th>Machine</th><th>Connection</th><th>Protocol</th><th>Results</th><th>Last sample</th><th>Problem</th></tr>
${s.machines.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.state)}</td><td>${esc(m.protocol.toUpperCase())}${m.hostQuery ? " + asks for tests" : ""}</td><td>${m.results} (queries ${m.queries})</td><td>${esc(m.lastSampleId)} ${m.lastAt ? esc(new Date(m.lastAt).toLocaleTimeString()) : ""}</td><td class="bad">${esc(m.error)}</td></tr>`).join("")}
</table><p style="color:#64748b">This page refreshes every 10 seconds. Logs are in the logs folder.</p>`);
}).listen(port, "127.0.0.1", () => log("info", `status page: http://localhost:${port}`))
  .on("error", (e) => log("warn", `status page not started: ${e.message}`));

process.on("SIGINT", () => { drivers.forEach((d) => d.stop()); process.exit(0); });
process.on("uncaughtException", (e) => log("error", "unexpected:", e?.stack || e));
process.on("unhandledRejection", (e) => log("error", "unexpected:", e?.stack || e));

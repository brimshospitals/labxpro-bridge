// One analyzer: its settings from LabXpro, the wire (serial / LAN), the protocol, results into the
// queue, and answers to host queries ("which tests for this tube?").
import { createHash } from "node:crypto";
import { openTransport } from "./transport.js";
import { AstmReceiver, parseAstm, buildFrames, buildQueryReply as astmQueryReply, ENQ, ACK, NAK, EOT } from "./astm.js";
import { MllpReceiver, parseHl7, hl7Results, hl7QuerySample, buildAck, buildQueryReply as hl7QueryReply, frame } from "./hl7.js";
import { TextReceiver, parseText } from "./text.js";
import { log, rawLog } from "./log.js";

export const keyId = (key) => createHash("sha256").update(String(key)).digest("hex").slice(0, 12);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CONFIG_EVERY = 10 * 60_000;
const HEARTBEAT_EVERY = 60_000;

export class MachineDriver {
  /** m = { key, connection?, text? } from bridge.config.json (connection here overrides LabXpro's) */
  constructor(m, { cloud, queue, rawLogOn = true, onQueued = () => {} }) {
    this.key = m.key;
    this.id = keyId(m.key);
    this.local = m;
    this.cloud = cloud;
    this.queue = queue;
    this.rawLogOn = rawLogOn;
    this.onQueued = onQueued;
    this.cfg = null;
    this.link = null;
    this.status = { name: m.label || `machine ${this.id}`, state: "starting", results: 0, queries: 0, lastSampleId: "", lastAt: null, error: "" };
    this.timers = [];
    this.sending = null;   // ASTM: our own transmission (host query answer) waiting for ACKs
  }

  get name() { return this.status.name; }

  async start() {
    await this.loadConfig();
    this.timers.push(setInterval(() => this.loadConfig(), CONFIG_EVERY));
    this.timers.push(setInterval(() => this.cloud.heartbeat(this.key), HEARTBEAT_EVERY));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.link?.close();
  }

  async loadConfig() {
    const r = await this.cloud.config(this.key);
    if (!r.success) {
      this.status.error = r.message || "LabXpro did not give the settings";
      log("warn", `[${this.name}] config: ${this.status.error}`);
      if (!this.cfg) setTimeout(() => this.loadConfig(), 30_000);
      return;
    }
    const cfg = { ...r.data, connection: { ...r.data.connection, ...(this.local.connection || {}) } };
    this.status.name = this.local.label && this.local.label !== cfg.name ? `${cfg.name} (${this.local.label})` : cfg.name;
    this.status.error = "";
    const changed = !this.cfg || JSON.stringify([this.cfg.protocol, this.cfg.connection]) !== JSON.stringify([cfg.protocol, cfg.connection]);
    this.cfg = cfg;
    if (changed) this.open();
  }

  open() {
    this.link?.close();
    const proto = this.cfg.protocol;
    const write = (buf) => { if (this.rawLogOn) rawLog(this.name, "->", buf); this.link?.write(buf); };
    this.write = write;
    if (proto === "hl7") {
      this.rx = new MllpReceiver({ onMessage: (t) => this.onHl7(t) });
    } else if (proto === "text") {
      this.rx = new TextReceiver({ onMessage: (t) => this.handle(parseText(t, this.local.text || {}), t) });
    } else {
      this.rx = new AstmReceiver({ reply: (b) => write(Buffer.from([b])), onMessage: (t) => this.handle(parseAstm(t), t) });
    }
    this.link = openTransport(this.cfg.connection, {
      name: this.name,
      onState: (s) => { this.status.state = s; },
      onData: (buf) => {
        if (this.rawLogOn) rawLog(this.name, "<-", buf);
        if (this.sending) buf = this.takeAcks(buf);
        if (buf.length) this.rx.feed(buf);
      },
    });
    log("info", `[${this.name}] ${proto.toUpperCase()} over ${this.cfg.connection.type === "tcp" ? `LAN port ${this.cfg.connection.tcpPort}` : this.cfg.connection.port}`);
  }

  /** Results to the queue; host queries answered. */
  async handle({ results, queries }, raw) {
    for (const r of results) {
      if (!r.values.length) continue;
      const sampleId = r.sampleId || "NO-ID";
      this.queue.add({ machineKeyId: this.id, sampleId, values: r.values, raw: String(raw).slice(0, 60_000) });
      this.status.results++;
      this.status.lastSampleId = sampleId;
      this.status.lastAt = new Date().toISOString();
      log("info", `[${this.name}] result ${sampleId}: ${r.values.length} values queued`);
    }
    if (results.length) this.onQueued();
    for (const sampleId of queries) await this.answerAstmQuery(sampleId);
  }

  async lookup(sampleId) {
    this.status.queries++;
    const r = await this.cloud.orders(this.key, sampleId);
    if (!r.success) { log("warn", `[${this.name}] query ${sampleId}: ${r.message}`); return null; }
    log("info", `[${this.name}] query ${sampleId}: ${r.data.found ? r.data.tests.map((t) => t.code).join(",") || "no tests for this machine" : "not found"}`);
    return r.data.found ? r.data : null;
  }

  async answerAstmQuery(sampleId) {
    const order = this.cfg.hostQuery ? await this.lookup(sampleId) : null;
    await this.sendAstm(buildFrames(astmQueryReply(sampleId, order)));
  }

  // ── ASTM: our side talks (ENQ, frames, EOT), each step waits for the analyzer's ACK ──
  takeAcks(buf) {
    const rest = [];
    for (const b of buf) {
      if (this.sending?.waiting && (b === ACK || b === NAK)) { this.sending.waiting(b); continue; }
      // The analyzer starts talking at the same time: it goes first (its ENQ still reaches the receiver)
      if (this.sending?.waiting && b === ENQ) this.sending.waiting(b);
      rest.push(b);
    }
    return Buffer.from(rest);
  }

  waitByte(ms = 15_000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.sending.waiting = null; resolve(null); }, ms);
      this.sending.waiting = (b) => { clearTimeout(t); this.sending.waiting = null; resolve(b); };
    });
  }

  async sendAstm(frames) {
    await wait(200);   // let the analyzer finish its EOT
    this.sending = { waiting: null };
    let established = false;
    try {
      this.write(Buffer.from([ENQ]));
      const first = await this.waitByte();
      if (first !== ACK) { log("warn", `[${this.name}] analyzer did not accept our answer (${first === ENQ ? "it is sending" : "no ACK"})`); return false; }
      established = true;
      for (const f of frames) {
        let ok = false;
        for (let attempt = 0; attempt < 6 && !ok; attempt++) {
          this.write(f);
          ok = (await this.waitByte()) === ACK;
        }
        if (!ok) { log("warn", `[${this.name}] frame not accepted, answer stopped`); return false; }
      }
      return true;
    } finally {
      if (established) this.write(Buffer.from([EOT]));
      this.sending = null;
    }
  }

  // ── HL7 ──
  async onHl7(text) {
    const msg = parseHl7(text);
    if (msg.type.startsWith("ACK")) return;   // analyzer acknowledging our answer
    if (msg.type.startsWith("QRY") || msg.type.startsWith("QBP")) {
      const sampleId = hl7QuerySample(msg);
      const order = this.cfg.hostQuery && sampleId ? await this.lookup(sampleId) : null;
      for (const m of hl7QueryReply(msg, sampleId, order)) this.write(frame(m));
      return;
    }
    const results = hl7Results(msg);
    this.write(frame(buildAck(msg, "AA")));
    await this.handle({ results, queries: [] }, text);
  }
}

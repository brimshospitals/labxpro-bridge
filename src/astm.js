// ASTM E1381 (low level: ENQ / frames / checksum / EOT) and E1394 (records H P O R Q L).
// Pure code: no ports here. lib/driver.js connects it to a serial or TCP link.

export const ENQ = 0x05, ACK = 0x06, NAK = 0x15, EOT = 0x04, STX = 0x02, ETX = 0x03, ETB = 0x17, CR = 0x0d, LF = 0x0a;
const MAX_FRAME_TEXT = 240;

/** Checksum of a frame: sum of bytes from the frame number through ETB/ETX, mod 256, as two hex digits. */
export function checksum(body) {
  let sum = 0;
  for (const ch of Buffer.from(body, "latin1")) sum = (sum + ch) % 256;
  return sum.toString(16).toUpperCase().padStart(2, "0");
}

/** Records → frames to send (each record ends with CR; long records are split with ETB). */
export function buildFrames(records) {
  const frames = [];
  let fn = 1;
  for (const rec of records) {
    const text = `${rec}\r`;
    for (let i = 0; i < text.length; i += MAX_FRAME_TEXT) {
      const part = text.slice(i, i + MAX_FRAME_TEXT);
      const end = i + MAX_FRAME_TEXT >= text.length ? "\x03" : "\x17";
      const body = `${fn}${part}${end}`;
      frames.push(Buffer.from(`\x02${body}${checksum(body)}\r\n`, "latin1"));
      fn = (fn + 1) % 8;
    }
  }
  return frames;
}

/**
 * Receives bytes from an analyzer. Calls reply(byte) for ACK/NAK and onMessage(text) at EOT.
 * Also accepts analyzers that send plain records without the low-level framing (H|… … L|…).
 */
export class AstmReceiver {
  constructor({ reply, onMessage }) {
    this.reply = reply;
    this.onMessage = onMessage;
    this.buf = Buffer.alloc(0);
    this.text = "";
    this.inSession = false;
    this.plain = "";
  }

  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (!this.buf.length) return;
      const b = this.buf[0];
      if (b === ENQ) { this.buf = this.buf.subarray(1); this.inSession = true; this.text = ""; this.reply(ACK); continue; }
      if (b === EOT) {
        this.buf = this.buf.subarray(1);
        if (this.inSession && this.text) this.onMessage(this.text);
        this.inSession = false; this.text = "";
        continue;
      }
      if (b === STX) {
        const end = this.buf.indexOf(LF);
        if (end < 0) { if (this.buf.length > 64 * 1024) this.buf = Buffer.alloc(0); return; }   // wait for the rest
        const frame = this.buf.subarray(0, end + 1).toString("latin1");
        this.buf = this.buf.subarray(end + 1);
        const m = /^\x02([0-7])([\s\S]*)([\x03\x17])([0-9A-Fa-f]{2})\r\n$/.exec(frame);
        if (!m || checksum(`${m[1]}${m[2]}${m[3]}`) !== m[4].toUpperCase()) { this.reply(NAK); continue; }
        this.text += m[2];
        this.reply(ACK);
        continue;
      }
      if (b === ACK || b === NAK || b === CR || b === LF) { this.buf = this.buf.subarray(1); continue; }
      // No framing: collect plain records until the terminator record (L|…)
      const nl = this.buf.indexOf(CR);
      if (nl < 0) { if (this.buf.length > 64 * 1024) this.buf = Buffer.alloc(0); return; }
      const line = this.buf.subarray(0, nl).toString("latin1").replace(/^[\n\x00-\x1f]+/, "");
      this.buf = this.buf.subarray(nl + 1);
      if (/^H\|/.test(line)) this.plain = "";
      this.plain += `${line}\r`;
      if (/^L\|/.test(line)) { this.onMessage(this.plain); this.plain = ""; }
    }
  }
}

/** Split a message into records with its delimiters (taken from the H record: H|\^&). */
export function parseRecords(text) {
  const lines = String(text).split(/\r\n?|\n/).map((l) => l.replace(/^[\x00-\x1f]+/, "")).filter(Boolean);
  const h = lines.find((l) => /^\d?H/.test(l));
  const field = h ? h.replace(/^\d/, "")[1] : "|";
  const comp = h && h.replace(/^\d/, "")[4] === "&" ? h.replace(/^\d/, "")[3] : "^";
  const repeat = h ? h.replace(/^\d/, "")[2] : "\\";
  // Some analyzers repeat the frame number at the start of each record ("1H|…")
  return {
    field, comp, repeat,
    records: lines.map((l) => l.replace(/^\d(?=[HPOQRCML]\|)/, "")).map((l) => l.split(field)),
  };
}

const comps = (f, c) => String(f ?? "").split(c).map((x) => x.trim());
const firstFilled = (arr, from = 0) => arr.slice(from).find(Boolean) || arr.find(Boolean) || "";

/**
 * Results and host queries in one message.
 * results: [{ sampleId, values: [{ code, value, unit, flag }] }]   queries: [sampleId]
 */
export function parseAstm(text) {
  const { comp, repeat, records } = parseRecords(text);
  const results = [];
  const queries = [];
  let current = null;
  for (const r of records) {
    const type = r[0];
    if (type === "O") {
      // O.3 specimen ID (as given by the lab); O.4 the analyzer's own ID (Sysmex puts the barcode in its 3rd part)
      const o3 = comps(r[2], comp);
      const o4 = comps(r[3], comp);
      const sampleId = firstFilled(o3) || o4[2] || firstFilled(o4);
      current = { sampleId: sampleId.replace(/\s+/g, ""), values: [] };
      results.push(current);
    } else if (type === "R") {
      if (!current) { current = { sampleId: "", values: [] }; results.push(current); }
      const id = comps(r[2], comp);
      const code = firstFilled(id, 3);
      const value = comps(r[3], comp)[0] ?? "";
      if (code && value !== "") current.values.push({ code, value, unit: comps(r[4], comp)[0] || "", flag: comps(r[6], comp)[0] || "" });
    } else if (type === "Q") {
      // Q.3 starting range ID: "^261119001A" or "patient^sample"; several may repeat
      for (const one of String(r[2] ?? "").split(repeat)) {
        const c = comps(one, comp);
        const id = (c[1] || c[0] || "").replace(/\s+/g, "");
        if (id && id.toUpperCase() !== "ALL") queries.push(id);
      }
    }
  }
  return { results: results.filter((x) => x.sampleId || x.values.length), queries };
}

const esc = (s) => String(s ?? "").replace(/[|\\^&\r\n]/g, " ").trim();
const ts = (d = new Date()) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14);

/**
 * Reply to a host query: the tests to run on this tube (from LabXpro), or "no information".
 * order = { sampleId, tests: [{ code }], patient: { name, age, sex } } | null
 */
export function buildQueryReply(sampleId, order) {
  const recs = [`H|\\^&|||LabXpro^Bridge|||||||P|1|${ts()}`];
  if (order && order.tests?.length) {
    const p = order.patient || {};
    recs.push(`P|1||${esc(sampleId)}||${esc(p.name)}||||${p.sex === "M" || p.sex === "F" ? p.sex : "U"}`);
    recs.push(`O|1|${esc(sampleId)}||${order.tests.map((t) => `^^^${esc(t.code)}`).join("\\")}|R||||||A||||||||||||||O`);
    recs.push("L|1|N");
  } else {
    recs.push("L|1|I");   // no information for this sample
  }
  return recs;
}

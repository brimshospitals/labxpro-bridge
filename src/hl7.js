// HL7 v2.x over MLLP (0x0B … 0x1C 0x0D): results (ORU^R01), acknowledgements, and the
// Mindray-style host query (QRY^Q02 → QCK^Q02 + DSR^Q03). Pure code, no ports.

export const SB = 0x0b, EB = 0x1c, CR = 0x0d;

/** Collects MLLP-framed messages from a byte stream. */
export class MllpReceiver {
  constructor({ onMessage }) {
    this.onMessage = onMessage;
    this.buf = Buffer.alloc(0);
  }
  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const start = this.buf.indexOf(SB);
      if (start < 0) { this.buf = Buffer.alloc(0); return; }
      const end = this.buf.indexOf(EB, start + 1);
      if (end < 0) { if (this.buf.length > 4 * 1024 * 1024) this.buf = Buffer.alloc(0); return; }
      const msg = this.buf.subarray(start + 1, end).toString("utf8");
      this.buf = this.buf.subarray(end + 1);
      if (this.buf[0] === CR) this.buf = this.buf.subarray(1);
      if (msg.trim()) this.onMessage(msg);
    }
  }
}

export const frame = (msg) => Buffer.concat([Buffer.from([SB]), Buffer.from(msg, "utf8"), Buffer.from([EB, CR])]);

/** Segments as arrays of fields. For MSH, index n is MSH-(n+1); for every other segment, index n is SEG-n. */
export function parseHl7(text) {
  const segs = String(text).split(/\r\n?|\n/).filter(Boolean).map((l) => l.trim());
  const msh = segs.find((s) => s.startsWith("MSH")) || "MSH|^~\\&";
  const field = msh[3] || "|";
  const comp = msh[4] || "^";
  const segments = segs.map((s) => s.split(field));
  const mshF = segments.find((s) => s[0] === "MSH") || [];
  return { field, comp, segments, type: String(mshF[8] || "").split(comp).slice(0, 2).join("^"), controlId: mshF[9] || "", version: mshF[11] || "2.3.1",
    sendingApp: mshF[2] || "", sendingFacility: mshF[3] || "" };
}

const c = (f, comp, i = 0) => String(f ?? "").split(comp)[i]?.trim() || "";

/** Results of an ORU^R01 (or any message with OBR/OBX): [{ sampleId, values }] */
export function hl7Results(msg) {
  const { comp, segments } = msg;
  const out = [];
  let cur = null;
  for (const s of segments) {
    if (s[0] === "OBR") {
      // Filler order number (OBR-3) is where most analyzers put the sample barcode; placer (OBR-2) otherwise
      cur = { sampleId: (c(s[3], comp) || c(s[2], comp)).replace(/\s+/g, ""), values: [] };
      out.push(cur);
    } else if (s[0] === "SPM" && cur && !cur.sampleId) {
      cur.sampleId = c(s[2], comp).replace(/\s+/g, "");
    } else if (s[0] === "OBX") {
      if (!cur) { cur = { sampleId: "", values: [] }; out.push(cur); }
      if (["ED", "RP"].includes(c(s[2], comp))) continue;   // histograms / images
      const id = String(s[3] ?? "").split(comp);
      const code = (id[1] || id[0] || "").trim();             // "6690-2^WBC^LN" → WBC
      const value = c(s[5], comp);
      if (code && value !== "") cur.values.push({ code, value, unit: c(s[6], comp), flag: c(s[8], comp) });
    }
  }
  return out.filter((x) => x.sampleId || x.values.length);
}

/** Sample barcode asked in a host query (QRY^Q02: QRD-8; ORM / QBP: first ID found). */
export function hl7QuerySample(msg) {
  const { comp, segments } = msg;
  const qrd = segments.find((s) => s[0] === "QRD");
  if (qrd) return c(qrd[8], comp).replace(/\s+/g, "");
  const qpd = segments.find((s) => s[0] === "QPD");
  if (qpd) return c(qpd[3], comp).replace(/\s+/g, "");
  return "";
}

const ts = (d = new Date()) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
const esc = (s) => String(s ?? "").replace(/[|^~\\&\r\n]/g, " ").trim();
const header = (msg, type, id) => `MSH|^~\\&|LabXpro|Bridge|${esc(msg.sendingApp)}|${esc(msg.sendingFacility)}|${ts()}||${type}|${id}|P|${msg.version || "2.3.1"}||||0||ASCII|||`;

/** Acknowledge a message (AA = accepted, AE = error). */
export function buildAck(msg, code = "AA", text = "") {
  const type = msg.type.startsWith("QRY") ? "QCK^Q02" : `ACK^${msg.type.split("^")[1] || "R01"}`;
  return [header(msg, type, msg.controlId || ts()), `MSA|${code}|${esc(msg.controlId)}|${esc(text)}|||0|`].join("\r") + "\r";
}

/**
 * Host query answer, Mindray style: QCK^Q02 (found / not found) then DSR^Q03 with the tests.
 * order = { tests: [{ code, testName }], patient: { name, age, sex } } | null
 */
export function buildQueryReply(msg, sampleId, order) {
  const found = !!order?.tests?.length;
  const qck = [header(msg, "QCK^Q02", msg.controlId), `MSA|AA|${esc(msg.controlId)}|Message accepted|||0|`, "ERR|0|", `QAK|SR|${found ? "OK" : "NF"}|`].join("\r") + "\r";
  if (!found) return [qck];
  const p = order.patient || {};
  const dsp = [
    ["1", ""], ["2", ""], ["3", esc(p.name)], ["4", ""], ["5", p.sex === "M" ? "M" : p.sex === "F" ? "F" : "O"],
    ["21", esc(sampleId)], ["22", esc(sampleId)], ["23", ts()], ["24", "N"], ["26", "serum"],
  ].map(([n, v]) => `DSP|${n}||${v}|||`);
  order.tests.forEach((t, i) => dsp.push(`DSP|${29 + i}||${esc(t.code)}^${esc(t.testName || t.code)}^^^|||`));
  const dsr = [header(msg, "DSR^Q03", `${msg.controlId}1`), `MSA|AA|${esc(msg.controlId)}|Message accepted|||0|`, "ERR|0|", `QAK|SR|OK|`,
    `QRD|${ts()}|R|D|1|||RD|${esc(sampleId)}|OTH|||T|`, `QRF||||||RCT|COR|ALL||`, ...dsp, `DSC||`].join("\r") + "\r";
  return [qck, dsr];
}

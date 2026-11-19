// A pretend analyzer, for tests and for trying the bridge without a machine.
// Speaks ASTM (ENQ / frames / EOT, waits for ACKs) or HL7 (MLLP) over a TCP socket.
import net from "node:net";
import { buildFrames, AstmReceiver, parseRecords, ENQ, ACK, EOT } from "../src/astm.js";
import { MllpReceiver, frame } from "../src/hl7.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function connect(port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const s = net.connect({ port, host }, () => resolve(s));
    s.once("error", reject);
  });
}

/** Read single control bytes (ACK/NAK/ENQ/EOT) and framed text from the socket. */
function byteReader(socket) {
  const bytes = [];
  let waiter = null;
  socket.on("data", (buf) => { for (const b of buf) bytes.push(b); if (waiter) waiter(); });
  return {
    next(ms = 5000) {
      return new Promise((resolve) => {
        const take = () => { if (bytes.length) { clearTimeout(t); waiter = null; resolve(bytes.shift()); return true; } return false; };
        if (take()) return;
        const t = setTimeout(() => { waiter = null; resolve(null); }, ms);
        waiter = () => take();
      });
    },
    drainTo(receiver) { if (bytes.length) receiver.feed(Buffer.from(bytes.splice(0))); },
  };
}

const astmResult = (sampleId, values) => [
  "H|\\^&|||FakeAnalyzer^1.0|||||||P|1",
  "P|1",
  `O|1|${sampleId}||^^^ALL|R`,
  ...values.map((v, i) => `R|${i + 1}|^^^${v.code}^1|${v.value}|${v.unit || ""}||${v.flag || "N"}||F`),
  "L|1|N",
];
const astmQuery = (sampleId) => ["H|\\^&|||FakeAnalyzer^1.0|||||||P|1", `Q|1|^${sampleId}||^^^ALL||||||||O`, "L|1|N"];

/** Send one ASTM message like an analyzer would. Returns true when every frame was acknowledged. */
export async function sendAstm(socket, records, reader = byteReader(socket)) {
  socket.write(Buffer.from([ENQ]));
  if ((await reader.next()) !== ACK) return false;
  for (const f of buildFrames(records)) {
    socket.write(f);
    if ((await reader.next()) !== ACK) return false;
  }
  socket.write(Buffer.from([EOT]));
  return true;
}

export const astmSendResult = (socket, sampleId, values) => sendAstm(socket, astmResult(sampleId, values));

/** Ask for the tests of a tube and read the host's answer (the host sends ENQ … EOT back). */
export async function astmAskTests(socket, sampleId, ms = 10000) {
  const reader = byteReader(socket);
  if (!(await sendAstm(socket, astmQuery(sampleId), reader))) return null;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    const rx = new AstmReceiver({
      reply: (b) => socket.write(Buffer.from([b])),
      onMessage: (text) => { clearTimeout(t); resolve(parseRecords(text).records.map((r) => r.join("|"))); },
    });
    socket.on("data", (buf) => rx.feed(buf));
    reader.drainTo(rx);
  });
}

const hl7Ts = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
export function hl7Oru(sampleId, values, controlId = String(Date.now())) {
  return [
    `MSH|^~\\&|FakeAnalyzer|Lab|||${hl7Ts()}||ORU^R01|${controlId}|P|2.3.1||||0||ASCII|||`,
    "PID|1||||Test^Patient||19800101|M",
    `OBR|1||${sampleId}|^|||${hl7Ts()}`,
    ...values.map((v, i) => `OBX|${i + 1}|NM|${v.loinc || "0000-0"}^${v.code}^LN||${v.value}|${v.unit || ""}|||||F`),
  ].join("\r") + "\r";
}
export function hl7Qry(sampleId, controlId = String(Date.now())) {
  return [`MSH|^~\\&|FakeAnalyzer|Lab|||${hl7Ts()}||QRY^Q02|${controlId}|P|2.3.1||||0||ASCII|||`, `QRD|${hl7Ts()}|R|D|1|||RD|${sampleId}|OTH|||T|`, `QRF||||||RCT|COR|ALL||`].join("\r") + "\r";
}

/** Send an HL7 message and collect the replies for `ms`. */
export async function hl7Send(socket, msg, ms = 3000) {
  const replies = [];
  const rx = new MllpReceiver({ onMessage: (t) => replies.push(t) });
  const on = (buf) => rx.feed(buf);
  socket.on("data", on);
  socket.write(frame(msg));
  const end = Date.now() + ms;
  while (Date.now() < end) { await wait(100); if (msg.includes("QRY") ? replies.length >= 2 || replies.some((r) => /QAK\|SR\|NF/.test(r)) : replies.length >= 1) break; }
  socket.off("data", on);
  return replies;
}

// CLI: node tools/analyzer.js astm|hl7 --port 5100 --sample 261119001A [--values "WBC=7.8,HGB=13.5"] [--query]
if (process.argv[1] && process.argv[1].endsWith("analyzer.js")) {
  const [proto = "astm"] = process.argv.slice(2);
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
  const port = Number(arg("port", 5100));
  const sampleId = arg("sample", "261119001A");
  const values = String(arg("values", "WBC=7.8,HGB=13.5,PLT=250")).split(",").map((p) => { const [code, value] = p.split("="); return { code, value }; });
  const s = await connect(port, arg("host", "127.0.0.1"));
  if (proto === "hl7") {
    const replies = await hl7Send(s, process.argv.includes("--query") ? hl7Qry(sampleId) : hl7Oru(sampleId, values));
    console.log(replies.map((r) => r.replace(/\r/g, "\n")).join("\n---\n") || "no reply");
  } else if (process.argv.includes("--query")) {
    console.log((await astmAskTests(s, sampleId)) || "no reply");
  } else {
    console.log((await astmSendResult(s, sampleId, values)) ? "sent, every frame acknowledged" : "the bridge did not acknowledge");
  }
  s.end();
}

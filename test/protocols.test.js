// node --test test/   (from lims/bridge)
import { test } from "node:test";
import assert from "node:assert/strict";
import { checksum, buildFrames, AstmReceiver, parseAstm, buildQueryReply, ENQ, ACK, NAK, EOT } from "../src/astm.js";
import { MllpReceiver, frame, parseHl7, hl7Results, hl7QuerySample, buildAck, buildQueryReply as hl7Reply } from "../src/hl7.js";
import { parseText, TextReceiver } from "../src/text.js";

test("ASTM checksum matches the standard's example", () => {
  // "1" (0x31) + ETX (0x03) = 0x34; sums wrap at 256 and are two upper-case hex digits
  assert.equal(checksum("1\x03"), "34");
  assert.equal(checksum("\xff\x03"), "02");
  assert.equal(checksum("1\n\x03"), "3E");
});

test("ASTM frames: numbered 1..7,0, long records split with ETB, each with a checksum", () => {
  const long = `R|1|^^^X|${"9".repeat(500)}`;
  const frames = buildFrames(["H|\\^&", long, "L|1|N"]).map((b) => b.toString("latin1"));
  assert.equal(frames.length, 5);
  assert.deepEqual(frames.map((f) => f[1]), ["1", "2", "3", "4", "5"]);
  assert.equal(frames[1].at(-5), "\x17");   // ETB: record continues
  assert.equal(frames[3].at(-5), "\x03");
  for (const f of frames) {
    const m = /^\x02([\s\S]*)([0-9A-F]{2})\r\n$/.exec(f);
    assert.equal(checksum(m[1]), m[2]);
  }
});

function runReceiver(bytes) {
  const replies = [];
  const messages = [];
  const rx = new AstmReceiver({ reply: (b) => replies.push(b), onMessage: (t) => messages.push(t) });
  for (const b of bytes) rx.feed(b);
  return { replies, messages };
}

test("ASTM receiver: ENQ → ACK, good frames ACK, bad checksum NAK, message at EOT", () => {
  const recs = ["H|\\^&|||Sysmex", "O|1|261119001A||^^^ALL", "R|1|^^^WBC^1|7.82|10*3/uL||N", "R|2|^^^HGB^1|13.5|g/dL||N", "L|1|N"];
  const frames = buildFrames(recs);
  const bad = Buffer.from(frames[1]); bad[bad.length - 4] = 0x30; bad[bad.length - 3] = 0x30;   // wrong checksum "00"
  const { replies, messages } = runReceiver([Buffer.from([ENQ]), frames[0], bad, ...frames.slice(1), Buffer.from([EOT])]);
  assert.deepEqual(replies, [ACK, ACK, NAK, ACK, ACK, ACK, ACK]);
  assert.equal(messages.length, 1);
  const { results } = parseAstm(messages[0]);
  assert.deepEqual(results, [{ sampleId: "261119001A", values: [{ code: "WBC", value: "7.82", unit: "10*3/uL", flag: "N" }, { code: "HGB", value: "13.5", unit: "g/dL", flag: "N" }] }]);
});

test("ASTM receiver: bytes split anywhere still work", () => {
  const all = Buffer.concat([Buffer.from([ENQ]), ...buildFrames(["H|\\^&", "O|1|S1", "R|1|^^^GLU|112", "L|1|N"]), Buffer.from([EOT])]);
  const chunks = [];
  for (let i = 0; i < all.length; i += 3) chunks.push(all.subarray(i, i + 3));
  const { messages } = runReceiver(chunks);
  assert.equal(parseAstm(messages[0]).results[0].values[0].value, "112");
});

test("ASTM without low-level framing (plain records over LAN)", () => {
  const { messages } = runReceiver([Buffer.from("H|\\^&|||X\rP|1\rO|1|S9\rR|1|^^^NA|139\rL|1|N\r", "latin1")]);
  assert.deepEqual(parseAstm(messages[0]).results[0], { sampleId: "S9", values: [{ code: "NA", value: "139", unit: "", flag: "" }] });
});

test("ASTM: Sysmex puts the barcode in O.4 component 3; frame numbers before records are ignored", () => {
  const r = parseAstm("1H|\\^&|||XP-100\r2O|1||^^          261119001B^B|^^^^WBC\\^^^^RBC|||\r3R|1|^^^^WBC^1|6.5|10*3/uL||N\rL|1|N\r");
  assert.equal(r.results[0].sampleId, "261119001B");
  assert.equal(r.results[0].values[0].code, "WBC");
});

test("ASTM host query: sample ID read, answer lists the tests or says no information", () => {
  assert.deepEqual(parseAstm("H|\\^&\rQ|1|^261119001A||^^^ALL||||||||O\rL|1|N\r").queries, ["261119001A"]);
  const yes = buildQueryReply("261119001A", { tests: [{ code: "WBC" }, { code: "HGB" }], patient: { name: "Ramesh Kumar", sex: "M" } });
  assert.match(yes[2], /^O\|1\|261119001A\|\|\^\^\^WBC\\\^\^\^HGB\|R/);
  assert.match(yes[1], /Ramesh Kumar/);
  assert.equal(buildQueryReply("X", null).at(-1), "L|1|I");
  // A name with ASTM delimiters cannot break the record
  assert.doesNotMatch(buildQueryReply("S", { tests: [{ code: "A" }], patient: { name: "A|B^C" } })[1], /A\|B/);
});

const ORU = "MSH|^~\\&|BC-5150|Mindray|||20261119103000||ORU^R01|42|P|2.3.1||||0||ASCII|||\rPID|1||||Kumar^Ramesh\rOBR|1||261119001A|00001^Automated Count^99MRC\rOBX|1|NM|6690-2^WBC^LN||7.82|10*3/uL|4.00-10.00|N|||F\rOBX|2|ED|15000-7^WBC Histogram. BMP^99MRC||^Image^BMP^Base64^Qk02AAAA||||||F\rOBX|3|NM|718-7^HGB^LN||13.5|g/dL|11.0-16.0|N|||F\r";

test("HL7: MLLP frames split across chunks", () => {
  const got = [];
  const rx = new MllpReceiver({ onMessage: (m) => got.push(m) });
  const f = Buffer.concat([frame(ORU), frame(ORU)]);
  rx.feed(f.subarray(0, 50)); rx.feed(f.subarray(50, 300)); rx.feed(f.subarray(300));
  assert.equal(got.length, 2);
  assert.equal(got[0], ORU);
});

test("HL7 ORU: sample from OBR-3, codes from OBX-3 text, images skipped", () => {
  const msg = parseHl7(ORU);
  assert.equal(msg.type, "ORU^R01");
  assert.equal(msg.controlId, "42");
  assert.deepEqual(hl7Results(msg), [{ sampleId: "261119001A", values: [{ code: "WBC", value: "7.82", unit: "10*3/uL", flag: "N" }, { code: "HGB", value: "13.5", unit: "g/dL", flag: "N" }] }]);
  assert.match(buildAck(msg), /MSA\|AA\|42\|/);
  assert.match(buildAck(msg), /ACK\^R01/);
});

test("HL7 host query (Mindray QRY^Q02): sample from QRD-8, QCK then DSR with the tests", () => {
  const q = parseHl7("MSH|^~\\&|BS-240|Mindray|||20261119||QRY^Q02|7|P|2.3.1||||0||ASCII|||\rQRD|20261119|R|D|1|||RD|261119001B|OTH|||T|\rQRF||||||RCT|COR|ALL||\r");
  assert.equal(hl7QuerySample(q), "261119001B");
  const [qck, dsr] = hl7Reply(q, "261119001B", { tests: [{ code: "GLU", testName: "Glucose" }], patient: { name: "Ramesh", sex: "M" } });
  assert.match(qck, /QCK\^Q02/); assert.match(qck, /QAK\|SR\|OK/);
  assert.match(dsr, /DSR\^Q03/); assert.match(dsr, /DSP\|29\|\|GLU\^Glucose/); assert.match(dsr, /DSP\|21\|\|261119001B/);
  const none = hl7Reply(q, "X", null);
  assert.equal(none.length, 1); assert.match(none[0], /QAK\|SR\|NF/);
});

test("Text print-out: sample line then values; header lines skipped", () => {
  const t = "Erba Chem-5\r\nDate: 19/11/2026\r\nSample No: 261119001B\r\nGLU   112   mg/dL\r\nUREA: 32.5 mg/dL\r\nNA=139.2\r\n\r\nSample ID 261119002B\r\nCREA 1.1\r\n";
  assert.deepEqual(parseText(t).results, [
    { sampleId: "261119001B", values: [{ code: "GLU", value: "112", unit: "mg/dL", flag: "" }, { code: "UREA", value: "32.5", unit: "mg/dL", flag: "" }, { code: "NA", value: "139.2", unit: "", flag: "" }] },
    { sampleId: "261119002B", values: [{ code: "CREA", value: "1.1", unit: "", flag: "" }] },
  ]);
});

test("Text receiver waits until the port is quiet", async () => {
  const got = [];
  const rx = new TextReceiver({ onMessage: (t) => got.push(t), idleMs: 50 });
  rx.feed(Buffer.from("Sample: S1\n")); rx.feed(Buffer.from("GLU 100\n"));
  assert.equal(got.length, 0);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(got.length, 1);
});

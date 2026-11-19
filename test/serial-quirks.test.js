// Serial wire (with serialport's own mock port: no COM port or driver) and analyzer habits (quirks).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SerialPortMock } from "serialport";
import { useSerialPortClass } from "../src/transport.js";
import { MachineDriver } from "../src/driver.js";
import { Queue, drain } from "../src/queue.js";
import { makeCloud, sendOutcome } from "../src/cloud.js";
import { setLogDir } from "../src/log.js";
import { buildFrames, parseAstm, parseRecords, buildQueryReply, AstmReceiver, ENQ, ACK, EOT } from "../src/astm.js";
import { quirksFor } from "../src/quirks.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = "mk_serialtest_00000000000000000";

test("Sysmex host query: sample number from the 3rd part of Q.3", () => {
  assert.deepEqual(parseAstm("H|\\^&\rQ|1|^^          261119001A^B||^^^^WBC^1||||||||O\rL|1|N\r").queries, ["261119001A"]);
  assert.deepEqual(parseAstm("H|\\^&\rQ|1|P001^261119001B||^^^ALL\rL|1|N\r").queries, ["261119001B"]);
});

test("Sysmex answer: tests as ^^^^WBC^1, sample number in O.4", () => {
  const recs = buildQueryReply("261119001A", { tests: [{ code: "WBC" }, { code: "HGB" }] }, quirksFor("sysmex-xn"));
  const o = recs.find((r) => r.startsWith("O|")).split("|");
  assert.equal(o[2], "");
  assert.equal(o[3], "^^261119001A^B");
  assert.equal(o[4], "^^^^WBC^1\\^^^^HGB^1");
  // And our own parser reads it back the same way an analyzer would
  assert.equal(parseAstm(recs.join("\r")).results[0].sampleId, "261119001A");
});

test("Maglumi answer: one O record per assay; H/P/L when nothing is booked", () => {
  const recs = buildQueryReply("S1", { tests: [{ code: "TSH" }, { code: "T3" }] }, quirksFor("maglumi"));
  const os_ = recs.filter((r) => r.startsWith("O|"));
  assert.deepEqual(os_.map((r) => r.split("|")[4]), ["^^^TSH", "^^^T3"]);
  assert.deepEqual(os_.map((r) => r.split("|")[1]), ["1", "2"]);
  const none = buildQueryReply("S2", null, quirksFor("maglumi"));
  assert.deepEqual(none.slice(1), ["P|1", "L|1|N"]);
  // Other analyzers keep the standard "no information"
  assert.equal(buildQueryReply("S2", null).at(-1), "L|1|I");
});

test("Serial wire: an ASTM analyzer on COM9 sends a result and asks for tests", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-serial-"));
  setLogDir(path.join(dir, "logs"));
  SerialPortMock.binding.reset();
  SerialPortMock.binding.createPort("COM9", { echo: false, record: true });
  let opened = null;
  useSerialPortClass(class extends SerialPortMock { constructor(o) { super(o); opened = this; } });

  const sent = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const json = (status, body) => ({ status, json: async () => body });
    if (u.pathname.endsWith("/config")) return json(200, { success: true, data: { name: "XP-100", preset: "sysmex-xn", protocol: "astm", hostQuery: true, connection: { type: "serial", port: "COM9", baud: 9600 } } });
    if (u.pathname.endsWith("/orders")) return json(200, { success: true, data: { found: true, tests: [{ code: "WBC" }], patient: { name: "R K", sex: "M" } } });
    if (u.pathname.endsWith("/results")) { sent.push(JSON.parse(init.body)); return json(200, { success: true, data: {} }); }
    return json(200, { success: true, data: {} });
  };
  const cloud = makeCloud("http://labxpro.test", { fetchImpl });
  const queue = new Queue(path.join(dir, "data"));
  const d = new MachineDriver({ key: KEY }, { cloud, queue, onQueued: () => drain(queue, async (rec) => sendOutcome(await cloud.result(KEY, rec))) });
  try {
    await d.start();
    for (let i = 0; i < 50 && !opened?.isOpen; i++) await wait(20);
    assert.ok(opened?.isOpen, "COM9 opened");
    assert.equal(opened.baudRate, 9600);
    assert.match(d.status.state, /COM9 open at 9600/);
    const fromAnalyzer = (buf) => opened.port.emitData(buf);
    const written = () => Buffer.concat(opened.port.recording ? [opened.port.recording] : []);

    // 1) Result: ENQ, frames, EOT — the bridge ACKs each step
    const frames = buildFrames(["H|\\^&|||XP-100", "O|1||^^261119001A^B|^^^^WBC^1", "R|1|^^^^WBC^1|7.80|10*3/uL||N", "L|1|N"]);
    fromAnalyzer(Buffer.from([ENQ]));
    for (const f of frames) { await wait(10); fromAnalyzer(f); }
    await wait(10); fromAnalyzer(Buffer.from([EOT]));
    await wait(200);
    assert.equal([...written()].filter((b) => b === ACK).length, frames.length + 1);
    assert.deepEqual(sent.map((s) => [s.sampleId, s.values[0].code, s.values[0].value]), [["261119001A", "WBC", "7.80"]]);

    // 2) Host query: the bridge answers with ENQ and frames; the analyzer ACKs them
    const before = written().length;
    fromAnalyzer(Buffer.from([ENQ]));
    for (const f of buildFrames(["H|\\^&", "Q|1|^^261119001A^B||^^^^ALL", "L|1|N"])) { await wait(10); fromAnalyzer(f); }
    await wait(10); fromAnalyzer(Buffer.from([EOT]));
    // Act as the analyzer: ACK whatever the bridge sends until its EOT
    let answer = "";
    const rx = new AstmReceiver({ reply: () => {}, onMessage: (t) => { answer = t; } });
    for (let i = 0; i < 100 && !answer; i++) {
      await wait(30);
      const out = written().subarray(before);
      rx.buf = Buffer.alloc(0); rx.text = ""; rx.inSession = false;
      rx.feed(out.subarray(out.indexOf(ENQ)));
      if (!answer) fromAnalyzer(Buffer.from([ACK]));
    }
    const recs = parseRecords(answer).records.map((r) => r.join("|"));
    assert.ok(recs.some((r) => r.startsWith("O|1||^^261119001A^B|^^^^WBC^1")), recs.join("\n"));
  } finally {
    d.stop();
    useSerialPortClass(null);
  }
});

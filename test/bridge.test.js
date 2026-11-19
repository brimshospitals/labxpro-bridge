// The whole bridge over TCP: a pretend analyzer → driver → queue → a pretend LabXpro.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Queue, drain } from "../src/queue.js";
import { makeCloud, sendOutcome } from "../src/cloud.js";
import { MachineDriver, keyId } from "../src/driver.js";
import { setLogDir } from "../src/log.js";
import { connect, astmSendResult, astmAskTests, hl7Send, hl7Oru, hl7Qry } from "../tools/analyzer.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
let nextPort = 46100 + Math.floor(Math.random() * 500);

/** A pretend LabXpro: records what the bridge sends. */
function fakeLabxpro({ protocol = "astm", hostQuery = true, down = false } = {}) {
  const sent = [];
  const queried = [];
  const port = nextPort++;
  const state = { down };
  const fetchImpl = async (url, init) => {
    if (state.down) throw new Error("offline");
    const u = new URL(url);
    const json = (status, body) => ({ status, json: async () => body });
    if (!/^Bearer mk_/.test(init.headers.Authorization)) return json(401, { success: false, message: "bad key" });
    if (u.pathname.endsWith("/config")) return json(200, { success: true, data: { name: "Test analyzer", protocol, hostQuery, connection: { type: "tcp", mode: "server", tcpPort: port } } });
    if (u.pathname.endsWith("/heartbeat")) return json(200, { success: true, data: {} });
    if (u.pathname.endsWith("/orders")) {
      const id = u.searchParams.get("sampleId");
      queried.push(id);
      return json(200, { success: true, data: id === "261119001A" ? { found: true, tests: [{ code: "WBC", testName: "CBC" }, { code: "HGB", testName: "CBC" }], patient: { name: "Ramesh Kumar", sex: "M" } } : { found: false, tests: [] } });
    }
    if (u.pathname.endsWith("/results")) { sent.push(JSON.parse(init.body)); return json(200, { success: true, data: { status: "applied" } }); }
    return json(404, { success: false });
  };
  return { cloud: makeCloud("http://labxpro.test", { fetchImpl }), sent, queried, port, state };
}

async function startDriver(lab, dir) {
  setLogDir(path.join(dir, "logs"));
  const queue = new Queue(path.join(dir, "data"));
  const send = () => drain(queue, async (rec) => sendOutcome(await lab.cloud.result("mk_testkey_000000000000000000", rec)));
  const d = new MachineDriver({ key: "mk_testkey_000000000000000000", label: "T" }, { cloud: lab.cloud, queue, rawLogOn: true, onQueued: send });
  await d.start();
  await wait(150);   // listening
  return { d, queue, send };
}

test("ASTM: result from the analyzer reaches LabXpro with a messageId; raw log written", async () => {
  const dir = tmp();
  const lab = fakeLabxpro();
  const { d } = await startDriver(lab, dir);
  try {
    const s = await connect(lab.port);
    assert.equal(await astmSendResult(s, "261119001A", [{ code: "WBC", value: "7.82" }, { code: "HGB", value: "13.5" }]), true);
    await wait(300);
    assert.equal(lab.sent.length, 1);
    assert.equal(lab.sent[0].sampleId, "261119001A");
    assert.deepEqual(lab.sent[0].values.map((v) => [v.code, v.value]), [["WBC", "7.82"], ["HGB", "13.5"]]);
    assert.match(lab.sent[0].messageId, new RegExp(`^${keyId("mk_testkey_000000000000000000")}-`));
    assert.match(lab.sent[0].raw, /R\|1\|\^\^\^WBC/);
    const raw = fs.readdirSync(path.join(dir, "logs")).find((f) => f.startsWith("raw-"));
    assert.match(fs.readFileSync(path.join(dir, "logs", raw), "utf8"), /<ENQ>/);
    s.end();
  } finally { d.stop(); }
});

test("ASTM host query: the bridge asks LabXpro and answers with the tests", async () => {
  const dir = tmp();
  const lab = fakeLabxpro();
  const { d } = await startDriver(lab, dir);
  try {
    const s = await connect(lab.port);
    const reply = await astmAskTests(s, "261119001A");
    assert.deepEqual(lab.queried, ["261119001A"]);
    assert.ok(reply.some((r) => /^O\|1\|261119001A\|\|\^\^\^WBC\\\^\^\^HGB/.test(r)), reply.join("\n"));
    const s2 = await connect(lab.port);
    const none = await astmAskTests(s2, "NOTBOOKED");
    assert.equal(none.at(-1), "L|1|I");
    s2.end();
  } finally { d.stop(); }
});

test("HL7: ORU is acknowledged and sent; QRY gets QCK + DSR", async () => {
  const dir = tmp();
  const lab = fakeLabxpro({ protocol: "hl7" });
  const { d } = await startDriver(lab, dir);
  try {
    const s = await connect(lab.port);
    const acks = await hl7Send(s, hl7Oru("261119001A", [{ code: "WBC", value: "6.4" }], "77"));
    assert.match(acks[0], /MSA\|AA\|77/);
    await wait(300);
    assert.deepEqual(lab.sent.map((x) => [x.sampleId, x.values[0].value]), [["261119001A", "6.4"]]);
    const q = await hl7Send(s, hl7Qry("261119001A", "78"));
    assert.match(q[0], /QAK\|SR\|OK/);
    assert.match(q[1], /DSP\|29\|\|WBC/);
    s.end();
  } finally { d.stop(); }
});

test("Offline: results wait on disk and go out, once, when LabXpro is back", async () => {
  const dir = tmp();
  const lab = fakeLabxpro();
  const { d, queue, send } = await startDriver(lab, dir);
  try {
    lab.state.down = true;
    const s = await connect(lab.port);
    await astmSendResult(s, "S1", [{ code: "WBC", value: "5" }]);
    await astmSendResult(s, "S2", [{ code: "WBC", value: "6" }]);
    await wait(300);
    assert.equal(queue.size(), 2);
    assert.equal(lab.sent.length, 0);
    // A restart of the computer: a new queue object reads the same files
    const again = new Queue(path.join(dir, "data"));
    assert.equal(again.size(), 2);
    lab.state.down = false;
    await send();
    assert.deepEqual(lab.sent.map((x) => x.sampleId), ["S1", "S2"]);
    assert.equal(queue.size(), 0);
    s.end();
  } finally { d.stop(); }
});

test("Queue: bad data is set aside, a blocked key does not hold up others", async () => {
  const q = new Queue(tmp());
  q.add({ machineKeyId: "a", sampleId: "1", values: [] });
  q.add({ machineKeyId: "b", sampleId: "2", values: [] });
  q.add({ machineKeyId: "c", sampleId: "3", values: [] });
  const seen = [];
  await drain(q, async (rec) => { seen.push(rec.sampleId); return rec.machineKeyId === "a" ? sendOutcome({ status: 401 }) : rec.machineKeyId === "b" ? sendOutcome({ status: 400, message: "bad" }) : { ok: true }; });
  assert.deepEqual(seen, ["1", "2", "3"]);
  assert.equal(q.size(), 1);          // key "a" waits for a new key
  assert.equal(q.failedCount(), 1);   // "b" refused for good
  // LabXpro down: stop at the first one and try later
  const q2 = new Queue(tmp());
  q2.add({ machineKeyId: "x", sampleId: "1", values: [] });
  q2.add({ machineKeyId: "x", sampleId: "2", values: [] });
  let calls = 0;
  await drain(q2, async () => { calls++; return sendOutcome({ status: 0 }); });
  assert.equal(calls, 1);
});

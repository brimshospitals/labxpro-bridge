// Results waiting to reach LabXpro. Each result is a file on disk, so nothing is lost when the
// internet or the computer goes off; it is sent (oldest first) as soon as LabXpro answers.
// The messageId is made once, so a result sent twice is still stored once by LabXpro.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class Queue {
  constructor(dir) {
    this.dir = path.join(dir, "queue");
    this.failedDir = path.join(dir, "failed");
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.failedDir, { recursive: true });
  }

  /** item = { machineKeyId, sampleId, values, raw } → stored with a messageId */
  add(item) {
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const rec = { ...item, messageId: `${item.machineKeyId || "m"}-${id}`, queuedAt: new Date().toISOString(), tries: 0 };
    const file = path.join(this.dir, `${id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(rec));
    fs.renameSync(`${file}.tmp`, file);   // never a half-written file
    return rec;
  }

  list() {
    return fs.readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort();
  }

  size() { return this.list().length; }
  failedCount() { return fs.readdirSync(this.failedDir).filter((f) => f.endsWith(".json")).length; }

  read(name) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8")); } catch { return null; }
  }
  done(name) { fs.rmSync(path.join(this.dir, name), { force: true }); }
  /** LabXpro refused it for good (bad data): kept aside for checking, not retried. */
  fail(name, reason) {
    const rec = this.read(name) || {};
    fs.writeFileSync(path.join(this.failedDir, name), JSON.stringify({ ...rec, failedAt: new Date().toISOString(), reason }));
    this.done(name);
  }
  touch(name) {
    const rec = this.read(name);
    if (rec) fs.writeFileSync(path.join(this.dir, name), JSON.stringify({ ...rec, tries: (rec.tries || 0) + 1, lastTry: new Date().toISOString() }));
  }
}

/**
 * Send queued results one by one. send(rec) → { ok } | { retry } | { skip } | { drop, reason }.
 * Stops at the first "retry" (LabXpro or the internet is down) and tries again later.
 */
export async function drain(queue, send) {
  let sent = 0;
  for (const name of queue.list()) {
    const rec = queue.read(name);
    if (!rec) { queue.done(name); continue; }
    const r = await send(rec);
    if (r.ok) { queue.done(name); sent++; continue; }
    if (r.drop) { queue.fail(name, r.reason || "refused"); continue; }
    queue.touch(name);
    if (r.skip) continue;   // only this machine is blocked (e.g. its key was changed)
    break;
  }
  return sent;
}

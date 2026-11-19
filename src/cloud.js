// Calls to LabXpro (lims/app/api/instrument/v1). Every call carries the machine's key.
export const VERSION = "1.0.0";

export function makeCloud(server, { fetchImpl = globalThis.fetch } = {}) {
  const base = String(server || "").replace(/\/+$/, "");
  async function call(key, path, { method = "GET", body, timeoutMs = 15000 } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`${base}/api/instrument/v1${path}`, {
        method, signal: ctl.signal,
        headers: { Authorization: `Bearer ${key}`, "X-Bridge-Version": VERSION, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json().catch(() => ({}));
      return { status: r.status, ...data };
    } catch (e) {
      return { status: 0, success: false, message: e?.name === "AbortError" ? "LabXpro did not answer in time" : `Cannot reach LabXpro: ${e?.message || e}` };
    } finally {
      clearTimeout(t);
    }
  }
  return {
    config: (key) => call(key, "/config"),
    heartbeat: (key) => call(key, "/heartbeat", { method: "POST", timeoutMs: 10000 }),
    // Analyzers wait only a few seconds for the tests of a tube
    orders: (key, sampleId, timeoutMs = 4000) => call(key, `/orders?sampleId=${encodeURIComponent(sampleId)}`, { timeoutMs }),
    result: (key, rec) => call(key, "/results", { method: "POST", body: { messageId: rec.messageId, sampleId: rec.sampleId, values: rec.values, raw: rec.raw } }),
  };
}

/** What to do with a queued result after one send. */
export function sendOutcome(res) {
  if (res.success) return { ok: true };
  if (res.status === 0 || res.status >= 500 || res.status === 429) return { retry: true };   // internet / LabXpro down: try later
  if (res.status === 401 || res.status === 403) return { skip: true };                        // this machine's key: keep it, send the others
  return { drop: true, reason: res.message || `HTTP ${res.status}` };   // 400: bad data, retrying will not help
}

// Plain-text print-outs (semi-auto biochemistry, electrolyte, urine strip readers): the analyzer
// "prints" to the serial port. Lines are collected until the port is quiet, then read as
//   Sample / ID / S.No : 261119001A
//   GLU   112   mg/dL      or   NA=139.2   or   K: 4.1
// Patterns can be changed per machine in bridge.config.json ("text": { "sample": "...", "value": "..." }).

const DEFAULT_SAMPLE = "(?:sample\\s*(?:id|no\\.?)?|s\\.?\\s*no\\.?|sid|id|patient\\s*id)\\s*[:#=.]?\\s*([A-Za-z0-9-]{3,})";
const DEFAULT_VALUE = "^\\s*([A-Za-z][A-Za-z0-9%#+\\-/.]{0,15}?)(?:\\s*[:=]\\s*|\\s+)([<>]?-?\\d+(?:\\.\\d+)?|positive|negative|trace|nil|normal|[+]{1,4})\\s*([A-Za-z/%0-9.^µμ]*)";

export function parseText(text, opts = {}) {
  const sampleRe = new RegExp(opts.sample || DEFAULT_SAMPLE, "i");
  const valueRe = new RegExp(opts.value || DEFAULT_VALUE, "i");
  const skip = /^(date|time|name|age|sex|doctor|ref|lab|page)\b/i;
  const results = [];
  let cur = null;
  for (const raw of String(text).split(/\r\n?|\n|\f/)) {
    const line = raw.replace(/[\x00-\x08\x0b-\x1f]/g, "").trim();
    if (!line) continue;
    const s = sampleRe.exec(line);
    if (s) { cur = { sampleId: s[1].toUpperCase(), values: [] }; results.push(cur); continue; }
    if (skip.test(line)) continue;
    const v = valueRe.exec(line);
    if (v && cur) cur.values.push({ code: v[1].toUpperCase(), value: v[2], unit: v[3] || "", flag: "" });
  }
  return { results: results.filter((r) => r.values.length), queries: [] };
}

/** Collects bytes; calls onMessage(text) once the port has been quiet for `idleMs`. */
export class TextReceiver {
  constructor({ onMessage, idleMs = 2000 }) {
    this.onMessage = onMessage;
    this.idleMs = idleMs;
    this.text = "";
    this.timer = null;
  }
  feed(chunk) {
    this.text += chunk.toString("latin1");
    if (this.text.length > 256 * 1024) this.text = this.text.slice(-128 * 1024);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.idleMs);
  }
  flush() {
    clearTimeout(this.timer);
    const t = this.text;
    this.text = "";
    if (t.trim()) this.onMessage(t);
  }
}

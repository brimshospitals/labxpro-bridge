// Daily log files (logs/bridge-YYYY-MM-DD.log) and the raw analyzer log used to set up a new machine.
import fs from "node:fs";
import path from "node:path";

let dir = "logs";
export function setLogDir(d) { dir = d; fs.mkdirSync(dir, { recursive: true }); }

const day = () => new Date().toISOString().slice(0, 10);
function write(file, line) {
  try { fs.appendFileSync(path.join(dir, file), `${line}\n`); } catch { /* never stop the bridge for a log */ }
}

export function log(level, ...parts) {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${parts.map((p) => (p instanceof Error ? p.message : typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`;
  if (level === "error") console.error(line); else console.log(line);
  write(`bridge-${day()}.log`, line);
}

/** Bytes from / to an analyzer, control characters shown as <ENQ>, <STX>… (for checking codes and protocol). */
const NAMES = { 0x02: "<STX>", 0x03: "<ETX>", 0x04: "<EOT>", 0x05: "<ENQ>", 0x06: "<ACK>", 0x0b: "<VT>", 0x0d: "<CR>\n", 0x0a: "<LF>", 0x15: "<NAK>", 0x17: "<ETB>", 0x1c: "<FS>" };
export function rawLog(machine, dirArrow, buf) {
  let s = "";
  for (const b of buf) s += NAMES[b] ?? (b < 0x20 || b > 0x7e ? `<${b.toString(16).padStart(2, "0")}>` : String.fromCharCode(b));
  write(`raw-${String(machine).replace(/[^\w-]+/g, "_")}-${day()}.log`, `${new Date().toISOString()} ${dirArrow} ${s}`);
}

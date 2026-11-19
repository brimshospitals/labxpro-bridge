// Build the lab PC download: dist/LabXpro-Bridge.zip with its own node.exe, so the lab installs nothing else.
//   npm run package        (on Windows x64, after npm install)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const out = path.join(dist, "LabXpro-Bridge");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const copy = (from, to = from) => fs.cpSync(path.join(root, from), path.join(out, to), { recursive: true });
copy("src");
copy("tools/analyzer.js");
copy("package.json");
copy("bridge.config.example.json");
copy("node_modules");
copy("windows", ".");
fs.copyFileSync(process.execPath, path.join(out, "node.exe"));

const zip = path.join(dist, "LabXpro-Bridge.zip");
fs.rmSync(zip, { force: true });
// Windows' own tar makes .zip files (a Git Bash tar would read "D:" as a remote host)
const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
execFileSync(tar, ["-a", "-c", "-f", zip, "-C", dist, "LabXpro-Bridge"], { stdio: "inherit" });
console.log(`Made ${zip} (${(fs.statSync(zip).size / 1e6).toFixed(1)} MB) with Node ${process.version}`);

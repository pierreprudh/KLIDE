import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UNPATCHED_DEV_ADVISORY = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";

/** Preserve the high/critical gate, with one dev-only advisory exception.
 * Missing lock records, dependency cycles and unknown advisory chains fail closed. */
export function auditFindings(report, lock) {
  if (!report || report.error || !report.vulnerabilities) throw new Error("npm audit did not return a valid vulnerability report");
  const vulnerabilities = report.vulnerabilities;
  function isKnownDevChain(name, trail = new Set()) {
    const item = vulnerabilities[name];
    if (!item || trail.has(name) || !item.nodes?.length || !item.via?.length) return false;
    if (!item.nodes.every((path) => lock.packages?.[path]?.dev === true)) return false;
    const next = new Set([...trail, name]);
    return item.via.every((via) => typeof via === "string"
      ? isKnownDevChain(via, next)
      : via.name === "picomatch" && via.url === UNPATCHED_DEV_ADVISORY && via.severity === "high");
  }
  const blocked = [], allowed = [];
  for (const [name, item] of Object.entries(vulnerabilities)) {
    if (!["high", "critical"].includes(item.severity)) continue;
    if (item.severity === "high" && isKnownDevChain(name)) allowed.push(name);
    else blocked.push(name);
  }
  return { blocked, allowed };
}

function main() {
  const executable = process.env.npm_execpath;
  const result = executable
    ? spawnSync(process.execPath, [executable, "audit", "--json"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 })
    : spawnSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.signal || ![0, 1].includes(result.status)) throw new Error(result.error?.message || result.stderr || "npm audit failed");
  const report = JSON.parse(result.stdout);
  const { blocked, allowed } = auditFindings(report, JSON.parse(readFileSync("package-lock.json", "utf8")));
  if (allowed.length) console.warn(`Temporary dev-only exception GHSA-fc5q-39xc-vjpf: ${allowed.join(", ")}. See docs/DEPENDENCY_AUDIT.md.`);
  if (blocked.length) {
    console.error(`Dependency audit blocked: ${blocked.join(", ")}`);
    console.error(result.stdout);
    process.exitCode = 1;
  } else console.log("Dependency audit passed the high/critical gate; moderate findings retain the existing policy.");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

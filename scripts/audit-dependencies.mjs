import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Block every high or critical advisory. An invalid audit response fails closed. */
export function auditFindings(report) {
  if (!report || report.error || !report.vulnerabilities) throw new Error("npm audit did not return a valid vulnerability report");
  const blocked = Object.entries(report.vulnerabilities)
    .filter(([, item]) => ["high", "critical"].includes(item.severity))
    .map(([name]) => name);
  return { blocked };
}

function main() {
  const executable = process.env.npm_execpath;
  const result = executable
    ? spawnSync(process.execPath, [executable, "audit", "--json"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 })
    : spawnSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.signal || ![0, 1].includes(result.status)) throw new Error(result.error?.message || result.stderr || "npm audit failed");
  const report = JSON.parse(result.stdout);
  const { blocked } = auditFindings(report);
  if (blocked.length) {
    console.error(`Dependency audit blocked: ${blocked.join(", ")}`);
    console.error(result.stdout);
    process.exitCode = 1;
  } else console.log("Dependency audit passed the high/critical gate; moderate findings retain the existing policy.");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

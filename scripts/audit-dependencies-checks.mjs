import { test } from "node:test";
import assert from "node:assert/strict";
import { auditFindings } from "./audit-dependencies.mjs";
const known = { name: "picomatch", url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf", severity: "high" };
const lock = { packages: { "node_modules/picomatch": { dev: true }, "node_modules/vite": { dev: true } } };
const report = () => ({ vulnerabilities: {
  picomatch: { severity: "high", nodes: ["node_modules/picomatch"], via: [known] },
  vite: { severity: "high", nodes: ["node_modules/vite"], via: ["picomatch"] },
} });
test("allows only the documented development dependency chain", () => {
  assert.deepEqual(auditFindings(report(), lock), { blocked: [], allowed: ["picomatch", "vite"] });
});
test("the same advisory in a production dependency blocks the audit", () => {
  const production = structuredClone(lock); production.packages["node_modules/picomatch"].dev = false;
  assert.deepEqual(auditFindings(report(), production).blocked, ["picomatch", "vite"]);
});
test("a new high-severity advisory is not covered by the exception", () => {
  const value = report(); value.vulnerabilities.picomatch.via.push({ ...known, url: "https://github.com/advisories/GHSA-other" });
  assert.deepEqual(auditFindings(value, lock).blocked, ["picomatch", "vite"]);
});
test("critical severity is never waived", () => {
  const value = report(); value.vulnerabilities.vite.severity = "critical";
  assert.deepEqual(auditFindings(value, lock).blocked, ["vite"]);
});
test("missing lock entries, cycles and malformed reports fail closed", () => {
  assert.deepEqual(auditFindings(report(), { packages: {} }).blocked, ["picomatch", "vite"]);
  const value = report(); value.vulnerabilities.picomatch.via = ["vite"];
  assert.deepEqual(auditFindings(value, lock).blocked, ["picomatch", "vite"]);
  assert.throws(() => auditFindings({ error: { code: "ENOAUDIT" } }, lock));
});
test("moderate findings keep the repository's existing threshold", () => {
  const value = report(); value.vulnerabilities.picomatch.severity = "moderate"; delete value.vulnerabilities.vite;
  assert.deepEqual(auditFindings(value, lock), { blocked: [], allowed: [] });
});

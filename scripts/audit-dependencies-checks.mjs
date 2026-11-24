import { test } from "node:test";
import assert from "node:assert/strict";
import { auditFindings } from "./audit-dependencies.mjs";
const report = () => ({ vulnerabilities: {
  picomatch: { severity: "high", nodes: ["node_modules/picomatch"], via: [{ name: "picomatch", severity: "high" }] },
  vite: { severity: "critical", nodes: ["node_modules/vite"], via: ["picomatch"] },
  uuid: { severity: "moderate", nodes: ["node_modules/uuid"], via: [{ name: "uuid", severity: "moderate" }] },
} });
test("high and critical advisories block, development dependencies included", () => {
  assert.deepEqual(auditFindings(report()).blocked, ["picomatch", "vite"]);
});
test("moderate findings keep the repository's existing threshold", () => {
  const value = report(); delete value.vulnerabilities.picomatch; delete value.vulnerabilities.vite;
  assert.deepEqual(auditFindings(value).blocked, []);
});
test("malformed reports fail closed", () => {
  assert.throws(() => auditFindings({ error: { code: "ENOAUDIT" } }));
  assert.throws(() => auditFindings({}));
});

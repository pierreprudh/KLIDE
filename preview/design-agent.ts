import { Channel, invoke } from "../node_modules/@tauri-apps/api/core.js";
// Use the actual SDK on the fixture server; its aliases apply only to fixtures.
const stopAgentRun = (runId: string) => invoke("agent_abort_run", { runId });
const getAgentRunState = (runId: string) => invoke<{status: string | null}>("agent_run_status", { runId });
const readAgentRunEvents = (runId: string) => invoke<AgentEvent[]>("agent_read_run", { runId });
import type { AgentEvent } from "../src/agent/types";
// @ts-expect-error development-only JS validator, shared with evidence tests
import { validateReview } from "../scripts/design-feedback/review-output.mjs";

type Receipt = { evidenceId: string; manifestSha256: string; paritySha256: string; provider: string; model: string; images: { captureId: string; path: string; sha256: string; bytes: number }[] };
const el = (id: string) => document.getElementById(id)!;
const button = (id: string) => el(id) as HTMLButtonElement;
const input = (id: string) => (el(id) as HTMLInputElement).value.trim();
let receipt: Receipt | null = null, runId: string | null = null, output = "", terminal = false, failed = false;
let structured: unknown = null;
let eventLog: Record<string, unknown>[] = [];
let resolved: {provider: string; model: string} | null = null;
function status(message: string) { el("status").textContent = message; }
function request() { return { workspaceRoot: input("workspace"), manifestPath: input("manifest"), parityPath: input("parity"), captureIds: input("captures").split(',').map(s=>s.trim()).filter(Boolean), provider: input("provider"), model: input("model"), brief: input("brief") }; }
function showError(error: unknown) { status(`Incomplete: ${String(error)}`); }
function busy(active: boolean) { button("prepare").disabled = active; (el("inputs") as HTMLFieldSetElement).disabled = active; }
function finish() {
  if (!terminal || !receipt) return;
  busy(false);
  button("stop").disabled = true;
  button("export").disabled = false;
  if (!resolved || resolved.provider !== receipt.provider || resolved.model !== receipt.model) failed = true;
  if (failed) { status("Run failed or was cancelled; no completed review is claimed."); return; }
  try { structured = validateReview(output, receipt); status("Structured review received. Findings still require human judgment."); }
  catch (error) { structured = null; showError(error); }
}
function event(event: AgentEvent) {
  // Summaries never retain image blocks or user-message attachments.
  eventLog.push({ type: event.type, ts: event.ts, ...(event.type === "assistant_message" ? { usage: event.usage } : {}), ...(event.type === "run_started" ? {provider:event.provider,model:event.model} : {}) });
  if (event.type === "run_started") { resolved = {provider:event.provider,model:event.model}; status(`Running: ${event.provider} / ${event.model}`); }
  if (event.type === "assistant_message") { output = event.content.flatMap(block=>block.type === "text" ? [block.text] : []).join(''); el("output").textContent = output; }
  if (event.type === "run_error") { failed = true; el("output").textContent = event.error.message; }
  if (event.type === "run_result") failed = event.result.status !== "done";
  if (event.type === "run_result" || event.type === "run_error") { terminal = true; finish(); }
}
button("prepare").onclick = async () => {
  receipt = null; structured = null; runId = null; button("export").disabled = true; button("inspect").disabled = true;
  busy(true); button("start").disabled = true; status("Checking hashes and native verification…");
  try { receipt = await invoke<Receipt>("agent_prepare_design_review", { input: request() }); el("receipt").textContent = JSON.stringify(receipt,null,2); button("start").disabled = false; status("Evidence verified. Start will check vision support and use the selected provider."); }
  catch (error) { receipt = null; showError(error); }
  finally { busy(false); }
};
button("start").onclick = async () => {
  button("start").disabled = true; button("export").disabled = true; button("inspect").disabled = true; busy(true);
  output = ""; terminal = false; failed = false; structured = null; runId = null; eventLog = []; resolved = null; receipt = null; el("output").textContent = ""; status("Rechecking evidence before Run admission…");
  try {
    const onEvent = new Channel<AgentEvent>(event);
    const started = await invoke<{ runId: string; evidence: Receipt }>("agent_start_design_review", { input: request(), onEvent });
    runId = started.runId; receipt = started.evidence; el("receipt").textContent = JSON.stringify({runId,...receipt},null,2);
    button("stop").disabled = terminal; button("inspect").disabled = false;
    finish();
  } catch (error) { busy(false); showError(error); }
};
button("stop").onclick = async () => { if (runId) try { await stopAgentRun(runId); status("Stop requested; waiting for the Run’s terminal event…"); } catch(error) {showError(error);} };
button("inspect").onclick = async () => {
  if (!runId) return;
  try {
    const state = await getAgentRunState(runId);
    const events = await readAgentRunEvents(runId);
    for (const e of events) if (e.type === "assistant_message" || e.type === "run_error" || e.type === "run_result") event(e);
    if (!terminal) status(`Run ${runId}: ${state.status ?? 'not active; terminal evidence not yet available'}`);
  } catch(error) {showError(error);}
};
button("export").onclick = () => {
  const body = { schemaVersion: 1, runId, evidence: receipt, resolved, status: structured ? 'structured-review' : 'incomplete', review: structured, rawOutput: output, events: eventLog, limitation: 'Schema validity does not establish visual judgment or live image-delivery canary success.' };
  const url = URL.createObjectURL(new Blob([JSON.stringify(body,null,2)],{type:'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = `${runId ?? 'design-review'}.json`; link.click(); setTimeout(()=>URL.revokeObjectURL(url),0);
};
// A changed field invalidates an earlier preflight. Start rechecks natively too.
el("inputs").addEventListener('input',()=>{button("start").disabled=true;});

// Code Mode (agent/script.rs): whether a Run may be offered `run_script`, the
// read-only Tool that lets a model call several reads from one short script.

import { invoke } from "@tauri-apps/api/core";

export type CodeModeStatus = { enabled: boolean };

export function codeModeStatus(): Promise<CodeModeStatus> {
  return invoke<CodeModeStatus>("code_mode_status");
}

/** Turn Code Mode on or off; answers what is stored now. */
export function setCodeMode(enabled: boolean): Promise<CodeModeStatus> {
  return invoke<CodeModeStatus>("code_mode_set", { enabled });
}

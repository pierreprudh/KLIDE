// "Ask Kit" in the macOS Services menu (services_menu.rs): whether the Quick
// Action is installed, and installing or removing it.

import { invoke } from "@tauri-apps/api/core";

export function askKitServiceInstalled(): Promise<boolean> {
  return invoke<boolean>("services_ask_kit_status");
}

/** Install or remove the Quick Action; answers whether it is installed now. */
export function setAskKitService(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("services_ask_kit_set", { enabled });
}

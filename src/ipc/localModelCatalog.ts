import { invoke } from "@tauri-apps/api/core";
import type { LocalModelCatalog } from "../components/settings/localModelCatalog";

export function readLocalModelCatalog(): Promise<LocalModelCatalog> {
  return invoke("ai_local_model_catalog");
}

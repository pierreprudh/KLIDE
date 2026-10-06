// Eyes for a blind model — the composer's half of `agent/sight.rs`.
//
// Rust decides, per turn, which model describes a photo the run's own model
// cannot see and does the describing. This module owns only what the two
// composers (the AI panel's and Focus's start stage) need to agree on: when a
// drop is still allowed, what the hint says, and how the eyes are named in
// the UI. Kept free of React and Tauri so the rule stays one and testable.
import { SIGHT_TOOL } from "../../agent/foldEvents";

/** The pair Rust resolved as the eyes for a blind model. Mirrors `sight::Eyes`. */
export type Eyes = {
  provider: string;
  model: string;
  /** `setting` = the pair named in Harness settings, `local` = an installed
   *  Ollama vision model, `hosted` = a hosted default behind a key. */
  source: "setting" | "local" | "hosted";
};

/** The Settings pair, when the user named one. Absent = automatic. */
export type EyesSetting = { provider: string; model: string };

/** Read the Settings pair out of the harness settings object, or undefined
 *  when it is unset or half-set (a provider with no model is not a pair). */
export function eyesSettingOf(settings?: { eyesProvider?: string; eyesModel?: string }): EyesSetting | undefined {
  const provider = settings?.eyesProvider?.trim();
  const model = settings?.eyesModel?.trim();
  return provider && model ? { provider, model } : undefined;
}

/** A short name for the eyes, for a hint or a caption: the model id, minus a
 *  vendor namespace (`google/gemma-3-27b-it` → `gemma-3-27b-it`). The exact
 *  model, not its maker — "described by Google" would say nothing. */
export function eyesName(eyes: Pick<Eyes, "model"> | string): string {
  const model = typeof eyes === "string" ? seenByModel(eyes) : eyes.model;
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/** The eyes a conversation borrowed, from its `look_at_image` steps — one
 *  entry per distinct pair, with how many photos it read. Transcript
 *  evidence for the participants strip: the eyes are a participant the way a
 *  worker is, and they wear their own maker's mark. */
export function eyesOf(
  msgs: readonly { role: string; toolCalls?: readonly { name: string; args?: unknown }[] }[],
): { provider: string; model: string; images: number }[] {
  const seen = new Map<string, { provider: string; model: string; images: number }>();
  for (const msg of msgs) {
    if (msg.role !== "assistant") continue;
    for (const call of msg.toolCalls ?? []) {
      if (call.name !== SIGHT_TOOL) continue;
      const eyes = (call.args as { eyes?: unknown } | undefined)?.eyes;
      if (typeof eyes !== "string" || !eyes) continue;
      const slash = eyes.indexOf("/");
      const provider = slash >= 0 ? eyes.slice(0, slash) : "";
      const model = seenByModel(eyes);
      const entry = seen.get(eyes) ?? { provider, model, images: 0 };
      entry.images += 1;
      seen.set(eyes, entry);
    }
  }
  return [...seen.values()];
}

/** The model half of a `seen_by` label (`provider/model`). Provider ids carry
 *  no `/`, so the first one is the split — a namespaced model id keeps its own. */
export function seenByModel(seenBy: string): string {
  const slash = seenBy.indexOf("/");
  return slash >= 0 ? seenBy.slice(slash + 1) : seenBy;
}

/** What a composer may promise about a drop, given the model and the eyes.
 *  One answer for the overlay, the attach-menu row and the staging gate. */
export function photoGate(supportsVision: boolean, eyes: Eyes | null): {
  allowPhotos: boolean;
  /** The drop-overlay hint. */
  dropHint: string;
  /** The attach-menu row: its label and the tooltip behind it. */
  menuLabel: string;
  menuTitle: string;
  /** A one-line note for the staged photo, or null when the model sees. */
  stagedNote: string | null;
} {
  if (supportsVision) {
    return {
      allowPhotos: true,
      dropHint: "Drop an image or document to attach",
      menuLabel: "Photo or document",
      menuTitle: "Attach a photo or a text document",
      stagedNote: null,
    };
  }
  if (eyes) {
    const name = eyesName(eyes);
    return {
      allowPhotos: true,
      dropHint: `Drop an image or document — ${name} will describe images for this model`,
      menuLabel: "Photo or document",
      menuTitle: `This model can't see images — ${name} will describe them for it`,
      stagedNote: `Described by ${name}`,
    };
  }
  return {
    allowPhotos: false,
    dropHint: "Drop a document to attach",
    menuLabel: "Document",
    menuTitle: "This model can't see images, and no vision model is available — attach a text document",
    stagedNote: null,
  };
}

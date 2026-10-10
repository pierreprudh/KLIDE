import React from "react";
import ReactDOM from "react-dom/client";
// Bundle the design-system fonts locally (offline-first). The family names
// these register ("Atkinson Hyperlegible", "Monaspace Neon") match tokens.css.
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
import App from "./App";
import {
  healStoredConversationModels,
  healStoredConversationOrigins,
  healStoredConversationsFromTranscripts,
} from "./components/ai/conversationOriginHeal";
import { fetchRunOrigins } from "./runs";
import { verifyProviderCatalog } from "./agent/providerCatalog";
import { listProviders } from "./ipc/aiProviders";
import { notify } from "./toast";

// Repair conversations whose Provider label an older build overwrote (a Claude
// Code thread showing as OpenRouter). Runs before the first surface reads the
// index — Mission Control re-derives its rows from it on the same boot.
try {
  healStoredConversationOrigins();
  // And threads that kept another Provider's model when they were carried
  // onto a CLI (a Claude Code session showing DeepSeek in its composer).
  healStoredConversationModels();
} catch {
  /* a broken conversation index must never block the app from starting */
}

// The same repair against the stronger evidence: what each Run's Transcript
// says it was dispatched with. This one needs the backend, so it lands just
// after the first render and republishes the index for the surfaces already
// showing it. Deliberately not awaited — the app must start whether or not the
// runs directory can be read.
void healStoredConversationsFromTranscripts(fetchRunOrigins).catch(() => {
  /* no transcripts readable (or not running under Tauri) — labels stand */
});

// Dev only: the picker reads the generated Provider catalog mirror at first
// paint; `cargo test` fails when it is stale, but a `tauri dev` that skipped
// the tests would silently show old rows. Compare with what Rust serves now.
if (import.meta.env.DEV) {
  void verifyProviderCatalog(listProviders)
    .then((ids) => {
      if (ids.length > 0) {
        notify(
          `Provider catalog mirror is stale (${ids.join(", ")}) — run KLIDE_WRITE_MIRROR=1 cargo test provider_catalog_mirror_is_current`,
          { tone: "warn" },
        );
      }
    })
    .catch(() => {
      /* not running under Tauri — nothing to compare against */
    });
}

// WebKit stops the animation clock while it believes the page is hidden — and
// macOS can say so for a window you are looking at (shown without activation,
// or under a transparent overlay). Every entrance animation starts at opacity 0
// with `both` fill, so a frozen clock paints a blank app. While hidden, run
// animations and transitions at zero length so they sit at their end state
// (tokens.css).
const syncMotion = () =>
  document.documentElement.toggleAttribute("data-motion-still", document.visibilityState !== "visible");
syncMotion();
document.addEventListener("visibilitychange", syncMotion);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errMessage } from "./errors";
import { notify } from "./toast";

// The one door out of the app webview. Nothing else calls `openUrl`, and no
// surface lets a plain <a href> navigate: a Tauri webview has no tab and no
// back button, so following a link in place would replace the running app with
// a web page and lose every unsaved editor buffer and live Run.

// Only http(s)/mailto URLs may become clickable hrefs. Model output is
// attacker-influenceable (prompt injection via a poisoned file the model
// read), and React does not sanitize `javascript:` hrefs — a poisoned link
// would execute script in the app webview on click. Anything else keeps its
// link text but renders without an href.
export function safeLinkHref(url: string): string | null {
  try {
    const scheme = new URL(url).protocol.toLowerCase();
    return scheme === "http:" || scheme === "https:" || scheme === "mailto:"
      ? url
      : null;
  } catch {
    // Relative URLs / unparseable input: not navigable from the app webview.
    return null;
  }
}

// A bare URL a model wrote as prose, not as `[text](url)`. Deliberately greedy
// to the next whitespace — `splitUrlTail` gives back the sentence punctuation
// the URL swallowed, which is the only part a character class gets wrong.
export const BARE_URL_RE = /https?:\/\/[^\s<>"'`]+/;

// Split a greedily-matched URL into the link and the prose that followed it.
// `See https://tauri.app.` ends a sentence; `.../wiki/Foo_(bar)` does not end a
// parenthesis. So trailing sentence punctuation always drops, and a trailing
// `)` drops only when the URL never opened one.
export function splitUrlTail(raw: string): [url: string, trailing: string] {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1];
    if (".,;:!?".includes(ch)) {
      end -= 1;
      continue;
    }
    if (ch === ")") {
      const head = raw.slice(0, end);
      const opened = (head.match(/\(/g) ?? []).length;
      const closed = (head.match(/\)/g) ?? []).length;
      if (closed > opened) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return [raw.slice(0, end), raw.slice(end)];
}

// Hand a URL to the system browser. Safe to call with anything a model wrote:
// an unnavigable scheme is refused here as well as at render time, so a caller
// can never open what `safeLinkHref` would not have linked.
export async function openExternal(url: string): Promise<boolean> {
  const href = safeLinkHref(url);
  if (!href) {
    notify(`Not a link Klide will open: ${url}`, { tone: "warn" });
    return false;
  }
  try {
    if (isTauri()) await openUrl(href);
    else window.open(href, "_blank", "noreferrer");
    return true;
  } catch (e) {
    notify(`Couldn't open ${href}: ${errMessage(e)}`, { tone: "error" });
    return false;
  }
}

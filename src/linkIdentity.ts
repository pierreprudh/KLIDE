// What to call a link, and whose mark to draw beside it.
//
// A model writes URLs, not labels. Rendered whole, a URL is a 90-character
// monospace worm across a sentence — and the part a reader wants is almost
// always one word inside it: the repo, the package, the product. So a bare URL
// reads as that word plus the mark of the place it leads, and the full address
// moves to the hover.
//
// Deliberately a table, not a fetch. Reading a favicon would mean a network
// request per link from a local-first app — announcing to every host a model
// happens to mention that you are reading about it — so a site Klide has no
// mark for gets the neutral one, and is none the worse for it.

/** A site Klide draws a mark for. `null` is the neutral outbound glyph. */
export type LinkSite =
  | "github"
  | "anthropic"
  | "openai"
  | "ollama"
  | "mistral"
  | "xai"
  | "deepseek"
  | "openrouter"
  | "npm";

export type LinkIdentity = {
  /** The word the link reads as. */
  label: string;
  /** Whose mark sits before it, or `null` for the neutral glyph. */
  site: LinkSite | null;
  /** True when a mark would say nothing a reader needs — mail, mostly. */
  bare: boolean;
};

// host → the product's own name. A host absent here falls back to its own
// hostname, which is honest and never wrong, just less friendly.
const NAMED_HOSTS: Record<string, string> = {
  "tauri.app": "Tauri",
  "v2.tauri.app": "Tauri",
  "xtermjs.org": "xterm.js",
  "developer.mozilla.org": "MDN",
  "stackoverflow.com": "Stack Overflow",
  "news.ycombinator.com": "Hacker News",
  "microsoft.github.io": "Monaco",
  "code.visualstudio.com": "VS Code",
  "cursor.com": "Cursor",
  "www.cursor.com": "Cursor",
  "vitejs.dev": "Vite",
  "vite.dev": "Vite",
  "react.dev": "React",
  "doc.rust-lang.org": "Rust",
  "crates.io": "crates.io",
  "docs.rs": "docs.rs",
};

// host → the mark to draw, and the name to use when the path says nothing.
const SITE_HOSTS: Record<string, [LinkSite, string]> = {
  "github.com": ["github", "GitHub"],
  "www.github.com": ["github", "GitHub"],
  "gist.github.com": ["github", "gist"],
  "raw.githubusercontent.com": ["github", "GitHub"],
  "claude.ai": ["anthropic", "Claude"],
  "claude.com": ["anthropic", "Claude"],
  "www.anthropic.com": ["anthropic", "Anthropic"],
  "anthropic.com": ["anthropic", "Anthropic"],
  "docs.anthropic.com": ["anthropic", "Anthropic docs"],
  "openai.com": ["openai", "OpenAI"],
  "platform.openai.com": ["openai", "OpenAI"],
  "chatgpt.com": ["openai", "ChatGPT"],
  "ollama.com": ["ollama", "Ollama"],
  "ollama.ai": ["ollama", "Ollama"],
  "mistral.ai": ["mistral", "Mistral"],
  "docs.mistral.ai": ["mistral", "Mistral"],
  "x.ai": ["xai", "xAI"],
  "deepseek.com": ["deepseek", "DeepSeek"],
  "www.deepseek.com": ["deepseek", "DeepSeek"],
  "openrouter.ai": ["openrouter", "OpenRouter"],
  "www.npmjs.com": ["npm", "npm"],
  "npmjs.com": ["npm", "npm"],
};

const segments = (path: string) => path.split("/").filter(Boolean);

/**
 * The word a URL should read as, and the mark that belongs beside it.
 *
 * Never throws: anything unparseable reads as itself, which is what a renderer
 * needs — a link it cannot name is still a link it has to draw.
 */
export function linkIdentity(url: string): LinkIdentity {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { label: url, site: null, bare: true };
  }

  // Mail is already a name. A globe beside it would be a small lie.
  if (u.protocol === "mailto:") {
    return { label: u.pathname || url, site: null, bare: true };
  }

  const host = u.hostname.toLowerCase();
  const parts = segments(u.pathname);

  const known = SITE_HOSTS[host];
  if (known) {
    const [site, fallback] = known;
    // A repo is the thing being pointed at, not the person who owns it — and
    // `owner/repo` twice in a sentence reads worse than the repo alone.
    if (site === "github" && parts.length >= 2) return { label: parts[1], site, bare: false };
    if (site === "github" && parts.length === 1) return { label: parts[0], site, bare: false };
    // npmjs.com/package/<name>, including a scoped `@scope/name`.
    if (site === "npm" && parts[0] === "package" && parts.length >= 2) {
      return { label: parts.slice(1).join("/"), site, bare: false };
    }
    return { label: fallback, site, bare: false };
  }

  // `owner.github.io/project` is a project page; the project is the name.
  if (host.endsWith(".github.io")) {
    const named = NAMED_HOSTS[host];
    if (named) return { label: named, site: "github", bare: false };
    return { label: parts[0] ?? host.replace(/\.github\.io$/, ""), site: "github", bare: false };
  }

  const named = NAMED_HOSTS[host];
  if (named) return { label: named, site: null, bare: false };

  // Nothing known: the host itself, minus the `www.` nobody reads.
  return { label: host.replace(/^www\./, ""), site: null, bare: false };
}

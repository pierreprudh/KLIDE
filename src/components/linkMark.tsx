import { Globe } from "@phosphor-icons/react/dist/csr/Globe";
import { Icon } from "../icons";
import type { LinkSite } from "../linkIdentity";
import type { ProviderId } from "../agent/types";
import { ProviderLogo, ToolIcon } from "./ai/icons";
import { CONNECTOR_BRANDS, type ConnectorBrand } from "../connectorBrands";
import { isRemote, type ServerSpec } from "../ipc/connectors";

// The mark beside a link's name. Brand marks are the standing exception to the
// icon vocabulary (see icons.tsx) — a logo is a specific drawing, not a glyph
// Klide gets to restyle — so the provider marks are borrowed whole from
// `ProviderLogo` rather than redrawn here at a second weight.

// Sites Klide already knows as providers: one mark, drawn one way, wherever a
// surface names them.
const AS_PROVIDER: Partial<Record<LinkSite, ProviderId>> = {
  anthropic: "anthropic",
  openai: "openai",
  ollama: "ollama",
  mistral: "mistral",
  xai: "xai",
  deepseek: "deepseek",
  amp: "amp",
  cursor: "cursor",
  factory: "factory",
  hermes: "hermes",
  openrouter: "openrouter",
};

const GITHUB_PATH =
  "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12";

const NPM_PATH =
  "M0 7.334v8h6.666v1.332H12v-1.332h12v-8H0zm6.666 6.664H5.334v-4H3.999v4H1.335V8.667h5.331v5.331zm4 0v1.336H8.001V8.667h5.334v5.332h-2.669zm12.001 0h-1.33v-4h-1.336v4h-1.335v-4h-1.33v4h-2.671V8.667h8.002v5.331zM10.665 10H12v2.667h-1.335V10z";

/** The brand a connector belongs to, read from every name it carries — its id,
 *  label, the URL host or the command line that starts it. Whole tokens only,
 *  so `sandbox` never reads as Box and `mirror` never as Miro. */
export function connectorBrand(...names: (string | null | undefined)[]): ConnectorBrand | null {
  const tokens = new Set(
    names.filter(Boolean).join(" ").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
  );
  return CONNECTOR_BRANDS.find((brand) => brand.keywords.some((k) => tokens.has(k))) ?? null;
}

/** What a server spec says about whom it talks to: a URL's host, or the
 *  program and its arguments (`npx -y @notionhq/notion-mcp-server`). */
export function serverNames(server: ServerSpec | undefined): string {
  if (!server) return "";
  if (isRemote(server)) {
    try { return new URL(server.url).host; } catch { return server.url; }
  }
  return [server.command, ...server.args].join(" ");
}

// A brand too dark to read on a dark theme is drawn in the row's own ink —
// those marks are monochrome by design (GitHub, Notion, Vercel).
function inkOnly(hex: string): boolean {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.05;
}

/**
 * The mark a connector wears: its brand when one of its names says which
 * (`connectorBrand`), the Settings plug otherwise. `ink` draws the brand in
 * `currentColor`, taking the tone of the row it sits in — a tool row's dim
 * ink; `brand` gives it its own colour, for a list of connectors by name.
 */
export function ConnectorMark({
  connector, label, server, size = 12, tone = "ink",
}: {
  connector: string;
  label?: string;
  server?: ServerSpec;
  size?: number;
  tone?: "ink" | "brand";
}) {
  const brand = connectorBrand(connector, label, serverNames(server));
  if (!brand) return <ToolIcon name="connector_call" size={size} />;
  const color = tone === "brand" && !inkOnly(brand.hex) ? `#${brand.hex}` : "currentColor";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} role="img" aria-label={brand.title} style={{ flexShrink: 0 }}>
      <path d={brand.path} />
    </svg>
  );
}

/**
 * A site's mark at text size. `null` draws the neutral globe — used where a
 * link had to be given a name at all, never mid-sentence under words the
 * author chose themselves.
 */
export function LinkMark({ site, size = 13 }: { site: LinkSite | null; size?: number }) {
  if (site === "github" || site === "npm") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        style={{
          flexShrink: 0,
          // GitHub's mark is monochrome by design, so it takes the page's ink
          // rather than a colour of its own; npm keeps its red.
          color: site === "github" ? "var(--fg-strong)" : "#CB3837",
        }}
      >
        <path d={site === "github" ? GITHUB_PATH : NPM_PATH} />
      </svg>
    );
  }
  const provider = site ? AS_PROVIDER[site] : undefined;
  if (provider) return <ProviderLogo id={provider} size={size} />;
  return <Icon as={Globe} size={size} style={{ flexShrink: 0, color: "var(--fg-subtle)" }} />;
}

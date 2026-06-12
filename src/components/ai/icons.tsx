import type { ReactElement } from "react";
import type { ProviderId } from "../../agent/types";

const OPENROUTER_PATH =
  "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm-3 4h6l-3 5-3-5z";

const BRAND_LOGO_PATHS: Partial<Record<ProviderId, string>> = {
  ollama:
    "M16.361 10.26a.894.894 0 0 0-.558.47l-.072.148.001.207c0 .193.004.217.059.353.076.193.152.312.291.448.24.238.51.3.872.205a.86.86 0 0 0 .517-.436.752.752 0 0 0 .08-.498c-.064-.453-.33-.782-.724-.897a1.06 1.06 0 0 0-.466 0zm-9.203.005c-.305.096-.533.32-.65.639a1.187 1.187 0 0 0-.06.52c.057.309.31.59.598.667.362.095.632.033.872-.205.14-.136.215-.255.291-.448.055-.136.059-.16.059-.353l.001-.207-.072-.148a.894.894 0 0 0-.565-.472 1.02 1.02 0 0 0-.474.007ZM12 11.13c-.131.071-.223.25-.195.383.031.143.157.288.353.407.105.063.112.072.117.136.004.038-.01.146-.029.243-.02.094-.036.194-.036.222.002.074.07.195.143.253.064.052.076.054.255.059.164.005.198.001.264-.03.169-.082.212-.234.15-.525-.052-.243-.042-.28.087-.355.137-.08.281-.219.324-.314a.365.365 0 0 0-.175-.48.394.394 0 0 0-.181-.033c-.126 0-.207.03-.355.124l-.085.053-.053-.032c-.219-.13-.259-.145-.391-.143a.396.396 0 0 0-.193.032zm.39-2.195c-.373.036-.475.05-.654.086-.291.06-.68.195-.951.328-.94.46-1.589 1.226-1.787 2.114-.04.176-.045.234-.045.53 0 .294.005.357.043.524.264 1.16 1.332 2.017 2.714 2.173.3.033 1.596.033 1.896 0 1.11-.125 2.064-.727 2.493-1.571.114-.226.169-.372.22-.602.039-.167.044-.23.044-.523 0-.297-.005-.355-.045-.531-.288-1.29-1.539-2.304-3.072-2.497a6.873 6.873 0 0 0-.855-.031zm.645.937a3.283 3.283 0 0 1 1.44.514c.223.148.537.458.671.662.166.251.26.508.303.82.02.143.01.251-.043.482-.08.345-.332.705-.672.957a3.115 3.115 0 0 1-.689.348c-.382.122-.632.144-1.525.138-.582-.006-.686-.01-.853-.042-.57-.107-1.022-.334-1.35-.68-.264-.28-.385-.535-.45-.946-.03-.192.025-.509.137-.776.136-.326.488-.73.836-.963.403-.269.934-.46 1.422-.512.187-.02.586-.02.773-.002z",
  openai:
    "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  anthropic:
    "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  gemini:
    "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
  mistral:
    "M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z",
  vllm: "m23.6 0-8.721 4.59L9.829 24h7.41zM9.83 24V5.142H.4Z",
  openrouter: OPENROUTER_PATH,
};

// Claude Code and Codex are distinct *products*, not just the Anthropic /
// OpenAI providers — render their own brand marks instead of aliasing to the
// provider SVGs (see PROVIDER_LOGO_IMAGE below).
const LOGO_ALIAS: Partial<Record<ProviderId, ProviderId>> = {};

const PROVIDER_LOGO_COLOR: Partial<Record<ProviderId, string>> = {
  anthropic: "#D97757",
  "claude-code": "#D97757",
  openai: "var(--fg-strong)",
  codex: "var(--fg-strong)",
  opencode: "var(--fg-strong)",
  xai: "var(--fg-strong)",
  openrouter: "#4A6CF7",
};

const PROVIDER_LOGO_IMAGE: Partial<Record<ProviderId, string>> = {
  ollama: "/ollama-logo.png",
  gemini: "/gemini-logo.png",
  mistral: "/mistral-logo.png",
  "claude-code": "/claude-code-logo.png",
  codex: "/codex-logo.png",
};

// How each image mark reacts to theme:
// - "provider-logo-img" (default): dark mark, inverted to white on dark themes.
// - "color-logo-img": inherently colored, never inverted (keeps brand color).
// - "white-logo-img": white mark, inverted to dark on light themes.
const PROVIDER_LOGO_IMAGE_CLASS: Partial<Record<ProviderId, string>> = {
  "claude-code": "color-logo-img",
  codex: "white-logo-img",
};

export function ProviderLogo({ id, size = 14 }: { id: ProviderId; size?: number }) {
  if (id === "opencode") {
    return (
      <span
        className="opencode-logo"
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          flexShrink: 0,
        }}
      >
        <img className="opencode-logo-light" src="/opencode-logo-light.svg" alt="" />
        <img className="opencode-logo-dark" src="/opencode-logo-dark.svg" alt="" />
      </span>
    );
  }

  const image = PROVIDER_LOGO_IMAGE[id];
  if (image) {
    return (
      <img
        className={PROVIDER_LOGO_IMAGE_CLASS[id] ?? "provider-logo-img"}
        src={image}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          objectFit: "contain",
          flexShrink: 0,
        }}
      />
    );
  }

  const color = PROVIDER_LOGO_COLOR[id] ?? "currentColor";
  const base = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    "aria-hidden": true as const,
    style: { flexShrink: 0, color },
  };
  const brand = BRAND_LOGO_PATHS[LOGO_ALIAS[id] ?? id];
  if (brand) {
    return (
      <svg {...base} fill="currentColor">
        <path d={brand} />
      </svg>
    );
  }
  const line = {
    ...base,
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  // Self-hosted (custom:*) endpoints — a server-rack glyph with status LEDs,
  // so "bring your own datacenter" reads at a glance instead of a bare dot.
  if (id.startsWith("custom:")) {
    return (
      <svg {...line} strokeWidth="1.7">
        <rect x="3" y="4" width="18" height="7" rx="2" />
        <rect x="3" y="13" width="18" height="7" rx="2" />
        <path d="M7 7.5h0M7 16.5h0" strokeWidth="2.4" />
      </svg>
    );
  }
  switch (id) {
    case "lmstudio":
      return (
        <svg {...line} strokeWidth="1.6">
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <path d="M9 8v8M15 8v8" />
        </svg>
      );
    case "llamacpp":
      return (
        <svg {...line} strokeWidth="1.8">
          <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />
        </svg>
      );
    case "xai":
      return (
        <svg {...line} strokeWidth="2">
          <path d="M5 5l14 14M19 5L5 19" />
        </svg>
      );
    default:
      return (
        <svg {...base} fill="currentColor">
          <circle cx="12" cy="12" r="4" />
        </svg>
      );
  }
}

export function SendIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </svg>
  );
}

export function NewChatIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export function HistoryIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  );
}

export function DuplicateIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function ChevronDown() {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, color: "var(--fg-dim)" }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--accent)"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export function AssistantPlaceholderLoader() {
  return (
    <span className="ai-assistant-placeholder-loader" aria-label="Assistant is working">
      <span />
      <span />
      <span />
    </span>
  );
}

// 3×3 dot-grid loader — sweeps the grid in reverse while a tool executes.
// Sized for inline use next to 11px mono text (default 13px box).
export function DotGridLoader({ size = 13, color = "var(--accent)" }: { size?: number; color?: string }) {
  const dot = Math.max(2, Math.round(size / 4.5));
  return (
    <span
      aria-label="Tool running"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: Math.max(1, Math.round(size / 14)),
        width: size,
        height: size,
        flexShrink: 0,
        color,
      }}
    >
      {Array.from({ length: 9 }, (_, i) => (
        <span
          key={i}
          style={{
            width: dot,
            height: dot,
            borderRadius: "50%",
            background: "currentColor",
            placeSelf: "center",
            animation: "klide-dotgrid 1.4s ease-in-out infinite",
            animationDelay: `${(8 - i) * 0.1}s`,
          }}
        />
      ))}
    </span>
  );
}


// Per-tool glyphs for the agent tool rows. 12px quiet stroke icons keyed by
// the Rust registry's tool names; unknown tools fall back to a wrench.
const TOOL_ICON_PATHS: Record<string, ReactElement> = {
  read_file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </>
  ),
  create_file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M12 12v6M9 15h6" />
    </>
  ),
  write_file: (
    <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
  ),
  list_dir: (
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  ),
  glob: (
    <path d="M12 5v14M5.4 8.5l13.2 7M18.6 8.5l-13.2 7" />
  ),
  grep: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  get_git_status: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M6 9v3a3 3 0 0 0 3 3h6" />
    </>
  ),
  get_git_diff: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M6 9v3a3 3 0 0 0 3 3h6" />
    </>
  ),
  web_search: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" />
    </>
  ),
  web_fetch: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </>
  ),
  get_todo_list: (
    <>
      <path d="M9 6h12M9 12h12M9 18h12" />
      <path d="m3.5 5.5 1 1 2-2M3.5 11.5l1 1 2-2M3.5 17.5l1 1 2-2" />
    </>
  ),
  update_todo_list: (
    <>
      <path d="M9 6h12M9 12h12M9 18h12" />
      <path d="m3.5 5.5 1 1 2-2M3.5 11.5l1 1 2-2M3.5 17.5l1 1 2-2" />
    </>
  ),
  clean_context: (
    <>
      <path d="m19 11-8-8-8 8 8 8z" />
      <path d="m5 13 6 6M2 21h20" />
    </>
  ),
  create_skill: (
    <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" />
  ),
};

const TOOL_ICON_FALLBACK = (
  <path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6l-2.8 2.8-2.5-.5-.5-2.5z" />
);

export function ToolIcon({ name, size = 12 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {TOOL_ICON_PATHS[name] ?? TOOL_ICON_FALLBACK}
    </svg>
  );
}

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import {
  exists,
  readDir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { DiffModal, PendingEdit } from "./DiffModal";
import { enabledSkillsPrompt, type Skill } from "../skills";

type ToolCall = { name: string; args: any };

// Files the user pulled in with @-mentions. Stored on the user message but only
// rendered as inline "@path" text — the contents ride along to the model via
// toOllamaMessage, so the chat bubble stays clean.
type Attachment = { path: string; content: string };

type Msg =
  | { role: "user"; content: string; attachments?: Attachment[] }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      thinking?: string;
    }
  | { role: "system"; content: string }
  | { role: "tool"; content: string; toolName: string };

type Props = {
  workspaceRoot: string | null;
  onFileWritten?: (path: string, newContent: string) => void;
  visible: boolean;
  width: number;
  fill?: boolean;
  model: string;
  onModelChange: (model: string) => void;
  availableModels: string[];
  onAvailableModelsChange: (models: string[]) => void;
  requireDiffReview: boolean;
  stopAfterRejection: boolean;
  skills: Skill[];
  onDuplicate?: () => void;
  onClose?: () => void;
};

type PendingEditRequest = PendingEdit & {
  fullPath: string;
  resolve: (result: string) => void;
};

const MAX_TOOL_CALLS = 10;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full text contents of a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Path relative to the workspace root, e.g. "src/App.tsx".',
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the entries (files and folders) of a directory.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Path relative to the workspace root. Use "." for the workspace root itself.',
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Propose a search-and-replace edit to an existing file. The user reviews the diff and approves or rejects it — this tool does NOT write directly.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: 'Path of the existing file, relative to the workspace root.',
          },
          old_str: {
            type: "string",
            description:
              "The exact text to find in the file. Must match a unique substring (whitespace included). Include enough surrounding context that no other occurrence exists.",
          },
          new_str: {
            type: "string",
            description:
              "The replacement text. Use an empty string to delete the matched text.",
          },
        },
        required: ["path", "old_str", "new_str"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description:
        "Propose creating a brand-new file with the given contents. Fails if the file already exists. The user reviews the new contents and approves or rejects.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the new file, relative to the workspace root.",
          },
          contents: {
            type: "string",
            description: "Full text contents of the new file.",
          },
        },
        required: ["path", "contents"],
      },
    },
  },
];

// Plan mode borrows OpenCode's safest idea: investigate read-only, then propose
// a plan — the model is never handed the edit tools, so it physically cannot
// write. Build mode is the full agentic loop with diff-reviewed edits.
export type AgentMode = "build" | "plan";

// The two read-only tools, by name, so Plan mode can offer only these.
const READ_ONLY_TOOLS = TOOLS.filter(
  (t) => t.function.name === "read_file" || t.function.name === "list_dir"
);

function toolsForMode(mode: AgentMode) {
  return mode === "plan" ? READ_ONLY_TOOLS : TOOLS;
}

// Provider catalogue for the header switcher. Only Ollama is wired today; the
// rest render as disabled "Soon" entries so the surface is honest about scope.
type ProviderId =
  | "ollama"
  | "lmstudio"
  | "llamacpp"
  | "vllm"
  | "claude-code"
  | "codex"
  | "gemini-cli"
  | "anthropic"
  | "openai"
  | "gemini"
  | "mistral"
  | "xai";

type ProviderGroup = {
  label: string;
  items: { id: ProviderId; name: string; available: boolean }[];
};

// Single source of truth for the switcher. To ship a provider, flip `available`
// and branch the request logic on its id — nothing else here needs to change.
const PROVIDER_GROUPS: ProviderGroup[] = [
  {
    label: "Local",
    items: [
      { id: "ollama", name: "Ollama", available: true },
      { id: "lmstudio", name: "LM Studio", available: false },
      { id: "llamacpp", name: "llama.cpp", available: false },
      { id: "vllm", name: "vLLM", available: false },
    ],
  },
  {
    label: "Subscription",
    items: [
      { id: "claude-code", name: "Claude Code", available: false },
      { id: "codex", name: "Codex", available: false },
      { id: "gemini-cli", name: "Gemini CLI", available: false },
    ],
  },
  {
    label: "API",
    items: [
      { id: "anthropic", name: "Anthropic", available: false },
      { id: "openai", name: "OpenAI", available: false },
      { id: "gemini", name: "Google Gemini", available: false },
      { id: "mistral", name: "Mistral", available: false },
      { id: "xai", name: "xAI Grok", available: false },
    ],
  },
];

const ALL_PROVIDERS = PROVIDER_GROUPS.flatMap((g) => g.items);

function providerName(id: ProviderId): string {
  return ALL_PROVIDERS.find((p) => p.id === id)?.name ?? "Ollama";
}

// Official brand marks (Simple Icons, single-path, currentColor → theme- and
// hover-aware). Subscription/CLI variants alias to their vendor's mark below.
const BRAND_LOGO_PATHS: Partial<Record<ProviderId, string>> = {
  ollama:
    "M16.361 10.26a.894.894 0 0 0-.558.47l-.072.148.001.207c0 .193.004.217.059.353.076.193.152.312.291.448.24.238.51.3.872.205a.86.86 0 0 0 .517-.436.752.752 0 0 0 .08-.498c-.064-.453-.33-.782-.724-.897a1.06 1.06 0 0 0-.466 0zm-9.203.005c-.305.096-.533.32-.65.639a1.187 1.187 0 0 0-.06.52c.057.309.31.59.598.667.362.095.632.033.872-.205.14-.136.215-.255.291-.448.055-.136.059-.16.059-.353l.001-.207-.072-.148a.894.894 0 0 0-.565-.472 1.02 1.02 0 0 0-.474.007Zm4.184 2c-.131.071-.223.25-.195.383.031.143.157.288.353.407.105.063.112.072.117.136.004.038-.01.146-.029.243-.02.094-.036.194-.036.222.002.074.07.195.143.253.064.052.076.054.255.059.164.005.198.001.264-.03.169-.082.212-.234.15-.525-.052-.243-.042-.28.087-.355.137-.08.281-.219.324-.314a.365.365 0 0 0-.175-.48.394.394 0 0 0-.181-.033c-.126 0-.207.03-.355.124l-.085.053-.053-.032c-.219-.13-.259-.145-.391-.143a.396.396 0 0 0-.193.032zm.39-2.195c-.373.036-.475.05-.654.086-.291.06-.68.195-.951.328-.94.46-1.589 1.226-1.787 2.114-.04.176-.045.234-.045.53 0 .294.005.357.043.524.264 1.16 1.332 2.017 2.714 2.173.3.033 1.596.033 1.896 0 1.11-.125 2.064-.727 2.493-1.571.114-.226.169-.372.22-.602.039-.167.044-.23.044-.523 0-.297-.005-.355-.045-.531-.288-1.29-1.539-2.304-3.072-2.497a6.873 6.873 0 0 0-.855-.031zm.645.937a3.283 3.283 0 0 1 1.44.514c.223.148.537.458.671.662.166.251.26.508.303.82.02.143.01.251-.043.482-.08.345-.332.705-.672.957a3.115 3.115 0 0 1-.689.348c-.382.122-.632.144-1.525.138-.582-.006-.686-.01-.853-.042-.57-.107-1.022-.334-1.35-.68-.264-.28-.385-.535-.45-.946-.03-.192.025-.509.137-.776.136-.326.488-.73.836-.963.403-.269.934-.46 1.422-.512.187-.02.586-.02.773-.002zm-5.503-11a1.653 1.653 0 0 0-.683.298C5.617.74 5.173 1.666 4.985 2.819c-.07.436-.119 1.04-.119 1.503 0 .544.064 1.24.155 1.721.02.107.031.202.023.208a8.12 8.12 0 0 1-.187.152 5.324 5.324 0 0 0-.949 1.02 5.49 5.49 0 0 0-.94 2.339 6.625 6.625 0 0 0-.023 1.357c.091.78.325 1.438.727 2.04l.13.195-.037.064c-.269.452-.498 1.105-.605 1.732-.084.496-.095.629-.095 1.294 0 .67.009.803.088 1.266.095.555.288 1.143.503 1.534.071.128.243.393.264.407.007.003-.014.067-.046.141a7.405 7.405 0 0 0-.548 1.873c-.062.417-.071.552-.071.991 0 .56.031.832.148 1.279L3.42 24h1.478l-.05-.091c-.297-.552-.325-1.575-.068-2.597.117-.472.25-.819.498-1.296l.148-.29v-.177c0-.165-.003-.184-.057-.293a.915.915 0 0 0-.194-.25 1.74 1.74 0 0 1-.385-.543c-.424-.92-.506-2.286-.208-3.451.124-.486.329-.918.544-1.154a.787.787 0 0 0 .223-.531c0-.195-.07-.355-.224-.522a3.136 3.136 0 0 1-.817-1.729c-.14-.96.114-2.005.69-2.834.563-.814 1.353-1.336 2.237-1.475.199-.033.57-.028.776.01.226.04.367.028.512-.041.179-.085.268-.19.374-.431.093-.215.165-.333.36-.576.234-.29.46-.489.822-.729.413-.27.884-.467 1.352-.561.17-.035.25-.04.569-.04.319 0 .398.005.569.04a4.07 4.07 0 0 1 1.914.997c.117.109.398.457.488.602.034.057.095.177.132.267.105.241.195.346.374.43.14.068.286.082.503.045.343-.058.607-.053.943.016 1.144.23 2.14 1.173 2.581 2.437.385 1.108.276 2.267-.296 3.153-.097.15-.193.27-.333.419-.301.322-.301.722-.001 1.053.493.539.801 1.866.708 3.036-.062.772-.26 1.463-.533 1.854a2.096 2.096 0 0 1-.224.258.916.916 0 0 0-.194.25c-.054.109-.057.128-.057.293v.178l.148.29c.248.476.38.823.498 1.295.253 1.008.231 2.01-.059 2.581a.845.845 0 0 0-.044.098c0 .006.329.009.732.009h.73l.02-.074.036-.134c.019-.076.057-.3.088-.516.029-.217.029-1.016 0-1.258-.11-.875-.295-1.57-.597-2.226-.032-.074-.053-.138-.046-.141.008-.005.057-.074.108-.152.376-.569.607-1.284.724-2.228.031-.26.031-1.378 0-1.628-.083-.645-.182-1.082-.348-1.525a6.083 6.083 0 0 0-.329-.7l-.038-.064.131-.194c.402-.604.636-1.262.727-2.04a6.625 6.625 0 0 0-.024-1.358 5.512 5.512 0 0 0-.939-2.339 5.325 5.325 0 0 0-.95-1.02 8.097 8.097 0 0 1-.186-.152.692.692 0 0 1 .023-.208c.208-1.087.201-2.443-.017-3.503-.19-.924-.535-1.658-.98-2.082-.354-.338-.716-.482-1.15-.455-.996.059-1.8 1.205-2.116 3.01a6.805 6.805 0 0 0-.097.726c0 .036-.007.066-.015.066a.96.96 0 0 1-.149-.078A4.857 4.857 0 0 0 12 3.03c-.832 0-1.687.243-2.456.698a.958.958 0 0 1-.148.078c-.008 0-.015-.03-.015-.066a6.71 6.71 0 0 0-.097-.725C8.997 1.392 8.337.319 7.46.048a2.096 2.096 0 0 0-.585-.041Zm.293 1.402c.248.197.523.759.682 1.388.03.113.06.244.069.292.007.047.026.152.041.233.067.365.098.76.102 1.24l.002.475-.12.175-.118.178h-.278c-.324 0-.646.041-.954.124l-.238.06c-.033.007-.038-.003-.057-.144a8.438 8.438 0 0 1 .016-2.323c.124-.788.413-1.501.696-1.711.067-.05.079-.049.157.013zm9.825-.012c.17.126.358.46.498.888.28.854.36 2.028.212 3.145-.019.14-.024.151-.057.144l-.238-.06a3.693 3.693 0 0 0-.954-.124h-.278l-.119-.178-.119-.175.002-.474c.004-.669.066-1.19.214-1.772.157-.623.434-1.185.68-1.382.078-.062.09-.063.159-.012z",
  openai:
    "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  anthropic:
    "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  gemini:
    "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
  mistral:
    "M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z",
  vllm: "m23.6 0-8.721 4.59L9.829 24h7.41zM9.83 24V5.142H.4Z",
};

// Subscription / CLI offerings render under their vendor's mark.
const LOGO_ALIAS: Partial<Record<ProviderId, ProviderId>> = {
  "claude-code": "anthropic",
  codex: "openai",
  "gemini-cli": "gemini",
};

function ProviderLogo({ id, size = 14 }: { id: ProviderId; size?: number }) {
  const base = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    "aria-hidden": true as const,
    style: { flexShrink: 0 },
  };
  const brand = BRAND_LOGO_PATHS[LOGO_ALIAS[id] ?? id];
  if (brand) {
    return (
      <svg {...base} fill="currentColor">
        <path d={brand} />
      </svg>
    );
  }
  // Providers without an official Simple Icons mark — quiet custom glyphs.
  const line = {
    ...base,
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
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

function buildSystemPrompt(
  workspaceRoot: string | null,
  stopAfterRejection: boolean,
  skills: Skill[],
  mode: AgentMode,
  projectRules: string
): string {
  const skillsBlock = enabledSkillsPrompt(skills);
  const rulesBlock = projectRules
    ? `\n\nProject rules (from the workspace's AGENTS.md / CLAUDE.md — follow these):\n${projectRules}`
    : "";
  if (!workspaceRoot) {
    return `You are Klide's coding assistant, embedded in a code editor. No workspace folder is currently open — ask the user to open one via the Files panel before exploring code.${skillsBlock}`;
  }
  const planBlock =
    mode === "plan"
      ? `

PLAN MODE is active. You have ONLY read-only tools (read_file, list_dir) and CANNOT edit files. Investigate as needed and answer the user's question directly. If — and only if — the user asked you to make code changes, do NOT edit: present a clear, numbered implementation plan (the files you'd touch and what each needs) and tell them to switch to Build mode to apply it.`
      : "";
  return `You are Klide's coding assistant, embedded in a code editor.

Workspace root: ${workspaceRoot}

Tool usage:
- read_file / list_dir: read-only. Use whenever you need to know contents or structure.
- write_file / create_file: edit tools. Every edit opens a diff modal for the user to APPLY or REJECT — you never write directly.${planBlock}

Paths are relative to the workspace root (e.g. "src/App.tsx" or ".").

How to read tool results:
- "Applied: ..." → the user approved the edit. Confirm briefly and stop, unless more changes are needed.
- "Rejected by user: ..." → the user declined. ${
    stopAfterRejection
      ? "STOP. Do NOT retry the same edit. Ask the user what they want differently, or end your turn."
      : "Do not retry the exact same edit. You may suggest a smaller alternative if it directly addresses the user's request."
  }
- "Error: ..." → the tool itself failed (e.g. file not found, ambiguous match). Read the error and fix the call.

Be concise. When you have enough information, answer the user directly.${skillsBlock}${rulesBlock}`;
}

async function executeTool(
  call: ToolCall,
  workspaceRoot: string | null,
  requestEdit: (req: Omit<PendingEditRequest, "resolve">) => Promise<string>,
  requireDiffReview: boolean,
  onFileWritten?: (path: string, newContent: string) => void
): Promise<string> {
  if (!workspaceRoot) {
    return "Error: no workspace folder is open. Ask the user to open one via the Files panel.";
  }
  const resolvePath = (p: string): string => {
    const full = p.startsWith("/") ? p : `${workspaceRoot}/${p}`;
    if (!full.startsWith(workspaceRoot)) {
      throw new Error(`Path "${p}" is outside the workspace`);
    }
    return full;
  };

  try {
    if (call.name === "read_file") {
      const content = await readTextFile(resolvePath(call.args.path));
      return `Contents of ${call.args.path} (${content.length} chars):\n\`\`\`\n${content}\n\`\`\``;
    }
    if (call.name === "list_dir") {
      const p = call.args.path ?? ".";
      const entries = await readDir(resolvePath(p));
      const formatted = entries
        .slice()
        .sort(
          (a, b) =>
            Number(b.isDirectory) - Number(a.isDirectory) ||
            a.name.localeCompare(b.name)
        )
        .map((e) => `${e.isDirectory ? "[dir] " : "      "}${e.name}`)
        .join("\n");
      return `Entries in ${p}:\n${formatted}`;
    }
    if (call.name === "write_file") {
      const { path, old_str, new_str } = call.args;
      if (typeof path !== "string" || typeof old_str !== "string" || typeof new_str !== "string") {
        return "Error: write_file requires string fields { path, old_str, new_str }.";
      }
      const full = resolvePath(path);
      const current = await readTextFile(full);
      const occurrences = current.split(old_str).length - 1;
      if (occurrences === 0) {
        return `Error: old_str not found in ${path}. Read the file again and use an exact substring (whitespace matters).`;
      }
      if (occurrences > 1) {
        return `Error: old_str matches ${occurrences} locations in ${path}. Include more surrounding context so it matches exactly once.`;
      }
      const newContent = current.replace(old_str, new_str);
      if (!requireDiffReview) {
        await writeTextFile(full, newContent);
        onFileWritten?.(path, newContent);
        return `Applied: edited ${path}.`;
      }
      return await requestEdit({
        path,
        fullPath: full,
        oldContent: current,
        newContent,
        isCreate: false,
      });
    }
    if (call.name === "create_file") {
      const { path, contents } = call.args;
      if (typeof path !== "string" || typeof contents !== "string") {
        return "Error: create_file requires string fields { path, contents }.";
      }
      const full = resolvePath(path);
      if (await exists(full)) {
        return `Error: ${path} already exists. Use write_file to modify an existing file.`;
      }
      if (!requireDiffReview) {
        await writeTextFile(full, contents);
        onFileWritten?.(path, contents);
        return `Applied: created ${path} (${contents.length} chars).`;
      }
      return await requestEdit({
        path,
        fullPath: full,
        oldContent: "",
        newContent: contents,
        isCreate: true,
      });
    }
    return `Error: unknown tool "${call.name}"`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Error: ${msg}`;
  }
}

function toOllamaMessage(m: Msg): any {
  if (m.role === "assistant") {
    const out: any = { role: "assistant", content: m.content };
    if (m.toolCalls && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls.map((tc) => ({
        function: { name: tc.name, arguments: tc.args },
      }));
    }
    return out;
  }
  if (m.role === "tool") {
    return { role: "tool", content: m.content, name: m.toolName };
  }
  if (m.role === "user" && m.attachments && m.attachments.length > 0) {
    const ctx = m.attachments
      .map((a) => `File: ${a.path}\n\`\`\`\n${a.content}\n\`\`\``)
      .join("\n\n");
    return {
      role: "user",
      content: `${m.content}\n\n[Files the user attached for context — read more with read_file if needed:]\n${ctx}`,
    };
  }
  return { role: m.role, content: m.content };
}

// Directories never worth indexing for @-mentions — build artifacts and vendored deps.
const WALK_IGNORE = new Set([
  "node_modules", ".git", "target", "dist", "build", ".next", ".turbo",
  ".cache", "out", "coverage", ".venv", "__pycache__", ".idea",
]);

// One bounded recursive pass over the workspace, returning sorted relative paths.
// Capped on count and depth so a huge repo can't hang the picker.
async function listWorkspaceFiles(root: string): Promise<string[]> {
  const MAX = 4000;
  const out: string[] = [];
  async function walk(abs: string, rel: string, depth: number) {
    if (out.length >= MAX || depth > 8) return;
    let entries;
    try {
      entries = await readDir(abs);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (!WALK_IGNORE.has(e.name)) await walk(`${abs}/${e.name}`, childRel, depth + 1);
      } else {
        out.push(childRel);
      }
    }
  }
  await walk(root, "", 0);
  return out.sort();
}

// Subsequence fuzzy match; basename and prefix hits rank highest. Top 8.
function fuzzyFiles(files: string[], query: string): string[] {
  const q = query.toLowerCase();
  if (!q) return files.slice(0, 8);
  const scored: { path: string; score: number }[] = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    const base = lower.split("/").pop() ?? lower;
    let score = -1;
    if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    else if (isSubsequence(q, lower)) score = 3;
    if (score >= 0) scored.push({ path, score });
  }
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length);
  return scored.slice(0, 8).map((s) => s.path);
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

function parseToolCallsFromChunk(raw: any): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((tc) => {
      const fn = tc.function ?? tc;
      const name = fn?.name;
      let args = fn?.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = { _raw: args };
        }
      }
      return name ? { name, args: args ?? {} } : null;
    })
    .filter((x): x is ToolCall => x !== null);
}

type Conversation = {
  id: string;
  title: string;
  msgs: Msg[];
  updatedAt: number;
};

const CONVOS_KEY = "klide-conversations";

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(CONVOS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveConversations(list: Conversation[]) {
  try {
    localStorage.setItem(CONVOS_KEY, JSON.stringify(list));
  } catch {
    /* storage full or unavailable — skip */
  }
}

function deriveTitle(msgs: Msg[]): string {
  const firstUser = msgs.find((m) => m.role === "user");
  const text = firstUser?.content.trim() ?? "";
  if (!text) return "New chat";
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}

function relativeTime(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

type MdNode = string | ReactElement;

const CODE_KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "do", "switch", "case", "break", "continue", "new", "class", "extends",
  "super", "import", "export", "from", "default", "async", "await", "yield",
  "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of",
  "this", "void", "delete", "static", "public", "private", "protected",
  "readonly", "interface", "type", "enum", "implements", "namespace", "as",
  "keyof", "get", "set", "fn", "mut", "impl", "trait", "struct", "pub", "use",
  "mod", "match", "loop", "move", "ref", "where", "dyn", "crate", "self",
  "unsafe", "def", "lambda", "elif", "with", "pass", "global", "nonlocal",
  "raise", "except", "and", "or", "not", "true", "false", "null", "undefined",
  "None", "True", "False",
]);

const CODE_TOKEN_RE =
  /(\/\/[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)/g;

function highlightCode(code: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  CODE_TOKEN_RE.lastIndex = 0;
  while ((m = CODE_TOKEN_RE.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const [full, comment, str, num, word] = m;
    if (comment) {
      out.push(
        <span key={key++} style={{ color: "var(--code-comment)", fontStyle: "italic" }}>
          {full}
        </span>
      );
    } else if (str) {
      out.push(<span key={key++} style={{ color: "var(--code-string)" }}>{full}</span>);
    } else if (num) {
      out.push(<span key={key++} style={{ color: "var(--code-number)" }}>{full}</span>);
    } else if (word && CODE_KEYWORDS.has(word)) {
      out.push(<span key={key++} style={{ color: "var(--code-keyword)" }}>{full}</span>);
    } else {
      out.push(full);
    }
    last = m.index + full.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable in this context */
    }
  }
  return (
    <div
      style={{
        margin: "8px 0",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        overflow: "hidden",
        background: "var(--bg-elevated)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "3px 6px 3px 10px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span
          style={{
            fontSize: 10,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "var(--fg-subtle)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {lang || "code"}
        </span>
        <button
          onClick={copy}
          title="Copy code"
          style={{
            fontSize: 10,
            color: copied ? "var(--accent)" : "var(--fg-subtle)",
            padding: "2px 7px",
            borderRadius: "var(--radius-xs)",
          }}
          onMouseEnter={(e) => {
            if (!copied) {
              e.currentTarget.style.color = "var(--fg-strong)";
              e.currentTarget.style.background = "var(--bg-hover)";
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--fg-subtle)";
            e.currentTarget.style.background = "transparent";
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "10px 12px",
          overflowX: "auto",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.55,
          color: "var(--fg-strong)",
          whiteSpace: "pre",
        }}
      >
        <code>{highlightCode(code)}</code>
      </pre>
    </div>
  );
}

const INLINE_RE = /\*\*(.+?)\*\*|`([^`]+)`|\*(.+?)\*|\[([^\]]+)\]\(([^)]+)\)/g;

function renderInline(text: string, keyBase: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(
        <strong key={`${keyBase}-${key++}`} style={{ color: "var(--fg-strong)", fontWeight: 600 }}>
          {m[1]}
        </strong>
      );
    } else if (m[2] !== undefined) {
      out.push(
        <code
          key={`${keyBase}-${key++}`}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-xs)",
            padding: "1px 5px",
            color: "var(--fg-strong)",
          }}
        >
          {m[2]}
        </code>
      );
    } else if (m[3] !== undefined) {
      out.push(<em key={`${keyBase}-${key++}`}>{m[3]}</em>);
    } else if (m[4] !== undefined) {
      out.push(
        <span
          key={`${keyBase}-${key++}`}
          title={m[5]}
          style={{ color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: 2 }}
        >
          {m[4]}
        </span>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderProse(text: string, keyBase: string): MdNode[] {
  const lines = text.split("\n");
  const blocks: MdNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let k = 0;

  const flushPara = () => {
    if (para.length === 0) return;
    const content: MdNode[] = [];
    para.forEach((ln, i) => {
      if (i > 0) content.push(<br key={`br-${keyBase}-${k}-${i}`} />);
      content.push(...renderInline(ln, `${keyBase}-p${k}-${i}`));
    });
    blocks.push(
      <div key={`${keyBase}-para-${k++}`} style={{ margin: "2px 0" }}>
        {content}
      </div>
    );
    para = [];
  };

  const flushList = () => {
    if (!list) return;
    const current = list;
    const items = current.items.map((it, i) => (
      <li key={`${keyBase}-li-${k}-${i}`} style={{ margin: "1px 0" }}>
        {renderInline(it, `${keyBase}-li${k}-${i}`)}
      </li>
    ));
    const style = { margin: "4px 0", paddingLeft: 18 };
    blocks.push(
      current.ordered ? (
        <ol key={`${keyBase}-ol-${k++}`} style={style}>{items}</ol>
      ) : (
        <ul key={`${keyBase}-ul-${k++}`} style={style}>{items}</ul>
      )
    );
    list = null;
  };

  for (const line of lines) {
    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      const size = level === 1 ? 15 : level === 2 ? 14 : 13;
      blocks.push(
        <div
          key={`${keyBase}-h-${k++}`}
          style={{ fontWeight: 600, fontSize: size, color: "var(--fg-strong)", margin: "8px 0 2px" }}
        >
          {renderInline(heading[2], `${keyBase}-hh${k}`)}
        </div>
      );
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(ul[1]);
      continue;
    }
    if (ol) {
      flushPara();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ol[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}

// Reasoning models stream their chain-of-thought wrapped in <think>…</think>
// inside the normal content. This pulls that out so we can show it separately.
// Handles the streaming case where <think> has arrived but </think> hasn't yet:
// everything after an unclosed <think> is treated as in-progress thinking.
function splitThinking(raw: string): { thinking: string; content: string } {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let thinking = "";
  let content = "";
  let rest = raw;
  while (true) {
    const open = rest.indexOf(OPEN);
    if (open === -1) {
      content += rest;
      break;
    }
    content += rest.slice(0, open);
    const after = rest.slice(open + OPEN.length);
    const close = after.indexOf(CLOSE);
    if (close === -1) {
      thinking += after; // still streaming inside the think block
      break;
    }
    thinking += after.slice(0, close);
    rest = after.slice(close + CLOSE.length);
  }
  return { thinking, content: content.replace(/^\s+/, "") };
}

function renderMarkdown(text: string): MdNode[] {
  const segments = text.split("```");
  const out: MdNode[] = [];
  segments.forEach((seg, idx) => {
    if (idx % 2 === 1) {
      // fenced code (may be unclosed while streaming — still render it)
      const nl = seg.indexOf("\n");
      let lang = "";
      let code = seg;
      if (nl >= 0) {
        const first = seg.slice(0, nl).trim();
        if (/^[\w+#-]*$/.test(first)) {
          lang = first;
          code = seg.slice(nl + 1);
        }
      }
      code = code.replace(/\n$/, "");
      out.push(<CodeBlock key={`code-${idx}`} code={code} lang={lang} />);
    } else if (seg) {
      out.push(...renderProse(seg, `seg-${idx}`));
    }
  });
  return out;
}

function BouncingDots() {
  return (
    <div className="loader-bounce" aria-label="Model is thinking">
      <span />
      <span />
      <span />
    </div>
  );
}

function OrbitLoader() {
  return (
    <div className="loader-orbit" aria-label="Waiting for output">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function SendIcon() {
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

function NewChatIcon() {
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

function HistoryIcon() {
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

function DuplicateIcon() {
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

export function AiPanel({
  workspaceRoot,
  onFileWritten,
  visible,
  width,
  fill,
  model,
  onModelChange,
  availableModels,
  onAvailableModelsChange,
  requireDiffReview,
  stopAfterRejection,
  skills,
  onDuplicate,
  onClose,
}: Props) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [activity, setActivity] = useState<"thinking" | "waiting" | null>(null);
  const [pending, setPending] = useState<PendingEditRequest | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [agentMode, setAgentMode] = useState<AgentMode>(
    () => (localStorage.getItem("klide.agentMode") as AgentMode) || "build"
  );
  // Whether the selected Ollama model declares the "tools" capability. Models
  // without it (e.g. many community GGUFs like Liquid's LFM2) 400 on any chat
  // request that includes a `tools` field, so we detect support up front and
  // fall back to plain chat — Build mode (which edits via tools) is locked off.
  const [modelSupportsTools, setModelSupportsTools] = useState(true);
  const toggleMode = () => {
    if (!modelSupportsTools) return; // locked to chat — no tools, no Build
    setNextSendMode(null); // an explicit toggle overrides any one-shot override
    setAgentMode((m) => {
      const next = m === "build" ? "plan" : "build";
      localStorage.setItem("klide.agentMode", next);
      return next;
    });
  };

  // @-mention file picker state.
  const [fileList, setFileList] = useState<string[]>([]);
  const [mention, setMention] = useState<{ query: string } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const mentionMatches =
    mention !== null ? fuzzyFiles(fileList, mention.query) : [];

  // Provider switcher state. Persisted, but only "ollama" is functional today.
  const [provider, setProvider] = useState<ProviderId>(
    () => (localStorage.getItem("klide.provider") as ProviderId) || "ollama"
  );
  const [providerOpen, setProviderOpen] = useState(false);
  const providerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!providerOpen) return;
    function onDown(e: MouseEvent) {
      if (
        providerRef.current &&
        !providerRef.current.contains(e.target as Node)
      ) {
        setProviderOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [providerOpen]);
  function selectProvider(id: ProviderId) {
    setProvider(id);
    localStorage.setItem("klide.provider", id);
    setProviderOpen(false);
  }

  // Slash-command palette state.
  const [slash, setSlash] = useState<{ query: string } | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  // Forces the NEXT send to a given mode, then resets — e.g. /explain must be
  // read-only so the agent can't edit a file you only asked it to describe.
  const [nextSendMode, setNextSendMode] = useState<AgentMode | null>(null);
  const SLASH_COMMANDS: {
    name: string;
    desc: string;
    run: () => void;
  }[] = [
    {
      name: "plan",
      desc: "Switch to Plan mode (read-only, proposes a plan)",
      run: () => {
        setAgentMode("plan");
        localStorage.setItem("klide.agentMode", "plan");
        setInput("");
      },
    },
    {
      name: "build",
      desc: "Switch to Build mode (can propose edits)",
      run: () => {
        setAgentMode("build");
        localStorage.setItem("klide.agentMode", "build");
        setInput("");
      },
    },
    {
      name: "clear",
      desc: "Start a new conversation",
      run: () => newConversation(),
    },
    {
      name: "explain",
      desc: "Explain a file — pick one next (read-only)",
      run: () => {
        setInput("Explain what this file does and how it works: @");
        setNextSendMode("plan"); // read-only: never edits the file you ask about
        setMention({ query: "" });
        setMentionIdx(0);
        void ensureFileList();
        requestAnimationFrame(() => taRef.current?.focus());
      },
    },
    {
      name: "init",
      desc: "Analyze the repo and create a CLAUDE.md",
      run: () =>
        void send({
          mode: "build",
          text:
            "Explore this project (read key files like package.json, README, and the main source folders) and create a concise CLAUDE.md at the workspace root documenting what the project is, its stack, how to run it, and the repo layout. Use create_file so I can review the diff.",
        }),
    },
  ];
  const slashMatches =
    slash !== null
      ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slash.query.toLowerCase()))
      : [];

  function acceptSlash(idx: number) {
    const cmd = slashMatches[idx];
    setSlash(null);
    if (cmd) cmd.run();
  }

  // Drop the cached index when the open folder changes; it reloads on next "@".
  useEffect(() => {
    setFileList([]);
  }, [workspaceRoot]);

  // Auto-load a project rules file (OpenCode's AGENTS.md convention, or Klide's
  // own CLAUDE.md) into the system prompt so the agent respects house rules.
  const [projectRules, setProjectRules] = useState("");
  useEffect(() => {
    let cancelled = false;
    async function loadRules() {
      if (!workspaceRoot) {
        setProjectRules("");
        return;
      }
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        try {
          const full = `${workspaceRoot}/${name}`;
          if (!(await exists(full))) continue;
          let text = await readTextFile(full);
          if (text.length > 6000) text = text.slice(0, 6000) + "\n…(truncated)";
          if (!cancelled) setProjectRules(text.trim());
          return;
        } catch {
          /* try the next candidate */
        }
      }
      if (!cancelled) setProjectRules("");
    }
    void loadRules();
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot]);

  // Index the workspace lazily, the first time the user types "@".
  async function ensureFileList() {
    if (!workspaceRoot || fileList.length > 0) return;
    try {
      setFileList(await listWorkspaceFiles(workspaceRoot));
    } catch {
      /* leave empty; the picker just shows nothing */
    }
  }

  // Track an in-progress "@query" sitting just before the caret.
  function handleComposerChange(value: string, caret: number) {
    setInput(value);

    // Slash palette: only when the whole input is a single "/word" at the start.
    const slashMatch = value.match(/^\/(\w*)$/);
    if (slashMatch) {
      setSlash({ query: slashMatch[1] });
      setSlashIdx(0);
      setMention(null);
      return;
    } else if (slash !== null) {
      setSlash(null);
    }

    const before = value.slice(0, caret);
    const m = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (m) {
      setMention({ query: m[1] });
      setMentionIdx(0);
      void ensureFileList();
    } else if (mention !== null) {
      setMention(null);
    }
  }

  // Replace the partial "@query" with the chosen "@path " token.
  function acceptMention(path: string) {
    const ta = taRef.current;
    const caret = ta ? ta.selectionStart : input.length;
    const before = input.slice(0, caret);
    const at = before.lastIndexOf("@");
    const newBefore = before.slice(0, at) + "@" + path + " ";
    const next = newBefore + input.slice(caret);
    setInput(next);
    setMention(null);
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(newBefore.length, newBefore.length);
    });
  }

  // Read the files referenced by "@path" tokens so their contents can ride
  // along to the model. Bounded: at most 6 files, ~12k chars each.
  async function collectAttachments(text: string): Promise<Attachment[]> {
    if (!workspaceRoot) return [];
    const known = new Set(fileList);
    const tokens = [...text.matchAll(/@([^\s@]+)/g)].map((m) => m[1]);
    const paths = [...new Set(tokens)]
      .filter((p) => (fileList.length ? known.has(p) : p.includes(".")))
      .filter((p) => !p.includes(".."))
      .slice(0, 6);
    const out: Attachment[] = [];
    for (const p of paths) {
      try {
        const full = `${workspaceRoot}/${p}`;
        if (!(await exists(full))) continue;
        let content = await readTextFile(full);
        if (content.length > 12000) content = content.slice(0, 12000) + "\n…(truncated)";
        out.push({ path: p, content });
      } catch {
        /* skip unreadable files */
      }
    }
    return out;
  }
  const [conversations, setConversations] = useState<Conversation[]>(() =>
    loadConversations()
  );
  const [currentId, setCurrentId] = useState<string>(() => genId());
  const [historyOpen, setHistoryOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  function newConversation() {
    setHistoryOpen(false);
    setMsgs([]);
    setInput("");
    setCurrentId(genId());
  }

  function loadConversation(c: Conversation) {
    setHistoryOpen(false);
    setCurrentId(c.id);
    setMsgs(c.msgs);
  }

  function deleteConversation(id: string, e: ReactMouseEvent) {
    e.stopPropagation();
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      saveConversations(next);
      return next;
    });
    if (id === currentId) {
      setMsgs([]);
      setCurrentId(genId());
    }
  }

  function requestEdit(
    req: Omit<PendingEditRequest, "resolve">
  ): Promise<string> {
    return new Promise((resolve) => {
      setPending({ ...req, resolve });
    });
  }

  async function applyPending() {
    if (!pending) return;
    const p = pending;
    setPending(null);
    try {
      await writeTextFile(p.fullPath, p.newContent);
      onFileWritten?.(p.path, p.newContent);
      p.resolve(
        p.isCreate
          ? `Applied: created ${p.path} (${p.newContent.length} chars).`
          : `Applied: edited ${p.path}.`
      );
    } catch (e) {
      p.resolve(`Error writing ${p.path}: ${(e as Error).message}`);
    }
  }

  function rejectPending() {
    if (!pending) return;
    const p = pending;
    setPending(null);
    p.resolve(
      p.isCreate
        ? `Rejected by user: ${p.path} was not created.`
        : `Rejected by user: ${p.path} was not changed.`
    );
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [input]);

  // Auto-save the current conversation once a turn settles (not mid-stream).
  useEffect(() => {
    if (streaming || msgs.length === 0) return;
    setConversations((prev) => {
      const conv: Conversation = {
        id: currentId,
        title: deriveTitle(msgs),
        msgs,
        updatedAt: Date.now(),
      };
      const next = [conv, ...prev.filter((c) => c.id !== currentId)];
      saveConversations(next);
      return next;
    });
  }, [msgs, streaming, currentId]);

  // Close the history menu on an outside click.
  useEffect(() => {
    if (!historyOpen) return;
    function onDown(e: MouseEvent) {
      if (
        historyRef.current &&
        !historyRef.current.contains(e.target as Node)
      ) {
        setHistoryOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [historyOpen]);

  useEffect(() => {
    let cancelled = false;
    async function loadOllamaModels() {
      try {
        const res = await fetch("http://localhost:11434/api/tags");
        if (!res.ok) {
          setConnected(false);
          return;
        }
        if (!cancelled) setConnected(true);
        const data = await res.json();
        const names = Array.isArray(data.models)
          ? data.models
              .map((m: { name?: string }) => m.name)
              .filter((name: unknown): name is string => typeof name === "string")
          : [];
        if (!cancelled && names.length > 0) {
          onAvailableModelsChange(names);
          if (!names.includes(model)) onModelChange(names[0]);
        }
      } catch {
        if (!cancelled) setConnected(false);
        /* Ollama may be offline; keep the configured fallback model. */
      }
    }
    loadOllamaModels();
    return () => {
      cancelled = true;
    };
  }, [model, onAvailableModelsChange, onModelChange]);

  // Ask Ollama whether the selected model can call tools. /api/show returns a
  // `capabilities` array — tool-capable models list "tools". We default to
  // "supported" so a transient/offline check never wrongly locks the UI.
  useEffect(() => {
    let cancelled = false;
    async function checkToolSupport() {
      try {
        const res = await fetch("http://localhost:11434/api/show", {
          method: "POST",
          body: JSON.stringify({ model }),
        });
        if (!res.ok) return;
        const data = await res.json();
        const caps = data.capabilities;
        const supports = Array.isArray(caps) && caps.includes("tools");
        if (!cancelled) setModelSupportsTools(supports);
      } catch {
        /* Ollama offline — assume supported; the request path handles errors. */
      }
    }
    checkToolSupport();
    return () => {
      cancelled = true;
    };
  }, [model]);

  async function streamOnce(
    history: Msg[],
    mode: AgentMode
  ): Promise<{ text: string; toolCalls: ToolCall[] }> {
    const sys: Msg = {
      role: "system",
      content: buildSystemPrompt(
        workspaceRoot,
        stopAfterRejection,
        skills,
        mode,
        projectRules
      ),
    };

    const res = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      body: JSON.stringify({
        model,
        messages: [sys, ...history].map(toOllamaMessage),
        // Models without tool support 400 if `tools` is present at all, so we
        // omit the field entirely for them (JSON.stringify drops undefined).
        tools: modelSupportsTools ? toolsForMode(mode) : undefined,
        stream: true,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`Ollama returned ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let raw = ""; // all streamed content, may contain inline <think> blocks
    let nativeThinking = ""; // Ollama's separate `thinking` field, if any
    const toolCalls: ToolCall[] = [];

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const j = JSON.parse(line);
        raw += j.message?.content ?? "";
        nativeThinking += j.message?.thinking ?? "";
        const newCalls = parseToolCallsFromChunk(j.message?.tool_calls);
        if (newCalls.length) toolCalls.push(...newCalls);
        const { thinking: inline, content } = splitThinking(raw);
        const thinking = [nativeThinking, inline]
          .filter(Boolean)
          .join("\n")
          .trim();
        setMsgs((cur) => {
          const next = [...cur];
          next[next.length - 1] = {
            role: "assistant",
            content,
            thinking: thinking || undefined,
            toolCalls: toolCalls.length ? [...toolCalls] : undefined,
          };
          return next;
        });
      } catch {
        /* partial line */
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    }
    if (buf.trim()) handleLine(buf);
    // History keeps only the visible answer — reasoning isn't fed back to the model.
    return { text: splitThinking(raw).content, toolCalls };
  }

  async function send(opts?: { text?: string; mode?: AgentMode }) {
    const text = opts?.text ?? input;
    if (!text.trim() || streaming) return;
    // A model with no tool support can only chat; never run Build for it.
    const mode = !modelSupportsTools
      ? "plan"
      : opts?.mode ?? nextSendMode ?? agentMode;

    setInput("");
    setMention(null);
    setSlash(null);
    setNextSendMode(null);
    const attachments = await collectAttachments(text);

    let history: Msg[] = [
      ...msgs,
      {
        role: "user",
        content: text,
        attachments: attachments.length ? attachments : undefined,
      },
      { role: "assistant", content: "" },
    ];
    setMsgs(history);
    setStreaming(true);
    setActivity("thinking");

    try {
      for (let iter = 0; iter < MAX_TOOL_CALLS; iter++) {
        setActivity("thinking");
        const { text, toolCalls } = await streamOnce(history.slice(0, -1), mode);
        history = [
          ...history.slice(0, -1),
          {
            role: "assistant",
            content: text,
            toolCalls: toolCalls.length ? toolCalls : undefined,
          },
        ];

        if (toolCalls.length === 0) break;

        const toolMsgs: Msg[] = [];
        for (const call of toolCalls) {
          setActivity("waiting");
          const result = await executeTool(
            call,
            workspaceRoot,
            requestEdit,
            requireDiffReview,
            onFileWritten
          );
          toolMsgs.push({ role: "tool", content: result, toolName: call.name });
        }

        setActivity("thinking");
        history = [
          ...history,
          ...toolMsgs,
          { role: "assistant", content: "" },
        ];
        setMsgs(history);
      }
    } catch (e) {
      setMsgs((cur) => {
        const next = [...cur];
        next[next.length - 1] = {
          role: "assistant",
          content: `⚠ ${(e as Error).message}. Is Ollama running?`,
        };
        return next;
      });
    }
    setStreaming(false);
    setActivity(null);
  }

  function renderMessageBody(m: Msg) {
    if (m.role === "tool") {
      return (
        <details>
          <summary
            style={{
              color: "var(--fg-muted)",
              cursor: "pointer",
              fontSize: 12,
              userSelect: "none",
            }}
          >
            ↳ {m.toolName} result
          </summary>
          <pre
            style={{
              fontSize: 11,
              color: "var(--fg-muted)",
              whiteSpace: "pre-wrap",
              margin: "6px 0 0",
              fontFamily: "var(--font-mono)",
            }}
          >
            {m.content}
          </pre>
        </details>
      );
    }

    if (m.role === "assistant") {
      return (
        <>
          {m.thinking && (
            <details
              open={!m.content}
              style={{
                marginBottom: 8,
                borderLeft: "2px solid var(--border-strong)",
                paddingLeft: 10,
              }}
            >
              <summary
                style={{
                  color: "var(--fg-muted)",
                  cursor: "pointer",
                  fontSize: 12,
                  userSelect: "none",
                }}
              >
                {m.content ? "Thought process" : "Thinking…"}
              </summary>
              <div
                style={{
                  fontSize: 12,
                  lineHeight: 1.55,
                  color: "var(--fg-muted)",
                  whiteSpace: "pre-wrap",
                  margin: "6px 0 0",
                }}
              >
                {m.thinking}
              </div>
            </details>
          )}
          {m.content && (
            <div style={{ marginBottom: m.toolCalls ? 6 : 0 }}>
              {renderMarkdown(m.content)}
            </div>
          )}
          {m.toolCalls?.map((tc, i) => (
            <div
              key={i}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--accent)",
                background: "var(--accent-soft)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                padding: "6px 10px",
                marginTop: i > 0 ? 4 : 0,
                wordBreak: "break-word",
              }}
            >
              <span style={{ color: "var(--fg-subtle)" }}>↳ </span>
              {tc.name}({JSON.stringify(tc.args)})
            </div>
          ))}
        </>
      );
    }

    return <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>;
  }

  return (
    <>
    <aside
      className="floating-panel"
      style={{
        width: fill ? "100%" : width,
        height: fill ? "100%" : undefined,
        margin: fill ? 0 : "4px 4px 4px 0",
        display: fill || visible ? "flex" : "none",
        flexDirection: "column",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "8px 10px",
          fontSize: 11,
          color: "var(--fg-subtle)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          fontWeight: 500,
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div
          ref={providerRef}
          style={{
            position: "relative",
            minWidth: 0,
            textTransform: "none",
            letterSpacing: 0,
          }}
        >
          <button
            onClick={() => setProviderOpen((o) => !o)}
            title={
              provider === "ollama"
                ? connected
                  ? "Ollama · connected"
                  : "Ollama · not reachable on localhost:11434"
                : "Choose AI provider"
            }
            aria-haspopup="menu"
            aria-expanded={providerOpen}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              maxWidth: 200,
              height: 24,
              padding: "0 6px",
              borderRadius: "var(--radius-sm)",
              background: providerOpen ? "var(--bg-hover)" : "transparent",
              color: providerOpen ? "var(--fg-strong)" : "var(--fg-subtle)",
              cursor: "pointer",
              transition:
                "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--fg-strong)";
              e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              if (!providerOpen) {
                e.currentTarget.style.color = "var(--fg-subtle)";
                e.currentTarget.style.background = "transparent";
              }
            }}
          >
            <ProviderLogo id={provider} size={14} />
            <span
              style={{
                fontSize: 12,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {providerName(provider)}
            </span>
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
          </button>
          {providerOpen && (
            <div
              role="menu"
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                left: 0,
                minWidth: 200,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-strong)",
                borderRadius: "var(--radius-md)",
                boxShadow: "0 6px 24px rgba(38, 38, 32, 0.14)",
                padding: 4,
                zIndex: 30,
              }}
            >
              {PROVIDER_GROUPS.map((group) => (
                <div key={group.label} style={{ marginBottom: 2 }}>
                  <div
                    style={{
                      fontSize: 9.5,
                      fontWeight: 600,
                      letterSpacing: "0.07em",
                      textTransform: "uppercase",
                      color: "var(--fg-dim)",
                      padding: "6px 8px 3px",
                    }}
                  >
                    {group.label}
                  </div>
                  {group.items.map((item) => {
                    const active = item.id === provider;
                    return (
                      <button
                        key={item.id}
                        role="menuitem"
                        disabled={!item.available}
                        onClick={() =>
                          item.available && selectProvider(item.id)
                        }
                        style={{
                          width: "100%",
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "6px 8px",
                          borderRadius: "var(--radius-sm)",
                          background: active
                            ? "var(--bg-hover)"
                            : "transparent",
                          color: item.available
                            ? "var(--fg-strong)"
                            : "var(--fg-dim)",
                          cursor: item.available ? "pointer" : "default",
                          fontSize: 12,
                          textAlign: "left",
                        }}
                        onMouseEnter={(e) => {
                          if (item.available && !active)
                            e.currentTarget.style.background = "var(--bg-hover)";
                        }}
                        onMouseLeave={(e) => {
                          if (!active)
                            e.currentTarget.style.background = "transparent";
                        }}
                      >
                        <span
                          style={{
                            display: "grid",
                            placeItems: "center",
                            flexShrink: 0,
                            color: item.available
                              ? "var(--fg-subtle)"
                              : "var(--fg-dim)",
                          }}
                        >
                          <ProviderLogo id={item.id} size={15} />
                        </span>
                        <span
                          style={{
                            flex: 1,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {item.name}
                        </span>
                        {active && (
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
                        )}
                        {!item.available && (
                          <span
                            style={{
                              fontSize: 9.5,
                              fontWeight: 500,
                              letterSpacing: "0.04em",
                              textTransform: "uppercase",
                              color: "var(--fg-dim)",
                              border: "1px solid var(--border-strong)",
                              borderRadius: 999,
                              padding: "1px 6px",
                            }}
                          >
                            Soon
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        <div
          ref={historyRef}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            position: "relative",
            textTransform: "none",
            letterSpacing: 0,
          }}
        >
          <button
            onClick={() => onDuplicate?.()}
            title="Duplicate panel"
            aria-label="Duplicate panel"
            style={{
              width: 26,
              height: 22,
              display: "grid",
              placeItems: "center",
              borderRadius: "var(--radius-sm)",
              color: "var(--fg-subtle)",
              background: "transparent",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--fg-strong)";
              e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--fg-subtle)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            <DuplicateIcon />
          </button>
          <button
            onClick={() => setHistoryOpen((o) => !o)}
            title="Conversation history"
            aria-label="Conversation history"
            aria-expanded={historyOpen}
            style={{
              width: 26,
              height: 22,
              display: "grid",
              placeItems: "center",
              borderRadius: "var(--radius-sm)",
              color: historyOpen ? "var(--fg-strong)" : "var(--fg-subtle)",
              background: historyOpen ? "var(--bg-hover)" : "transparent",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--fg-strong)";
              e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              if (!historyOpen) {
                e.currentTarget.style.color = "var(--fg-subtle)";
                e.currentTarget.style.background = "transparent";
              }
            }}
          >
            <HistoryIcon />
          </button>
          <button
            onClick={newConversation}
            title="New conversation"
            aria-label="New conversation"
            style={{
              width: 26,
              height: 22,
              display: "grid",
              placeItems: "center",
              borderRadius: "var(--radius-sm)",
              color: "var(--fg-subtle)",
              background: "transparent",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--fg-strong)";
              e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--fg-subtle)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            <NewChatIcon />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              title="Close panel"
              aria-label="Close panel"
              style={{
                width: 26,
                height: 22,
                display: "grid",
                placeItems: "center",
                borderRadius: "var(--radius-sm)",
                color: "var(--fg-subtle)",
                background: "transparent",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--fg-strong)";
                e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--fg-subtle)";
                e.currentTarget.style.background = "transparent";
              }}
            >
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
            </button>
          )}

          {historyOpen && (
            <div
              className="floating-panel"
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                right: 0,
                width: 264,
                maxHeight: 340,
                overflow: "auto",
                padding: 6,
                zIndex: 20,
              }}
            >
              {conversations.length === 0 ? (
                <div
                  style={{
                    padding: "12px 8px",
                    color: "var(--fg-subtle)",
                    fontSize: 12,
                    textAlign: "center",
                  }}
                >
                  No past conversations yet.
                </div>
              ) : (
                conversations.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => loadConversation(c)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 8px",
                      borderRadius: "var(--radius-sm)",
                      cursor: "pointer",
                      background:
                        c.id === currentId
                          ? "var(--bg-selected)"
                          : "transparent",
                    }}
                    onMouseEnter={(e) => {
                      if (c.id !== currentId)
                        e.currentTarget.style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background =
                        c.id === currentId
                          ? "var(--bg-selected)"
                          : "transparent";
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: "var(--fg-strong)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {c.title}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--fg-subtle)",
                          marginTop: 1,
                        }}
                      >
                        {relativeTime(c.updatedAt)}
                      </div>
                    </div>
                    <button
                      onClick={(e) => deleteConversation(c.id, e)}
                      title="Delete conversation"
                      aria-label="Delete conversation"
                      style={{
                        flexShrink: 0,
                        width: 22,
                        height: 22,
                        display: "grid",
                        placeItems: "center",
                        borderRadius: "var(--radius-xs)",
                        color: "var(--fg-dim)",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = "var(--fg-strong)";
                        e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = "var(--fg-dim)";
                        e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </header>

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflow: "auto",
          padding: 12,
          fontSize: 13,
          display: msgs.length === 0 ? "grid" : "block",
          placeItems: msgs.length === 0 ? "center" : undefined,
          minHeight: 0,
        }}
      >
        {msgs.length === 0 && (
          <div
            style={{
              width: "min(260px, 80%)",
              textAlign: "center",
              color: "var(--fg-subtle)",
              lineHeight: 1.55,
              transform: "translateY(-10px)",
            }}
          >
            <div
              style={{
                width: 38,
                height: 38,
                margin: "0 auto 14px",
                borderRadius: "var(--radius-lg)",
                display: "grid",
                placeItems: "center",
                color: "var(--accent)",
                background: "color-mix(in srgb, var(--accent-soft) 70%, transparent)",
                border: "1px solid var(--panel-border)",
                boxShadow: "inset 0 1px 0 var(--panel-highlight)",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-ui)",
                  fontSize: 19,
                  fontWeight: 700,
                  lineHeight: 1,
                  letterSpacing: "-0.02em",
                }}
              >
                K
              </span>
            </div>
            <div
              style={{
                color: "var(--fg-strong)",
                fontSize: 14,
                fontWeight: 500,
                marginBottom: 6,
              }}
            >
              {workspaceRoot ? "Ask Klide" : "Open a workspace"}
            </div>
            <div style={{ fontSize: 12 }}>
              {workspaceRoot
                ? "Read, reason, and propose edits with your local Ollama model."
                : "Open a folder to enable local agent mode."}
            </div>
          </div>
        )}
        {msgs.map((m, i) => {
          const isLast = i === msgs.length - 1;
          const isStreamingPlaceholder =
            streaming &&
            isLast &&
            m.role === "assistant" &&
            m.content === "" &&
            !m.thinking &&
            !m.toolCalls;
          const isStreamingActive =
            streaming && isLast && m.role === "assistant" && m.content !== "";

          if (m.role === "user") {
            return (
              <div
                key={i}
                className="ai-msg-in"
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  margin: "16px 0",
                }}
              >
                <div
                  style={{
                    maxWidth: "88%",
                    background: "var(--accent-soft)",
                    color: "var(--fg-strong)",
                    borderRadius: "13px 13px 4px 13px",
                    padding: "8px 12px",
                    fontSize: 13,
                    lineHeight: 1.55,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {m.content}
                </div>
              </div>
            );
          }

          if (m.role === "tool") {
            return (
              <div
                key={i}
                className="ai-msg-in"
                style={{ margin: "8px 0 8px 32px" }}
              >
                {renderMessageBody(m)}
              </div>
            );
          }

          return (
            <div
              key={i}
              className="ai-msg-in"
              style={{ display: "flex", gap: 10, margin: "16px 0" }}
            >
              <div
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  width: 22,
                  height: 22,
                  marginTop: 1,
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  color: "var(--accent)",
                  background:
                    "color-mix(in srgb, var(--accent-soft) 80%, transparent)",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-ui)",
                    fontSize: 12,
                    fontWeight: 700,
                    lineHeight: 1,
                    letterSpacing: "-0.02em",
                  }}
                >
                  K
                </span>
              </div>
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  color: "var(--fg-strong)",
                  fontSize: 13,
                  lineHeight: 1.6,
                }}
              >
                {isStreamingPlaceholder ? (
                  <span
                    style={{
                      color: "var(--fg-dim)",
                      display: "inline-flex",
                      marginTop: 2,
                    }}
                  >
                    {activity === "waiting" ? <OrbitLoader /> : <BouncingDots />}
                  </span>
                ) : (
                  <>
                    {renderMessageBody(m)}
                    {isStreamingActive && <span className="ai-caret" />}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ padding: 10 }}>
        {(streaming || pending) && (
          <div
            style={{
              height: 18,
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: "var(--fg-subtle)",
              fontSize: 11,
              padding: "0 2px 6px",
            }}
          >
            {activity === "waiting" || pending ? <OrbitLoader /> : <BouncingDots />}
            <span>{activity === "waiting" || pending ? "Waiting for output" : "Thinking"}</span>
          </div>
        )}
        <div
          style={{
            position: "relative",
            border: `1px solid ${
              composerFocused ? "var(--accent)" : "var(--border-strong)"
            }`,
            borderRadius: "var(--radius-md)",
            background: "var(--bg)",
            boxShadow: composerFocused
              ? "0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent), 0 1px 2px rgba(38, 38, 32, 0.05)"
              : "0 1px 2px rgba(38, 38, 32, 0.04)",
            transition:
              "border-color var(--motion-med) var(--ease-out), box-shadow var(--motion-med) var(--ease-out)",
            opacity: streaming ? 0.7 : 1,
          }}
        >
          {slash !== null && slashMatches.length > 0 && (
            <div
              role="listbox"
              style={{
                position: "absolute",
                bottom: "calc(100% + 6px)",
                left: 0,
                right: 0,
                maxHeight: 240,
                overflowY: "auto",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-strong)",
                borderRadius: "var(--radius-md)",
                boxShadow: "0 6px 24px rgba(38, 38, 32, 0.14)",
                padding: 4,
                zIndex: 20,
              }}
            >
              {slashMatches.map((cmd, idx) => (
                <div
                  key={cmd.name}
                  role="option"
                  aria-selected={idx === slashIdx}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    acceptSlash(idx);
                  }}
                  onMouseEnter={() => setSlashIdx(idx)}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    padding: "6px 8px",
                    borderRadius: "var(--radius-sm)",
                    cursor: "pointer",
                    background:
                      idx === slashIdx ? "var(--bg-hover)" : "transparent",
                  }}
                >
                  <span
                    style={{
                      color: "var(--fg-strong)",
                      fontSize: 12,
                      fontWeight: 500,
                    }}
                  >
                    /{cmd.name}
                  </span>
                  <span
                    style={{
                      color: "var(--fg-dim)",
                      fontSize: 11,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {cmd.desc}
                  </span>
                </div>
              ))}
            </div>
          )}
          {mention !== null && mentionMatches.length > 0 && (
            <div
              role="listbox"
              style={{
                position: "absolute",
                bottom: "calc(100% + 6px)",
                left: 0,
                right: 0,
                maxHeight: 220,
                overflowY: "auto",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-strong)",
                borderRadius: "var(--radius-md)",
                boxShadow: "0 6px 24px rgba(38, 38, 32, 0.14)",
                padding: 4,
                zIndex: 20,
              }}
            >
              {mentionMatches.map((path, idx) => {
                const slash = path.lastIndexOf("/");
                const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
                const base = slash >= 0 ? path.slice(slash + 1) : path;
                return (
                  <div
                    key={path}
                    role="option"
                    aria-selected={idx === mentionIdx}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptMention(path);
                    }}
                    onMouseEnter={() => setMentionIdx(idx)}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 2,
                      padding: "5px 8px",
                      borderRadius: "var(--radius-sm)",
                      fontSize: 12,
                      cursor: "pointer",
                      background:
                        idx === mentionIdx ? "var(--bg-hover)" : "transparent",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                    }}
                  >
                    <span style={{ color: "var(--fg-strong)" }}>{base}</span>
                    <span
                      style={{
                        color: "var(--fg-dim)",
                        fontSize: 11,
                        textOverflow: "ellipsis",
                        overflow: "hidden",
                      }}
                    >
                      {dir && ` ${dir}`}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) =>
              handleComposerChange(e.target.value, e.target.selectionStart)
            }
            onKeyDown={(e) => {
              if (slash !== null && slashMatches.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashIdx((i) => (i + 1) % slashMatches.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashIdx(
                    (i) => (i - 1 + slashMatches.length) % slashMatches.length
                  );
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  acceptSlash(slashIdx);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSlash(null);
                  return;
                }
              }
              if (mention !== null && mentionMatches.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionIdx((i) => (i + 1) % mentionMatches.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIdx(
                    (i) => (i - 1 + mentionMatches.length) % mentionMatches.length
                  );
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  acceptMention(mentionMatches[mentionIdx]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMention(null);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              } else if (e.key === "Tab") {
                // OpenCode muscle memory: Tab flips Plan ⇄ Build.
                e.preventDefault();
                toggleMode();
              }
            }}
            onFocus={() => setComposerFocused(true)}
            onBlur={() => {
              setComposerFocused(false);
              setMention(null);
              setSlash(null);
            }}
            placeholder={
              streaming ? "Working…" : "Ask anything, @ to attach a file…"
            }
            disabled={streaming}
            rows={1}
            style={{
              width: "100%",
              minHeight: 38,
              maxHeight: 160,
              resize: "none",
              background: "transparent",
              border: "none",
              color: "var(--fg-strong)",
              font: "inherit",
              fontSize: 13,
              lineHeight: 1.5,
              padding: "10px 10px 2px",
              outline: "none",
              display: "block",
            }}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
              padding: "2px 6px 6px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <button
              onClick={toggleMode}
              disabled={streaming || !modelSupportsTools}
              title={
                !modelSupportsTools
                  ? `${model} can't use tools — chat only. Pick a tool-capable model (e.g. qwen2.5, llama3.1) to enable Plan/Build.`
                  : "Plan investigates and proposes; Build edits files. Press Tab to switch."
              }
              aria-label={
                !modelSupportsTools
                  ? `Chat mode: ${model} does not support tools.`
                  : `Agent mode: ${nextSendMode ?? agentMode}. Click or press Tab to switch.`
              }
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                height: 24,
                padding: "0 9px",
                flexShrink: 0,
                borderRadius: 999,
                border: "1px solid var(--border-strong)",
                background: "transparent",
                color: "var(--fg-subtle)",
                fontSize: 11,
                fontWeight: 500,
                letterSpacing: "0.01em",
                cursor: streaming ? "default" : "pointer",
                transition:
                  "color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
              }}
              onMouseEnter={(e) => {
                if (!streaming) e.currentTarget.style.color = "var(--fg-strong)";
              }}
              onMouseLeave={(e) =>
                (e.currentTarget.style.color = "var(--fg-subtle)")
              }
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  flexShrink: 0,
                  background:
                    modelSupportsTools && (nextSendMode ?? agentMode) === "build"
                      ? "var(--accent)"
                      : "var(--fg-dim)",
                  transition: "background var(--motion-med) var(--ease-out)",
                }}
              />
              {!modelSupportsTools
                ? "Chat"
                : (nextSendMode ?? agentMode) === "build"
                ? "Build"
                : "Plan"}
            </button>
            <div
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                minWidth: 0,
              }}
            >
              <select
                value={model}
                onChange={(e) => onModelChange(e.target.value)}
                disabled={streaming}
                title="Select an Ollama model"
                style={{
                  appearance: "none",
                  WebkitAppearance: "none",
                  MozAppearance: "none",
                  maxWidth: 180,
                  height: 24,
                  color: "var(--fg-subtle)",
                  background: "transparent",
                  border: "none",
                  borderRadius: "var(--radius-xs)",
                  font: "inherit",
                  fontSize: 11,
                  outline: "none",
                  padding: "0 18px 0 6px",
                  cursor: streaming ? "default" : "pointer",
                  textOverflow: "ellipsis",
                  transition: "color var(--motion-fast) var(--ease-out)",
                }}
                onMouseEnter={(e) => {
                  if (!streaming)
                    e.currentTarget.style.color = "var(--fg-strong)";
                }}
                onMouseLeave={(e) =>
                  (e.currentTarget.style.color = "var(--fg-subtle)")
                }
              >
                {availableModels.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                style={{
                  position: "absolute",
                  right: 4,
                  pointerEvents: "none",
                  color: "var(--fg-dim)",
                }}
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </div>
            </div>
            <button
              onClick={() => send()}
              disabled={!input.trim() || streaming}
              aria-label="Send message"
              title="Send (Enter)"
              style={{
                width: 28,
                height: 28,
                flexShrink: 0,
                display: "grid",
                placeItems: "center",
                borderRadius: "50%",
                color: input.trim() && !streaming ? "#fff" : "var(--fg-dim)",
                background:
                  input.trim() && !streaming
                    ? "var(--accent)"
                    : "var(--bg-elevated)",
                cursor: input.trim() && !streaming ? "pointer" : "default",
                transition:
                  "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out), filter var(--motion-fast) var(--ease-out)",
              }}
              onMouseEnter={(e) => {
                if (input.trim() && !streaming)
                  e.currentTarget.style.filter = "brightness(1.08)";
              }}
              onMouseLeave={(e) => (e.currentTarget.style.filter = "none")}
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
    </aside>
    {pending && (
      <DiffModal
        edit={{
          path: pending.path,
          oldContent: pending.oldContent,
          newContent: pending.newContent,
          isCreate: pending.isCreate,
        }}
        onApply={applyPending}
        onReject={rejectPending}
      />
    )}
    </>
  );
}

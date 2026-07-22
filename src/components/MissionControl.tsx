import { Fragment, Suspense, lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { listProviderModels } from "../ipc/aiProviders";
import { Tooltip } from "./Tooltip";
import { Kbd } from "./Kbd";
import { keysFor } from "../shortcuts";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  addTask,
  dispatchTask,
  getTaskBuffer,
  getTaskSessions,
  lastAgent,
  lastModel,
  removeTask,
  renameTask,
  stopTask,
  subscribeTasks,
  type TaskSession,
  type TaskSource,
} from "../tasks";
import {
  getKlideConvos,
  renameKlideConvo,
  subscribeKlideConvos,
} from "../klideConvos";
import { listMemory, subscribeMemoryChanged } from "../memory";
import type { ThemeId } from "../theme";
import {
  BOARD_SECTION_HINT,
  BOARD_SECTION_LABEL,
  BOARD_SECTION_ORDER,
  boardSectionForRun,
  fetchAgentRuns,
  fetchRunMessages,
  formatCost,
  formatFilesTouched,
  formatValidationStatus,
  formatValidationTitle,
  mergeRunPages,
  runAttentionReason,
  runBoardReason,
  runRoutineInfo,
  seedRuns,
  relativeTime,
  SOURCE_COLOR,
  SOURCE_LABEL,
  LIFECYCLE_COLOR,
  LIFECYCLE_LABEL,
  STATUS_COLOR,
  STATUS_LABEL,
  type Run,
  type RunBoardReasonTone,
  type RunBoardSection,
  type RunKind,
  type RunMessage,
  type RunSource,
  type RunStatus,
  type RunToolCall,
} from "../runs";
import {
  buildRunLedger,
  handoffTargetsFor,
  presentProjects,
  presentRunSources,
  projectMatchesFilter,
  projectName,
  readRunLedgerMetadata,
  runMatchesLedgerQuery,
  runLedgerKey,
  sourceMatchesFilter,
  writeRunLedgerMetadata,
  type ProjectFilter,
  type RunLedgerEntry,
  type RunLedgerMetadataStore,
  type RunSourceFilter,
} from "../runLedger";
import { resolveRunInspection } from "../runInspection";
import { compactConversationMessages, runMessagesToMarkdown } from "../transcripts";
import { DELEGATE_IDS, isDelegateId, type DelegateId } from "../delegates";
import { CheckpointPanel } from "./CheckpointPanel";
import { listCheckpoints } from "../agent/client";
import type { ArtifactRequest } from "./ArtifactInspector";
import { useArtifactInspector } from "../hooks/useArtifactInspector";
import { ProviderLogo } from "./ai/icons";
import type { ProviderId } from "../agent/types";
import {
  DEFAULT_MODELS,
  isDelegateProvider,
  providerName,
  selectableProviders,
} from "../agent/providers";
import { ModelPicker } from "./ai/ModelPicker";
import { dispatchRace, PartialRaceError, type RaceAgentPick } from "../agent/race";
import { listRaces, raceForRun, subscribeRaces, type RaceGroup, type RaceMember } from "../races";
import { refreshCustomCli } from "../customCli";
import { modelBrand } from "../modelBrand";
import { renderMarkdown } from "./markdown";
import { buildRunHandoff } from "../agentHandoff";
import { notify } from "../toast";

const ArtifactInspector = lazy(() =>
  import("./ArtifactInspector").then((module) => ({ default: module.ArtifactInspector }))
);

type GitBranchDiffSummary = {
  baseBranch: string;
  branch: string;
  mergeBase: string;
  diff: string;
  additions: number;
  deletions: number;
  files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
};

function patchForFile(diff: string, path: string): string {
  const lines = diff.replace(/\n$/, "").split("\n");
  const start = lines.findIndex(
    (line) => line.startsWith("diff --git ") && line.endsWith(` b/${path}`)
  );
  if (start < 0) return diff;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("diff --git ")) {
      end = i;
      break;
    }
  }
  return `${lines.slice(start, end).join("\n")}\n`;
}

// Mission Control — Klide's agentic control panel. A board of agent runs pulled
// from every tool you use (its own AI panel + external Claude Code / Codex
// sessions), grouped by status, with a metadata detail pane. Inspired by the
// 2026 "dispatch hub" pattern (GitHub Agent HQ, Antigravity Agent Manager,
// Codex app): aggregate every run in one place, filter by source, drill in.
//
// Devin-style delegation: the composer at the top is a todo list — add a
// task, it sits in Queued; open it and send an agent (claude / codex) to
// complete it. A dispatched task's detail pane is a live terminal you can
// watch, type into (take over), or stop. Klide's own AI-panel conversations
// are listed on the same board. Diff review on completion comes next.

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function isClaudeInternalSubagent(run: Pick<Run, "source" | "path">): boolean {
  return run.source === "claude-code" && run.path.includes("/subagents/");
}

// Minimal status text for places that need an explicit state. No colored
// dots: section headers and row copy already carry the hierarchy.
function StatusDot({
  status,
  size: _size = 7,
}: {
  status: RunStatus;
  size?: number;
}) {
  if (status !== "running" && status !== "waiting" && status !== "error") return null;
  return <span aria-hidden style={{ display: "none" }} />;
}

function RunAttentionBadge({ run, compact }: { run: Run; compact?: boolean }) {
  if (compact) return <StatusDot status={run.status} />;
  const section = boardSectionForRun(run);
  if (section === "ready_for_review") return null;
  return (
    <span
      title={BOARD_SECTION_LABEL[boardSectionForRun(run)]}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        width: 7,
        height: 7,
      }}
    >
      <StatusDot status={run.status} size={7} />
    </span>
  );
}

function boardReasonChipStyle(tone: RunBoardReasonTone): React.CSSProperties {
  const fg = reasonToneColor(tone);
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    height: 16,
    padding: "0 3px",
    borderRadius: "var(--radius-xs)",
    color: fg,
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    fontWeight: 500,
    lineHeight: 1,
    flexShrink: 0,
  };
}

function reasonToneColor(tone: RunBoardReasonTone): string {
  return tone === "danger" ? "var(--danger)" : "var(--fg-subtle)";
}

function RunReasonChip({ run }: { run: Run }) {
  const reason = runBoardReason(run);
  if (reason.tone === "success") return null;
  // Sub-agents finish into a "needs review" ("Waiting") state, but their review
  // rolls up to the parent run — so retire that chip on the sub-agent's own row
  // to keep the board quiet. (accent tone is only ever the review-pending state.)
  if (run.parentId && reason.tone === "accent") return null;
  return (
    <Tooltip label={reason.detail}>
      <span style={boardReasonChipStyle(reason.tone)}>{reason.label}</span>
    </Tooltip>
  );
}

function runTokenSummary(run: Run): string | null {
  const total = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
  if (total <= 0) return null;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M tok`;
  if (total >= 1_000) return `${Math.round(total / 100) / 10}k tok`;
  return `${total} tok`;
}

function RoutineBadge({ run }: { run: Pick<Run, "title"> }) {
  const routine = runRoutineInfo(run);
  if (!routine) return null;
  return (
    <Tooltip label={routine.label}>
    <span
      style={{
        flexShrink: 0,
        color: "var(--fg-subtle)",
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        lineHeight: 1,
      }}
    >
      {routine.cadence === "routine" ? "Routine" : routine.cadence}
    </span>
    </Tooltip>
  );
}

// Extract the model provider prefix from OpenCode model strings.
// Format: "opencode-go/minimax-m3" → provider: "opencode-go", name: "minimax-m3"
function modelProvider(model: string | null): string | null {
  if (!model) return null;
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(0, slash) : null;
}
function modelShortName(model: string | null): string | null {
  if (!model) return null;
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

// Providers whose model ids carry an "org/repo" prefix the row can drop —
// OpenRouter (deepseek/deepseek-v4-flash) and MLX (mlx-community/Qwen2.5-7B).
const MODEL_PREFIX_PROVIDERS = new Set(["openrouter", "mlx"]);

// Runtimes/routers that run *other makers'* models. For these the small
// subtitle mark shows the model's own maker (DeepSeek, Qwen, Google/Gemma, …)
// rather than repeating the runtime logo the avatar already carries; it falls
// back to the runtime mark when the maker isn't recognised.
const RUNTIME_MODEL_PROVIDERS = new Set([
  "openrouter",
  "mlx",
  "ollama",
  "lmstudio",
  "llamacpp",
  "vllm",
]);

// The model name as shown on a run row — "org/" prefix stripped for the
// prefixed providers, otherwise the id verbatim.
function runModelLabel(run: { provider?: string | null; model?: string | null }): string | null {
  if (!run.model) return null;
  return run.provider && MODEL_PREFIX_PROVIDERS.has(run.provider)
    ? modelShortName(run.model)
    : run.model;
}

function ModelProviderBadge({ model }: { model: string | null }) {
  const provider = modelProvider(model);
  if (!provider) return null;
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 600,
        fontFamily: "var(--font-mono)",
        letterSpacing: "0.04em",
        color: "var(--fg-subtle)",
        flexShrink: 0,
      }}
    >
      {provider}
    </span>
  );
}

// Official brand marks served from /public, so each run wears its tool's real
// logo instead of a flat color. Used for model badges in the RunRow subtitle
// and for source avatars (Claude Code, Codex).
function DeepSeekLogo({ size = 13 }: { size?: number }) {
  return (
    <img
      src="/deepseek-logo.png"
      alt=""
      aria-hidden="true"
      style={{ width: size, height: size, objectFit: "contain", flexShrink: 0 }}
    />
  );
}
function MiniMaxLogo({ size = 13 }: { size?: number }) {
  return (
    <img
      src="/minimax-logo.png"
      alt=""
      aria-hidden="true"
      style={{ width: size, height: size, objectFit: "contain", flexShrink: 0 }}
    />
  );
}
// Kimi's K mark ships as two single-color variants (white for dark themes,
// black for light). Reuse the opencode-logo theme-swap classes from tokens.css
// — they stack both <img>s and show only the right one per theme.
function KimiLogo({ size = 13 }: { size?: number }) {
  return (
    <span className="opencode-logo" style={{ width: size, height: size, flexShrink: 0 }} aria-hidden="true">
      <img className="opencode-logo-light" src="/kimi-logo-light.svg" alt="" />
      <img className="opencode-logo-dark" src="/kimi-logo-dark.svg" alt="" />
    </span>
  );
}
function ClaudeCodeLogo({ size = 13 }: { size?: number }) {
  return (
    <img
      src="/claude-code-logo.png"
      alt=""
      aria-hidden="true"
      style={{ width: size, height: size, objectFit: "contain", flexShrink: 0 }}
    />
  );
}
// Klide's own brand mark (the app icon). Worn by Klide-harness runs that go
// through a model proxy like OpenRouter, where the model could be anything —
// the run belongs to Klide's harness, so it carries the Klide mark, not the
// underlying maker's logo.
function KlideLogo({ size = 13 }: { size?: number }) {
  return (
    <img
      src="/klide-logo.png"
      alt=""
      aria-hidden="true"
      style={{ width: size, height: size, objectFit: "contain", flexShrink: 0 }}
    />
  );
}
// Codex and Z.AI marks are white-on-transparent — invert them on light themes
// via the white-logo-img rule in tokens.css so they stay visible everywhere.
function CodexLogo({ size = 13 }: { size?: number }) {
  return (
    <img
      className="white-logo-img"
      src="/codex-logo.png"
      alt=""
      aria-hidden="true"
      style={{ width: size, height: size, objectFit: "contain", flexShrink: 0 }}
    />
  );
}
function ZaiLogo({ size = 13 }: { size?: number }) {
  return (
    <img
      className="white-logo-img"
      src="/zai-logo.png"
      alt=""
      aria-hidden="true"
      style={{ width: size, height: size, objectFit: "contain", flexShrink: 0 }}
    />
  );
}

// Oh My Pi mark — uses the same ProviderLogo(id="omp") as the AI panel
// dropdown, so the run list and the AI panel show the same mark.
function OmpLogo({ size = 13 }: { size?: number }) {
  return <ProviderLogo id="omp" size={size} />;
}

// Anthropic company mark, hardcoded in Anthropic orange (#D97757). The
// A-shape is filled on the path directly (not via `currentColor`) so the
// brand color can never be defeated by an inherited CSS rule.
const ANTHROPIC_BRAND_PATH =
  "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";

function AnthropicMark({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path
        d={ANTHROPIC_BRAND_PATH}
        fill="#D97757"
        style={{ fill: "#D97757" }}
      />
    </svg>
  );
}

type LogoComp = typeof DeepSeekLogo;
type AppUserInfo = { username: string; hostname: string; homeDir: string };

// Regex-based model → logo mapping. Keys are tested as RegExp against the model name.
// The first match wins, so order matters (more specific patterns first).
// OpenAI brand mark (the inline SVG from icons.tsx) for API models, kept
// distinct from the Codex *CLI product* logo. A Klide conversation on the
// OpenAI API (gpt-*, o1/o3/o4 reasoning models) is not Codex.
function OpenAiLogo({ size = 13 }: { size?: number }) {
  return <ProviderLogo id="openai" size={size} />;
}
const MODEL_LOGO_RULES: { pattern: RegExp; Comp: LogoComp }[] = [
  { pattern: /deepseek/i, Comp: DeepSeekLogo },
  { pattern: /minimax/i, Comp: MiniMaxLogo },
  { pattern: /kimi/i, Comp: KimiLogo },
  // Anthropic API models (claude-*) → the Anthropic company mark, NOT the
  // Claude Code *CLI product* logo. A Klide conversation on the Anthropic API
  // is not a Claude Code session; the CLI logo stays reserved for source
  // === "claude-code" (handled directly in SourceLogo/ConversationAvatar).
  { pattern: /claude/i, Comp: AnthropicMark },
  // Codex CLI only — keep this before the OpenAI rule so a literal "codex"
  // model still wears the Codex mark.
  { pattern: /codex/i, Comp: CodexLogo },
  // OpenAI API models (gpt-4o, gpt-5, o1/o3/o4) → the OpenAI mark, not Codex.
  { pattern: /^gpt-|^o[134]\b|^o[134]-/i, Comp: OpenAiLogo },
  { pattern: /glm|z-?ai/i, Comp: ZaiLogo },
];

// Resolve the logo for a model name → the model's provider/brand mark.
// Brand marks first (DeepSeek, Claude, OpenAI/gpt, …), then provider-image
// fallbacks, then the local-runtime (Ollama) mark for known on-device
// families (lfm2.5, llama, qwen, gemma, …). Returns null when unrecognized so
// callers can fall back to the Klide spark.
function resolveModelLogo(model: string, size: number): React.ReactElement | null {
  // Maker brand first (LiquidAI, Qwen, Llama, Mistral, Hugging Face) so a
  // model wears its own company's mark, not the runtime's.
  const brand = modelBrand(model);
  if (brand) {
    const Logo = brand.Logo;
    return <Logo size={size} />;
  }
  const rule = MODEL_LOGO_RULES.find((r) => r.pattern.test(model));
  if (rule) {
    const Logo = rule.Comp;
    return <Logo size={size} />;
  }
  // Gemma is Google's — it wears the Google mark regardless of runtime, so an
  // MLX- or Ollama-served Gemma no longer wrongly borrows the Ollama logo.
  if (/gemini|gemma/i.test(model)) return <ProviderLogo id="gemini" size={size} />;
  if (/grok/i.test(model)) return <ProviderLogo id="xai" size={size} />;
  // Remaining on-device families (phi, nomic, …) with no distinct maker mark
  // fall back to the local-runtime (Ollama) glyph.
  if (/phi-?\d|nomic|mxbai|granite|smollm|starcoder/i.test(model))
    return <ProviderLogo id="ollama" size={size} />;
  return null;
}

function ModelBadge({ model, size = 13 }: { model: string; size?: number }) {
  return resolveModelLogo(model, size);
}

const PROVIDER_LABEL: Partial<Record<ProviderId, string>> = {
  ollama: "Ollama",
  mlx: "MLX",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
  vllm: "vLLM",
  "claude-code": SOURCE_LABEL["claude-code"],
  codex: SOURCE_LABEL.codex,
  opencode: SOURCE_LABEL.opencode,
  omp: SOURCE_LABEL.omp,
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  mistral: "Mistral",
  xai: "xAI",
  openrouter: "OpenRouter",
};

const PROVIDER_ACCENT: Partial<Record<ProviderId, string>> = {
  "claude-code": "#D97757",
  anthropic: "#D97757",
  openrouter: "#4A6CF7",
  omp: "#7C6BAE",
  codex: "var(--fg-strong)",
  opencode: "var(--fg-strong)",
  openai: "var(--fg-strong)",
};

function providerLabel(provider: string | null | undefined): string | null {
  if (!provider) return null;
  if (provider.startsWith("custom:")) return provider.slice("custom:".length) || "Custom";
  return PROVIDER_LABEL[provider as ProviderId] ?? provider;
}

function runAgentLabel(run: Pick<Run, "source" | "provider">): string {
  return run.source === "klide" && run.provider
    ? providerLabel(run.provider) ?? SOURCE_LABEL.klide
    : SOURCE_LABEL[run.source];
}

function runAgentColor(run: Pick<Run, "source" | "provider">): string {
  return run.source === "klide" && run.provider
    ? PROVIDER_ACCENT[run.provider as ProviderId] ?? SOURCE_COLOR.klide
    : SOURCE_COLOR[run.source];
}

function providerMark(provider: string | null | undefined, size: number): React.ReactElement | null {
  return provider ? <ProviderLogo id={provider as ProviderId} size={size} /> : null;
}

// Company marks for the main run avatar (Simple Icons, single-path,
// currentColor): the avatar wears the company (Anthropic, OpenAI), while the
// model badge in the subtitle wears the tool (Claude Code, Codex).
const BRAND_PATH: Partial<Record<RunSource, string>> = {
  "claude-code":
    "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
};

// A small inline checkmark-in-square — used for todos. We want this to read
// at a glance as "task to do", not as any particular agent or tool.
const TASK_AVATAR_PATH =
  "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2v14h14V5H5zm3.3 7.7l1.4-1.4 1.8 1.8 4.5-4.5 1.4 1.4-5.9 5.9-3.2-3.2z";

function SourceLogo({
  source,
  kind,
  model,
  provider,
  size = 14,
}: {
  source: RunSource;
  kind?: RunKind;
  model?: string | null;
  provider?: string | null;
  size?: number;
}) {
  // Tasks always wear the task mark — even after dispatch — so a row reads
  // as "this todo is being worked on by Claude Code", not "this is a Claude
  // Code session".
  if (kind === "task") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        style={{ color: "var(--fg-subtle)" }}
      >
        <path d={TASK_AVATAR_PATH} />
      </svg>
    );
  }
  // Klide AI-panel conversations still have a concrete provider/harness
  // (Claude Code, Codex, Ollama, OpenAI, OpenRouter, custom:*). Preserve that
  // identity in Mission Control instead of collapsing every convo to the
  // generic Klide spark.
  if (source === "klide") {
    const mark = providerMark(provider, size);
    if (mark) {
      return (
        <span style={{ width: size, height: size, display: "grid", placeItems: "center", flexShrink: 0 }}>
          {mark}
        </span>
      );
    }
  }
  if (source === "codex") {
    return <CodexLogo size={size} />;
  }
  // Claude Code's harness mark is the main logo on the run row; the
  // Anthropic company A lives in the subtitle badge (orange).
  if (source === "claude-code") {
    return <ClaudeCodeLogo size={size} />;
  }
  // Oh My Pi's own mark — bold wordmark in omp purple.
  if (source === "omp") {
    return <OmpLogo size={size} />;
  }
  const path = BRAND_PATH[source];
  const color = "var(--fg-strong)";
  if (path) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        style={{ color }}
      >
        <path d={path} />
      </svg>
    );
  }
  // OpenCode uses its own two-tone logo (light/dark variants in /public) with
  // a CSS theme-swap rule already in tokens.css. The wrapper class stacks the
  // two <img>s at the same grid cell so only the right one shows per theme.
  if (source === "opencode") {
    return (
      <span
        className="opencode-logo"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <img className="opencode-logo-light" src="/opencode-logo-light.svg" alt="" />
        <img className="opencode-logo-dark" src="/opencode-logo-dark.svg" alt="" />
      </span>
    );
  }
  // Other Klide runs wear the logo of the model they used — Ollama for local
  // lfm2.5/llama, OpenAI for gpt, Anthropic for claude, etc. — so the board
  // reads as "which model ran this". Falls back to the quiet spark when the
  // model is unknown or absent.
  if (model) {
    const logo = resolveModelLogo(model, size);
    if (logo) {
      return (
        <span style={{ width: size, height: size, display: "grid", placeItems: "center", flexShrink: 0 }}>
          {logo}
        </span>
      );
    }
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ color }}
    >
      <path d="M12 3.5l1.6 4.4L18 9.5l-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6L12 3.5z" />
    </svg>
  );
}

function RunAvatar({
  source,
  kind,
  model,
  provider,
  size = 22,
}: {
  source: RunSource;
  kind?: RunKind;
  model?: string | null;
  provider?: string | null;
  size?: number;
}) {
  return (
    <SourceLogo source={source} kind={kind} model={model} provider={provider} size={size} />
  );
}

function RunSubtitleMark({ run, compact }: { run: RunLedgerEntry; compact?: boolean }) {
  if (run.source === "klide" && run.provider) {
    // Runtimes/routers (OpenRouter, MLX, Ollama, …) run other makers' models —
    // the avatar already wears the runtime mark, so the small subtitle mark
    // shows the model's own maker (DeepSeek, Qwen, Google/Gemma, …). Falls back
    // to the provider mark when the model has no recognisable maker.
    if (RUNTIME_MODEL_PROVIDERS.has(run.provider) && run.model) {
      const modelLogo = resolveModelLogo(run.model, 11);
      if (modelLogo) return modelLogo;
    }
    return providerMark(run.provider, 11);
  }
  if (run.source === "klide" && !compact && run.model) return <ModelBadge model={run.model} size={13} />;
  if (run.source === "klide" && !compact) return null;
  if (run.source === "claude-code") return null;
  if (run.model) return <ModelBadge model={run.model} size={13} />;
  if (run.source === "codex") return <CodexLogo size={13} />;
  return <ProviderLogo id={run.source as ProviderId} size={11} />;
}

function RunRow({
  run,
  selected,
  onSelect,
  action,
  dismissAction,
  compact,
}: {
  run: RunLedgerEntry;
  selected: boolean;
  onSelect: () => void;
  action?: React.ReactNode;
  dismissAction?: {
    label: string;
    onDismiss: () => void;
    danger?: boolean;
  };
  compact?: boolean;
  /** A durable Project Memory note exists for this run (matched by runId). */
  hasMemory?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [dragX, setDragX] = useState(0);
  const [swipeOpen, setSwipeOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; active: boolean } | null>(null);
  const dragXRef = useRef(0);
  const suppressNextClick = useRef(false);
  const actionWidth = 76;
  const setSwipeX = (x: number) => {
    dragXRef.current = x;
    setDragX(x);
  };
  // The row stays quiet: just the passive attention badge, or a single
  // contextual action (resume / quick-send / sub-agent count) that swaps in
  // on hover. Per-run actions (review diff, save memory, resume) live in the
  // detail pane, not on the row.
  const rightRail = action ? (
    <span
      style={{
        width: 24,
        height: 24,
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
      }}
    >
      {hovered ? action : <RunAttentionBadge run={run} compact={compact || run.status === "running"} />}
    </span>
  ) : (
    <RunAttentionBadge run={run} compact={compact} />
  );
  const row = (
    <button
      onClick={(e) => {
        if (suppressNextClick.current) {
          e.preventDefault();
          e.stopPropagation();
          suppressNextClick.current = false;
          return;
        }
        if (swipeOpen) {
          e.preventDefault();
          setSwipeOpen(false);
          setSwipeX(0);
          return;
        }
        onSelect();
      }}
      onPointerDown={(e) => {
        if (!dismissAction) return;
        if (e.button !== 0) return;
        dragStart.current = { x: e.clientX, y: e.clientY, active: false };
      }}
      onPointerMove={(e) => {
        const start = dragStart.current;
        if (!dismissAction || !start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (!start.active && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
          start.active = true;
          setDragging(true);
          setSwipeOpen(false);
          e.currentTarget.setPointerCapture(e.pointerId);
        }
        if (!start.active) return;
        e.preventDefault();
        const next = dx < -actionWidth ? -actionWidth - Math.sqrt(Math.abs(dx + actionWidth)) : dx;
        setSwipeX(Math.max(-actionWidth - 10, Math.min(0, next)));
      }}
      onPointerUp={(e) => {
        const start = dragStart.current;
        if (start?.active) {
          e.preventDefault();
          const open = dragXRef.current < -30;
          setSwipeOpen(open);
          setSwipeX(open ? -actionWidth : 0);
          suppressNextClick.current = true;
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            /* pointer capture may already be gone */
          }
        }
        setDragging(false);
        dragStart.current = null;
      }}
      onPointerCancel={() => {
        dragStart.current = null;
        setDragging(false);
        setSwipeOpen(false);
        setSwipeX(0);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: compact ? 6 : 10,
        width: "100%",
        textAlign: "left",
        padding: compact ? "6px 10px" : "8px 10px",
        borderRadius: "var(--radius-sm)",
        background: selected
          ? "var(--bg-selected)"
          : hovered
          ? "var(--bg-hover)"
          : dismissAction
          ? "var(--bg-elevated)"
          : "transparent",
        transform: dismissAction ? `translateX(${dragX}px)` : undefined,
        touchAction: dismissAction ? "pan-y" : undefined,
        transition:
          dragging
            ? "background var(--motion-fast) var(--ease-out)"
            : "background var(--motion-fast) var(--ease-out), transform 420ms cubic-bezier(.18,.88,.22,1)",
        position: "relative",
        zIndex: swipeOpen ? 1 : 3,
      }}
    >
      {!compact && <RunAvatar source={run.source} kind={run.kind} model={run.model} provider={run.provider} />}
      <span style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
          }}
        >
          {run.kind === "task" && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--accent)",
                flexShrink: 0,
                fontFamily: "var(--font-mono)",
              }}
            >
              Task
            </span>
          )}
          <RoutineBadge run={run} />
          <span
            style={{
              fontSize: 13,
              color: "var(--fg-strong)",
              lineHeight: 1.3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {run.title}
          </span>
          {run.archived && (
            <span style={{ fontSize: 11, color: "var(--fg-subtle)", flexShrink: 0 }}>
              · archived
            </span>
          )}
        </span>
          {!compact && run.lastEvent ? (
            <span
              title={run.lastEvent}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11.5,
                // For a live run the last event IS the current activity — colour
                // it accent so it reads as "now", not "last did". Finished runs
                // keep the quiet muted treatment.
                color: run.status === "running" ? "var(--accent)" : "var(--fg-muted)",
                lineHeight: 1.3,
                overflow: "hidden",
                minWidth: 0,
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {run.lastEvent}
              </span>
            </span>
          ) : null}
          <span
            style={{
              fontSize: 11,
              color: "var(--fg-subtle)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            {/* Provider-backed Klide rows keep their provider/harness mark;
                model-backed rows keep the model mark. External runs keep
                their product/model mark inline. */}
            <RunReasonChip run={run} />
            <RunSubtitleMark run={run} compact={compact} />
            {run.source === "opencode" && run.model ? (
              <>
                {modelProvider(run.model)}
                {modelShortName(run.model) ? (
                  <span style={{ marginLeft: 5, fontSize: 10 }}>{modelShortName(run.model)}</span>
                ) : null}
              </>
            ) : run.source === "claude-code" ? (
              <>
                <AnthropicMark size={11} />
                {SOURCE_LABEL[run.source]}
                {run.model ? <span style={{ marginLeft: 5, fontSize: 10 }}>{runModelLabel(run)}</span> : null}
              </>
            ) : run.source === "klide" && run.provider ? (
              <>
                {runAgentLabel(run)}
                {run.model ? <span style={{ marginLeft: 5, fontSize: 10 }}>{runModelLabel(run)}</span> : null}
              </>
            ) : (
              <>
                {SOURCE_LABEL[run.source]}
                {run.model ? <span style={{ marginLeft: 5, fontSize: 10 }}>{runModelLabel(run)}</span> : null}
              </>
            )}
            {/* Row stays minimal: status + provider + model. Branch, cost,
                tokens, files, worktree, memory and last-seen all live in the
                run detail pane (RunEvidenceStrip), one click away. */}
          </span>
      </span>
      {rightRail}
    </button>
  );
  if (!dismissAction) return row;
  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius: "var(--radius-sm)",
        background: "var(--bg-elevated)",
      }}
    >
      <button
        type="button"
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
        onPointerUp={(e) => {
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          setSwipeOpen(false);
          setSwipeX(0);
          dismissAction.onDismiss();
        }}
        title={dismissAction.label}
        aria-label={dismissAction.label}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: actionWidth,
          zIndex: 5,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 3,
          border: "none",
          borderRadius: "var(--radius-sm)",
          background: dismissAction.danger
            ? "color-mix(in srgb, var(--danger) 18%, var(--bg-elevated))"
            : "var(--bg-hover)",
          color: dismissAction.danger ? "var(--danger)" : "var(--fg-muted)",
          fontSize: 9,
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          cursor: "pointer",
          opacity: Math.min(1, Math.abs(dragX) / actionWidth),
          pointerEvents: swipeOpen || dragX <= -24 ? "auto" : "none",
          transition: dragging ? "none" : "opacity 260ms cubic-bezier(.18,.88,.22,1)",
        }}
      >
        <DismissIcon />
        {dismissAction.label}
      </button>
      {row}
    </div>
  );
}

// ── Mission Control v3 — Attention queue ────────────────────────────────────
// Pinned strip at the top of the board. The board used to have a "Blocked"
// section that mixed waiting runs with errored ones and never explained *why*
// each run was blocked; the queue elevates that into a focused action surface
// with per-row reason text and an inline action.
//
// Why this design:
//   - The queue's items are a strict subset of the sectioned board. A run
//     shown in the queue is *not* hidden from the section it would otherwise
//     belong to — duplication is the point. The queue is for acting; the
//     section is for browsing.
//   - The reason pill is the new information. It uses four tones (danger /
//     warn / accent / subtle) so the queue reads at a glance: "red = broken,
//     amber = blocked on me, blue = ready to read, grey = idle".
//   - Severity ordering (failed → needs-me → idle → review) puts the runs
//     that are likely to lose money or context at the top.

const DISMISSED_BOARD_KEY = "klide-dismissed-board-runs";

function boardDismissKey(run: Pick<Run, "source" | "id" | "updatedMs">): string {
  return `${run.source}:${run.id}:${run.updatedMs}`;
}

function readStringSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeStringSet(key: string, ids: Set<string>) {
  localStorage.setItem(key, JSON.stringify(Array.from(ids)));
}

function readDismissedBoardRuns(): Set<string> {
  return readStringSet(DISMISSED_BOARD_KEY);
}

function writeDismissedBoardRuns(ids: Set<string>) {
  writeStringSet(DISMISSED_BOARD_KEY, ids);
}


function SendIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

// One-click resume for a Klide on-disk run: re-opens the AI panel with the
// prior transcript loaded. Same hover-revealed slot as QuickSend so the row
// stays quiet until the user reaches for it.
function ResumeKlide({ runId, onResume }: { runId: string; onResume: (id: string) => void }) {
  return (
    <span
      role="button"
      aria-label="Resume in Klide"
      title="Resume in Klide"
      onClick={(e) => {
        e.stopPropagation();
        onResume(runId);
      }}
      style={{
        width: 22,
        height: 22,
        flexShrink: 0,
        display: "grid",
        placeItems: "center",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        color: "var(--accent)",
        background: "var(--accent-soft)",
      }}
    >
      <ResumeIcon />
    </span>
  );
}

// One-click resume for a CLI run (claude-code, codex, opencode): spawns the
// same delegate TUI with --resume <run-id> and selects the row so the live
// terminal lands in the detail pane. Same visual treatment as ResumeKlide.
function ResumeCli({
  source,
  onResume,
}: {
  source: RunSource;
  onResume: () => void;
}) {
  return (
    <span
      role="button"
      aria-label={`Resume in ${SOURCE_LABEL[source]}`}
      title={`Resume in ${SOURCE_LABEL[source]}`}
      onClick={(e) => {
        e.stopPropagation();
        onResume();
      }}
      style={{
        width: 22,
        height: 22,
        flexShrink: 0,
        display: "grid",
        placeItems: "center",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        color: "var(--accent)",
        background: "var(--accent-soft)",
      }}
    >
      <ResumeIcon />
    </span>
  );
}

// Inline action for an "awaiting review" queue row. The review surface is the
// run's detail pane, so this just selects the run — but giving it an explicit
// affordance (rather than relying on a bare row click) keeps the queue reading
// as a list of actions. Same hover-revealed slot as ResumeKlide / QuickSend.
function DismissIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function ResumeIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 3v18l15-9z" fill="currentColor" />
    </svg>
  );
}

// One-click dispatch on a todo row: sends the last-used agent and selects the
// task so its terminal is in view as the agent lands. Nested inside the row's
// <button>, so it's a span with button semantics.
function QuickSend({ taskId, onSent }: { taskId: string; onSent: () => void }) {
  const agent = lastAgent();
  return (
    <span
      role="button"
      aria-label={`Send ${SOURCE_LABEL[agent]}`}
      title={`Send ${SOURCE_LABEL[agent]}`}
      onClick={(e) => {
        e.stopPropagation();
        onSent();
        void dispatchTask(taskId, agent).catch((err) => {
          // Failure flips the task to error in the store; the detail pane
          // (now selected) shows the message and re-send controls. A toast makes
          // the failure unmissable even if the user looks away from the row.
          notify(`Couldn't dispatch to ${SOURCE_LABEL[agent]}: ${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
        });
      }}
      style={{
        width: 22,
        height: 22,
        flexShrink: 0,
        display: "grid",
        placeItems: "center",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        color: "var(--accent)",
        background: "var(--accent-soft)",
      }}
    >
      <SendIcon />
    </span>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 11,
        padding: "3px 9px",
        borderRadius: "var(--radius-sm)",
        border: active ? "1px solid var(--border-strong)" : "1px solid var(--border)",
        color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
        background: "transparent",
        transition: "border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      {label}
    </button>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt style={{ color: "var(--fg-subtle)" }}>{label}</dt>
      <dd style={{ margin: 0, color: "var(--fg-strong)", fontFamily: "var(--font-mono)" }}>
        {value}
      </dd>
    </>
  );
}

/** Race mark — a pane split into two columns: two agents side by side on the
 *  same task. Inline SVG so it renders crisply and matches the stroke-icon
 *  family used across Mission Control. */
function RaceMark({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M12 4v16" />
    </svg>
  );
}

/** A run's race membership, precomputed for the board rows. */
type RaceRowInfo = {
  groupId: string;
  memberIndex: number;
  /** "A", "B", … — the member's stable letter within its race. */
  label: string;
  size: number;
  prompt: string;
};

/** Keep race siblings adjacent within a section: the first-seen member of a
 *  group pulls the rest up next to it (in member order), so a race reads as
 *  one comparison block instead of scattered rows. Non-members keep their
 *  recency order. */
function clusterRaceRows(
  rows: RunLedgerEntry[],
  info: Map<string, RaceRowInfo>,
): RunLedgerEntry[] {
  const out: RunLedgerEntry[] = [];
  const emitted = new Set<string>();
  for (const row of rows) {
    if (emitted.has(row.id)) continue;
    const ri = info.get(row.id);
    if (!ri) {
      out.push(row);
      continue;
    }
    const siblings = rows
      .filter((r) => info.get(r.id)?.groupId === ri.groupId)
      .sort((a, b) => (info.get(a.id)?.memberIndex ?? 0) - (info.get(b.id)?.memberIndex ?? 0));
    for (const s of siblings) {
      out.push(s);
      emitted.add(s.id);
    }
  }
  return out;
}

/** Side-by-side stats for a race's members: metric labels down the left, one
 *  column per agent. The numbers come from each run's ledger entry (validation
 *  snapshot, tokens, cost); a member with no entry yet shows "—" everywhere.
 *  Clicking a column header opens that run. */
function RaceCompareTable({
  raceEntries,
  currentRunId,
  onSelectRun,
}: {
  raceEntries: { member: RaceMember; entry: RunLedgerEntry | null }[];
  currentRunId: string;
  onSelectRun?: (run: RunLedgerEntry) => void;
}) {
  const stats: {
    label: string;
    value: (e: RunLedgerEntry | null) => string | null;
    tone?: (e: RunLedgerEntry | null) => string | undefined;
  }[] = [
    {
      label: "Status",
      value: (e) => (e ? LIFECYCLE_LABEL[e.lifecycle] : "starting…"),
    },
    {
      label: "Validation",
      value: (e) => formatValidationStatus(e?.validation),
      tone: (e) =>
        e?.validation?.status === "failed"
          ? "var(--danger)"
          : e?.validation?.status === "passed"
          ? "var(--success)"
          : undefined,
    },
    {
      label: "Files",
      value: (e) => (e?.validation ? String(e.validation.filesChanged) : formatFilesTouched(e?.filesTouched)),
    },
    {
      label: "Commands",
      value: (e) =>
        e?.validation && e.validation.commandsRun > 0
          ? `${e.validation.commandsRun}${e.validation.commandsFailed ? ` · ${e.validation.commandsFailed} failed` : ""}`
          : e?.validation
          ? "0"
          : null,
      tone: (e) => (e?.validation?.commandsFailed ? "var(--danger)" : undefined),
    },
    { label: "Tokens", value: (e) => (e ? runTokenSummary(e) : null) },
    { label: "Cost", value: (e) => (e ? formatCost(e.costUsd) : null) },
    {
      label: "Time",
      value: (e) =>
        e && e.updatedMs > e.createdMs ? formatRaceDuration(e.updatedMs - e.createdMs) : null,
    },
    { label: "Worktree", value: () => null },
  ];

  const cellBase: React.CSSProperties = {
    padding: "3px 8px",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `84px repeat(${raceEntries.length}, minmax(0, 1fr))`,
        alignItems: "center",
      }}
    >
      {/* Header row: one column per agent; the run being viewed reads bolder. */}
      <span />
      {raceEntries.map(({ member, entry }) => {
        const current = member.runId === currentRunId;
        return (
          <button
            key={member.runId}
            type="button"
            onClick={() => {
              if (!current && entry && onSelectRun) onSelectRun(entry);
            }}
            disabled={current || !entry || !onSelectRun}
            title={
              current
                ? `${member.model} — this run`
                : entry
                ? `Open ${member.model}`
                : `${member.model} — not on the board yet`
            }
            style={{
              ...cellBase,
              paddingBottom: 6,
              border: "none",
              background: "transparent",
              textAlign: "left",
              cursor: current || !entry ? "default" : "pointer",
              color: "var(--fg-strong)",
              fontWeight: current ? 600 : 400,
            }}
          >
            {providerName(member.provider as ProviderId)}
            <span style={{ marginLeft: 10 }}>{member.model}</span>
          </button>
        );
      })}
      {stats.map((stat) => (
        <Fragment key={stat.label}>
          <span style={{ ...cellBase, fontFamily: "var(--font-ui, inherit)", color: "var(--fg-subtle)" }}>
            {stat.label}
          </span>
          {raceEntries.map(({ member, entry }) => (
            <span
              key={member.runId}
              title={stat.label === "Validation" ? formatValidationTitle(entry?.validation) : undefined}
              style={{
                ...cellBase,
                color: stat.tone?.(entry) ?? "var(--fg-strong)",
              }}
            >
              {stat.label === "Worktree" ? member.worktree : stat.value(entry) ?? "—"}
            </span>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

/** Compact wall-clock span for the race compare rows: "42s", "3m 10s", "1h 4m". */
function formatRaceDuration(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs >= 3600) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  if (secs >= 60) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${secs}s`;
}

function EvidenceMeta({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div
      style={{
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 3,
      }}
      title={title}
    >
      <span
        style={{
          color: "var(--fg-subtle)",
          fontSize: 9,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          fontFamily: "var(--font-mono)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: "var(--fg-strong)",
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          minWidth: 0,
          maxWidth: 220,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function RunEvidenceStrip({ run, hasMemory }: { run: Run; hasMemory?: boolean }) {
  const reason = runBoardReason(run);
  const section = boardSectionForRun(run);
  const files = formatFilesTouched(run.filesTouched);
  const cost = formatCost(run.costUsd);
  const tokens = runTokenSummary(run);
  const validation = formatValidationStatus(run.validation);
  const meta: React.ReactNode[] = [
    <EvidenceMeta key="section" label="Board" value={BOARD_SECTION_LABEL[section]} title={BOARD_SECTION_HINT[section]} />,
  ];
  if (run.branch) meta.push(<EvidenceMeta key="branch" label="Branch" value={run.branch} />);
  if (run.forkedFrom)
    meta.push(
      <EvidenceMeta
        key="forked"
        label="Forked"
        value={`${run.forkedFrom.mode === "worktree" ? "Worktree" : "Chat"} · #${run.forkedFrom.messageIndex + 1}`}
        title={`Forked from ${run.forkedFrom.title}`}
      />,
    );
  if (run.worktree)
    meta.push(
      <EvidenceMeta
        key="worktree"
        label="Worktree"
        value={run.worktree}
        title="Ran in a linked git worktree, not the repo's main checkout"
      />,
    );
  if (validation)
    meta.push(
      <EvidenceMeta
        key="validation"
        label="Validation"
        value={validation}
        title={formatValidationTitle(run.validation)}
      />,
    );
  if (run.status !== "error") {
    if (files) meta.push(<EvidenceMeta key="files" label="Files" value={files} />);
    if (cost) meta.push(<EvidenceMeta key="cost" label="Cost" value={cost} />);
    if (tokens) meta.push(<EvidenceMeta key="tokens" label="Tokens" value={tokens} />);
    if (run.subagentCount)
      meta.push(<EvidenceMeta key="subagents" label="Sub-agents" value={String(run.subagentCount)} />);
  }
  // Memory status closes the review loop: a finished run with no note is a
  // candidate for "Save memory". Saved notes are shown whatever the status.
  if (hasMemory) {
    meta.push(<EvidenceMeta key="memory" label="Memory" value="Saved" />);
  } else if (run.status === "done") {
    meta.push(<EvidenceMeta key="memory" label="Memory" value="Not saved" />);
  }
  meta.push(<EvidenceMeta key="activity" label="Seen" value={relativeTime(run.updatedMs)} />);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(180px, 1.35fr) minmax(260px, 2fr)",
        gap: 14,
        alignItems: "stretch",
        margin: "0 0 16px",
        padding: "12px 14px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        background: "color-mix(in srgb, var(--bg-elevated) 72%, var(--bg))",
      }}
    >
      <div
        title={reason.detail}
        style={{
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 10,
          paddingRight: 14,
          borderRight: "1px solid var(--border)",
        }}
      >
        <span
          style={{
            width: 72,
            flexShrink: 0,
            color: reason.tone === "danger" ? "var(--danger)" : "var(--fg-subtle)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {reason.label}
        </span>
        <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
          <span
            style={{
              fontSize: 12.5,
              color: "var(--fg-strong)",
              lineHeight: 1.35,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {run.status === "error" ? "Run did not complete" : reason.detail}
          </span>
          <span
            style={{
              fontSize: 11.5,
              color: "var(--fg-subtle)",
              lineHeight: 1.35,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {reason.detail}
          </span>
        </span>
      </div>
      <div
        style={{
          minWidth: 0,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(86px, 1fr))",
          gap: "10px 14px",
          alignItems: "center",
        }}
      >
        {meta}
      </div>
    </div>
  );
}

function CopyButton({
  value,
  label = "Copy",
  icon,
}: {
  value: string | null;
  label?: string;
  // When provided, renders as an icon-only square (matching IconActionButton);
  // otherwise falls back to the original text pill.
  icon?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const disabled = !value;

  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  if (icon) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => void copy()}
        aria-label={label}
        title={disabled ? "Nothing to copy" : copied ? "Copied" : label}
        style={{
          width: 28,
          height: 28,
          flexShrink: 0,
          display: "grid",
          placeItems: "center",
          border: "none",
          color: disabled ? "var(--fg-dim)" : copied ? "var(--accent)" : "var(--fg-subtle)",
          background: "transparent",
          opacity: disabled ? 0.45 : 1,
          cursor: disabled ? "default" : "pointer",
          transform: "scale(1)",
          transformOrigin: "center bottom",
          transition:
            "transform 220ms cubic-bezier(0.22, 1, 0.36, 1), color 160ms var(--ease-out)",
        }}
        onMouseEnter={(e) => {
          if (disabled || copied) return;
          e.currentTarget.style.transform = "scale(1.45)";
          e.currentTarget.style.color = "var(--fg)";
        }}
        onMouseLeave={(e) => {
          if (copied) return;
          e.currentTarget.style.transform = "scale(1)";
          e.currentTarget.style.color = "var(--fg-subtle)";
        }}
      >
        {copied ? CheckGlyph : icon}
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void copy()}
      title={disabled ? "Nothing to copy" : label}
      style={{
        fontSize: 11,
        padding: "3px 7px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        color: disabled ? "var(--fg-dim)" : copied ? "var(--accent)" : "var(--fg-subtle)",
        background: copied ? "var(--accent-soft)" : "transparent",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

async function messagesForRun(run: Run, preloaded?: RunMessage[]): Promise<RunMessage[]> {
  if (preloaded) return preloaded;
  return fetchRunMessages(run);
}

function DetailLabel({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <div
      id={id}
      style={{
        fontSize: 10,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--fg-subtle)",
        marginBottom: 8,
        fontFamily: "var(--font-mono)",
      }}
    >
      {children}
    </div>
  );
}

function ConversationView({ run, preloaded }: { run: Run; preloaded?: RunMessage[] }) {
  const [messages, setMessages] = useState<RunMessage[]>([]);
  const [profileName, setProfileName] = useState("Me");
  const [showTools, setShowTools] = useState(false);
  const [showProcessNotes, setShowProcessNotes] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // The revealed blocks sit inline next to the turns they belong to — often
  // below the fold — so a toggle click at the top would otherwise look like a
  // no-op. Bring the first revealed block into view.
  useEffect(() => {
    if (!showTools) return;
    bodyRef.current
      ?.querySelector('[data-reveal="tools"]')
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [showTools]);
  useEffect(() => {
    if (!showProcessNotes) return;
    bodyRef.current
      ?.querySelector('[data-reveal="notes"]')
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [showProcessNotes]);

  useEffect(() => {
    // In-memory conversations (Klide's own panels) skip the disk read.
    if (preloaded) {
      setMessages(preloaded);
      setLoading(false);
      setError(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    setMessages([]);
    fetchRunMessages(run)
      .then((rows) => {
        if (!cancelled) setMessages(rows);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [run.id, run.path, run.source, preloaded]);

  useEffect(() => {
    let cancelled = false;
    void invoke<AppUserInfo>("app_user_info")
      .then((info) => {
        if (!cancelled && info.username?.trim()) setProfileName(info.username.trim());
      })
      .catch(() => {
        if (!cancelled) setProfileName("Me");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const muted = { fontSize: 12, color: "var(--fg-subtle)" } as const;
  if (loading) return <div style={muted}>Loading conversation…</div>;
  if (error) return <div style={muted}>Couldn't read this session.</div>;
  if (messages.length === 0) return <div style={muted}>No readable messages.</div>;

  const conversationItems = compactConversationMessages(messages);
  const reviewStats = conversationItems.reduce(
    (acc, item) => {
      if (item.type === "process") {
        acc.notes += item.notes.length;
      } else {
        acc.turns += 1;
        acc.tools += item.tools.length;
      }
      return acc;
    },
    { turns: 0, tools: 0, notes: 0 }
  );

  function copyAsMarkdown() {
    const parts = messages.map((m) => {
      const role = m.role === "user" ? "**You**" : `**${runAgentLabel(run)}**`;
      return `${role}\n\n${m.text}`;
    });
    navigator.clipboard.writeText(parts.join("\n\n---\n\n")).catch(() => {});
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <ConversationReviewBar
          turns={reviewStats.turns}
          tools={reviewStats.tools}
          notes={reviewStats.notes}
          showTools={showTools}
          showNotes={showProcessNotes}
          onToggleTools={() => setShowTools((v) => !v)}
          onToggleNotes={() => setShowProcessNotes((v) => !v)}
        />
        <IconActionButton
          icon={CopyGlyph}
          label="Copy conversation as Markdown"
          onClick={copyAsMarkdown}
        />
      </div>
      <div
        ref={bodyRef}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 22,
          maxWidth: 1040,
        }}
      >
        {conversationItems.map((item, i) => {
          if (item.type === "process") {
            return showProcessNotes ? (
              <div key={`process-${i}`} data-reveal="notes">
                <ProcessNoteStack notes={item.notes} defaultOpen />
              </div>
            ) : null;
          }
          const { message: m } = item;
          const isUser = m.role === "user";
          return (
            <div
              key={`message-${i}`}
              style={{
                display: "grid",
                gridTemplateColumns: isUser ? "minmax(0, 1fr) minmax(260px, 620px) 42px" : "42px minmax(280px, 660px) minmax(0, 1fr)",
                columnGap: 12,
                alignItems: "end",
              }}
            >
              {!isUser && (
                <ConversationAvatar
                  source={run.source}
                  provider={run.provider}
                  label={runAgentLabel(run)}
                  model={run.model}
                />
              )}
              <div
                style={{
                  gridColumn: isUser ? "2" : "2",
                  justifySelf: isUser ? "end" : "start",
                  width: "100%",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--fg)",
                    lineHeight: 1.6,
                    wordBreak: "break-word",
                    padding: isUser ? "10px 12px" : "12px 14px",
                    borderRadius: isUser ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
                    border: "1px solid var(--border)",
                    background: isUser
                      ? "color-mix(in srgb, var(--accent-soft) 55%, var(--bg-elevated))"
                      : "color-mix(in srgb, var(--bg-elevated) 88%, var(--bg))",
                  }}
                >
                  {renderMarkdown(item.text, {
                    renderTool: (name, summary) => <ToolCard name={name} summary={summary} />,
                  })}
                </div>
                {!isUser && showTools && item.tools.length > 0 && (
                  <div data-reveal="tools">
                    <ToolStack tools={item.tools} />
                  </div>
                )}
              </div>
              {isUser && <ConversationAvatar source="klide" label={profileName} user />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConversationReviewBar({
  turns,
  tools,
  notes,
  showTools,
  showNotes,
  onToggleTools,
  onToggleNotes,
}: {
  turns: number;
  tools: number;
  notes: number;
  showTools: boolean;
  showNotes: boolean;
  onToggleTools: () => void;
  onToggleNotes: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flex: 1,
        gap: 12,
        minWidth: 0,
        color: "var(--fg-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
      }}
    >
      <span style={{ color: "var(--fg-subtle)" }}>Review</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {TurnsGlyph}
        {turns} turns
      </span>
      {tools > 0 && (
        <ReviewToggle
          icon={ToolRunGlyph}
          active={showTools}
          label={`${tools} tools`}
          title={showTools ? "Hide tool activity" : "Show tool activity"}
          onClick={onToggleTools}
        />
      )}
      {notes > 0 && (
        <ReviewToggle
          icon={NotesGlyph}
          active={showNotes}
          label={`${notes} notes`}
          title={showNotes ? "Hide working notes" : "Show working notes"}
          onClick={onToggleNotes}
        />
      )}
    </div>
  );
}

// Micro glyphs for the review bar — 11px so they sit flush with the 10px mono
// counts they annotate.
const TurnsGlyph = (
  <Glyph size={11}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
  </Glyph>
);
const ToolRunGlyph = (
  <Glyph size={11}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </Glyph>
);
const NotesGlyph = (
  <Glyph size={11}>
    <path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11l5-5V5a2 2 0 0 0-2-2Z" />
    <path d="M15 21v-4a2 2 0 0 1 2-2h4" />
  </Glyph>
);

function ReviewToggle({
  active,
  icon,
  label,
  title,
  onClick,
}: {
  active: boolean;
  icon?: React.ReactNode;
  label: string;
  title: string;
  onClick: () => void;
}) {
  // Hidden sections read as dimmed counts, shown ones as bright — color does
  // the state work, no chip container needed.
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        padding: 0,
        border: "none",
        background: "transparent",
        color: active ? "var(--fg-strong)" : "var(--fg-dim)",
        cursor: "pointer",
        transition: "color var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = active ? "var(--fg-strong)" : "var(--fg-subtle)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = active ? "var(--fg-strong)" : "var(--fg-dim)";
      }}
    >
      {icon}
      <span>
        {label}
      </span>
    </button>
  );
}

function ProcessNoteStack({ notes, defaultOpen }: { notes: string[]; defaultOpen?: boolean }) {
  // Controlled <details> so we can arrive expanded when the review-bar toggle
  // reveals the stack (one click shows the notes, not a second collapsed box)
  // while still letting the reader fold it back.
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "42px minmax(280px, 660px) minmax(0, 1fr)",
        columnGap: 12,
        alignItems: "start",
      }}
    >
      <div />
      <details
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
        style={{
          width: "min(360px, 100%)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          background: "transparent",
          color: "var(--fg-dim)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
        }}
      >
        <summary
          style={{
            cursor: "pointer",
            listStyle: "none",
            padding: "5px 10px",
            textAlign: "center",
          }}
        >
          Working notes · {notes.length}
        </summary>
        <div
          style={{
            borderTop: "1px solid var(--border)",
            padding: "7px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            color: "var(--fg-subtle)",
            whiteSpace: "pre-wrap",
          }}
        >
          {notes.map((note, idx) => (
            <div key={idx}>{note}</div>
          ))}
        </div>
      </details>
    </div>
  );
}

function ConversationAvatar({
  source,
  provider,
  label,
  model,
  user,
}: {
  source: RunSource;
  provider?: string | null;
  label: string;
  model?: string | null;
  user?: boolean;
}) {
  const initials = user ? initialsOf(label || "Me") : null;
  const modelLogoRule =
    source === "opencode" && model
      ? MODEL_LOGO_RULES.find((r) => r.pattern.test(model))
      : null;
  const ModelLogo = modelLogoRule?.Comp;
  const logo =
    source === "klide" && provider ? (
      <SourceLogo source={source} provider={provider} model={model} size={21} />
    ) : source === "claude-code" ? (
      <ClaudeCodeLogo size={21} />
    ) : source === "codex" ? (
      <CodexLogo size={21} />
    ) : source === "opencode" && ModelLogo ? (
      <ModelLogo size={21} />
    ) : (
      <SourceLogo source={source} size={21} />
    );
  return (
    <div
      title={label}
      style={{
        width: 34,
        height: 34,
        borderRadius: "50%",
        background: user ? "var(--accent-soft)" : "transparent",
        color: user ? "var(--fg-strong)" : runAgentColor({ source, provider }),
        display: "grid",
        placeItems: "center",
        fontSize: user ? 12 : undefined,
        fontFamily: user ? "var(--font-ui)" : undefined,
        fontWeight: user ? 650 : undefined,
        justifySelf: user ? "start" : "end",
      }}
    >
      {user ? initials : logo}
    </div>
  );
}

function initialsOf(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]+/g, " ").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function compactToolValue(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") return value.trim() || null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolStatusLabel(tool: RunToolCall): string | null {
  if (tool.status === "finished") return tool.ok === false ? "failed" : "done";
  if (tool.status === "started") return "running";
  return null;
}

function ToolDetailBlock({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gap: 3 }}>
      <div
        style={{
          color: "var(--fg-dim)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          fontSize: 9,
        }}
      >
        {label}
      </div>
      <pre
        style={{
          margin: 0,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          color: "var(--fg-subtle)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          lineHeight: 1.45,
        }}
      >
        {value}
      </pre>
    </div>
  );
}

function ToolStack({ tools }: { tools: RunToolCall[] }) {
  return (
    <div
      style={{
        position: "relative",
        marginLeft: 18,
        paddingLeft: 16,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          top: -8,
          bottom: 10,
          width: 1,
          background: "color-mix(in srgb, var(--border) 82%, transparent)",
        }}
      />
      {tools.map((tool, idx) => (
        <ToolDisclosure key={`${tool.id ?? tool.name}-${idx}`} tool={tool} />
      ))}
    </div>
  );
}

function ToolDisclosure({ tool }: { tool: RunToolCall }) {
  const input = compactToolValue(tool.input);
  const result = compactToolValue(tool.result);
  const status = toolStatusLabel(tool);
  const hasDetails = Boolean(tool.summary || input || result);
  return (
    <details
      style={{
        width: "min(420px, 100%)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        background: "transparent",
        color: "var(--fg-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          listStyle: "none",
          padding: "4px 9px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--fg-dim)",
          }}
        >
          {tool.name || "tool"}
        </span>
        {status && (
          <span
            style={{
              flexShrink: 0,
              color: status === "failed" ? "var(--danger)" : "var(--fg-subtle)",
            }}
          >
            {status}
          </span>
        )}
      </summary>
      <div
        style={{
          borderTop: "1px solid var(--border)",
          padding: "7px 9px 8px",
          display: "grid",
          gap: 8,
        }}
      >
        {tool.summary && <ToolDetailBlock label="summary" value={tool.summary} />}
        {input && <ToolDetailBlock label="input" value={input} />}
        {result && <ToolDetailBlock label="result" value={result} />}
        {!hasDetails && (
          <div style={{ color: "var(--fg-subtle)", lineHeight: 1.45 }}>
            Details were not captured in this session log.
          </div>
        )}
      </div>
    </details>
  );
}

// Keep tool calls available without letting them dominate the transcript.
// The opencode message flattener emits `[tool: <name>]`; the shared
// renderer parses the marker and calls us with the parsed name and
// summary. We render it as a collapsed activity row so the conversation
// remains the primary surface.
function ToolCard({ name, summary }: { name: string; summary?: string }) {
  return (
    <details
      style={{
        display: "block",
        width: "fit-content",
        margin: "4px 0",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        lineHeight: 1.3,
        color: "var(--fg-dim)",
      }}
    >
      <summary
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          listStyle: "none",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: "var(--fg-dim)",
          }}
        />
        <span>{name}</span>
      </summary>
      {summary && (
        <div style={{ marginTop: 3, paddingLeft: 11, color: "var(--fg-subtle)" }}>
          {summary}
        </div>
      )}
    </details>
  );
}

// The add-task affordance. A quiet ghost row at the top of the board — click it
// (or just start typing) and it becomes an inline input. A new task lands in
// Queued directly below, so creation sits where the result appears. Escape or an
// empty blur collapses it back to the row. Sending an agent to the task happens
// from its detail pane, so adding stays instant.
function TaskComposer({
  workspaceRoot,
  onAdded,
}: {
  workspaceRoot: string | null;
  onAdded: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function add() {
    const title = text.trim();
    if (!title) return;
    const task = addTask(title, workspaceRoot);
    setText("");
    setEditing(false);
    onAdded(task.id);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "calc(100% - 16px)",
          margin: "0 8px 10px",
          padding: "8px 9px",
          fontSize: 12.5,
          fontFamily: "inherit",
          textAlign: "left",
          color: "var(--fg-subtle)",
          background: "transparent",
          border: "1px dashed var(--border)",
          borderRadius: "var(--radius-md)",
          cursor: "pointer",
          transition:
            "border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "var(--border-strong)";
          e.currentTarget.style.color = "var(--fg-strong)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "var(--border)";
          e.currentTarget.style.color = "var(--fg-subtle)";
        }}
      >
        <span aria-hidden style={{ fontSize: 14, lineHeight: 1, marginTop: -1 }}>
          +
        </span>
        Add a task
      </button>
    );
  }

  return (
    <div style={{ margin: "0 8px 10px" }}>
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setText("");
            setEditing(false);
          }
        }}
        onBlur={() => {
          if (!text.trim()) setEditing(false);
        }}
        placeholder="Add a task…"
        style={{
          width: "100%",
          boxSizing: "border-box",
          fontSize: 12.5,
          lineHeight: 1.5,
          fontFamily: "inherit",
          color: "var(--fg-strong)",
          background: "var(--bg-elevated)",
          border: "1px solid var(--accent)",
          borderRadius: "var(--radius-md)",
          padding: "7px 9px",
          outline: "none",
        }}
      />
    </div>
  );
}

// One agent pick of a race: harness provider + model. Delegate CLIs are
// excluded — a race run is a headless harness run in a worktree.
function RaceAgentRow({
  label,
  pick,
  onChange,
}: {
  label: string;
  pick: RaceAgentPick;
  onChange: (next: RaceAgentPick) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const providers = selectableProviders({ includeDelegates: false });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setModels([]);
    listProviderModels(pick.provider)
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        if (list.length > 0 && !list.includes(pick.model)) {
          onChange({ ...pick, model: list[0] });
        }
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Refetch only on provider change; `pick.model`/`onChange` churn per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick.provider]);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <span
        style={{
          width: 14,
          flexShrink: 0,
          fontSize: 11,
          color: "var(--fg-subtle)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {label}
      </span>
      {/* Provider: logo + quiet native select (the list is short); model:
          the classic ModelPicker, opening downward since this row sits at
          the top of the board. */}
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flex: "0 0 148px",
          minWidth: 0,
          height: 26,
          padding: "0 4px 0 7px",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          background: "var(--bg)",
        }}
      >
        <span style={{ display: "grid", placeItems: "center", flexShrink: 0 }}>
          <ProviderLogo id={pick.provider} size={13} />
        </span>
        <select
          value={pick.provider}
          onChange={(e) => onChange({ provider: e.target.value as ProviderId, model: "" })}
          style={{
            flex: 1,
            minWidth: 0,
            height: "100%",
            fontSize: 12,
            fontFamily: "inherit",
            color: "var(--fg-strong)",
            background: "transparent",
            border: "none",
            outline: "none",
            cursor: "pointer",
          }}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </span>
      {loading ? (
        <span style={{ flex: 1, fontSize: 11.5, color: "var(--fg-dim)" }}>Loading models…</span>
      ) : (
        <ModelPicker
          provider={pick.provider}
          model={pick.model}
          availableModels={models}
          onChange={(m) => onChange({ ...pick, model: m })}
          direction="down"
          fluid
        />
      )}
    </div>
  );
}

// The race affordance — a quiet ghost row under the task composer. Expanded,
// it takes one prompt and two agent picks, then dispatches both as headless
// harness runs in isolated worktrees (dispatchRace). The runs land on the
// board like any other; the detail pane's race section compares them.
function RaceComposer({
  workspaceRoot,
  onStarted,
  onWatch,
}: {
  workspaceRoot: string | null;
  onStarted: (firstRunId: string) => void;
  /** "Watch live" — open every racer in its own AI panel (free-mode split /
   *  Focus tabs) right after dispatch, instead of headless-only. */
  onWatch?: (group: RaceGroup) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);
  const [watchLive, setWatchLive] = useState(
    () => localStorage.getItem("klide.race.watchLive") === "true"
  );
  const [picks, setPicks] = useState<RaceAgentPick[]>([
    { provider: "ollama", model: DEFAULT_MODELS.ollama ?? "" },
    { provider: "anthropic", model: DEFAULT_MODELS.anthropic ?? "" },
  ]);

  function toggleWatchLive() {
    setWatchLive((v) => {
      localStorage.setItem("klide.race.watchLive", String(!v));
      return !v;
    });
  }

  async function start() {
    const text = prompt.trim();
    if (!text || starting) return;
    if (!workspaceRoot) {
      notify("Open a workspace folder before starting a race.", { tone: "warn" });
      return;
    }
    if (picks.some((p) => !p.model)) {
      notify("Pick a model for both agents first.", { tone: "warn" });
      return;
    }
    setStarting(true);
    try {
      const group = await dispatchRace({ prompt: text, workspaceRoot, agents: picks });
      notify(`Race started — ${group.members.length} agents, each in its own worktree.`);
      setPrompt("");
      setEditing(false);
      if (group.members[0]) onStarted(group.members[0].runId);
      if (watchLive && group.members.length > 0) onWatch?.(group);
    } catch (err) {
      if (err instanceof PartialRaceError) {
        notify(`Race started, but not fully: ${err.failures.join(" · ")}`, { tone: "warn" });
        setPrompt("");
        setEditing(false);
        if (err.group.members[0]) onStarted(err.group.members[0].runId);
        if (watchLive && err.group.members.length > 0) onWatch?.(err.group);
      } else {
        notify(`Race failed: ${err instanceof Error ? err.message : String(err)}`, {
          tone: "error",
        });
      }
    } finally {
      setStarting(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "calc(100% - 16px)",
          margin: "0 8px 10px",
          padding: "8px 9px",
          fontSize: 12.5,
          fontFamily: "inherit",
          textAlign: "left",
          color: "var(--fg-subtle)",
          background: "transparent",
          border: "1px dashed var(--border)",
          borderRadius: "var(--radius-md)",
          cursor: "pointer",
          transition:
            "border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "var(--border-strong)";
          e.currentTarget.style.color = "var(--fg-strong)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "var(--border)";
          e.currentTarget.style.color = "var(--fg-subtle)";
        }}
      >
        <RaceMark size={12} />
        Race two agents on one task
      </button>
    );
  }

  return (
    <div
      style={{
        margin: "0 8px 10px",
        padding: "9px",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-md)",
        background: "var(--bg-elevated)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <input
        autoFocus
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void start();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        placeholder="One task for both agents…"
        style={{
          width: "100%",
          boxSizing: "border-box",
          fontSize: 12.5,
          lineHeight: 1.5,
          fontFamily: "inherit",
          color: "var(--fg-strong)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          padding: "7px 9px",
          outline: "none",
        }}
      />
      <RaceAgentRow label="A" pick={picks[0]} onChange={(next) => setPicks([next, picks[1]])} />
      <RaceAgentRow label="B" pick={picks[1]} onChange={(next) => setPicks([picks[0], next])} />
      <div
        style={{ display: "flex", alignItems: "center", gap: 8 }}
        title="Each agent works in its own worktree; edits auto-apply with checkpoints."
      >
        <label
          title="Open both agents on screen when the race starts — side-by-side panels, or tabs in Focus"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11.5,
            color: watchLive ? "var(--fg-strong)" : "var(--fg-subtle)",
            cursor: "pointer",
            userSelect: "none",
            marginRight: "auto",
            transition: "color var(--motion-fast) var(--ease-out)",
          }}
        >
          <input
            type="checkbox"
            checked={watchLive}
            onChange={toggleWatchLive}
            style={{ margin: 0, width: 13, height: 13, accentColor: "var(--accent)" }}
          />
          Watch live
        </label>
        <ActionButton label="Cancel" onClick={() => setEditing(false)} />
        <ActionButton label={starting ? "Starting…" : "Start race"} onClick={() => void start()} />
      </div>
    </div>
  );
}

// Live console of a dispatched task. The PTY was spawned at dispatch time —
// here we replay the buffered scrollback, then stream. Typing goes straight to
// the CLI, so "take over" is just clicking in and typing. Mirrors the main
// TerminalPanel's xterm setup so both terminals feel like the same surface.
function TaskTerminal({ sessionId, theme }: { sessionId: string; theme: ThemeId }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const term = new Terminal({
      fontSize: 11.5,
      lineHeight: 1.25,
      fontFamily:
        "Monaspace Neon, Monaspace Argon, JetBrains Mono, SF Mono, Menlo, ui-monospace, monospace",
      theme: {
        background: cssVar("--terminal-bg"),
        foreground: cssVar("--terminal-fg"),
        cursor: cssVar("--terminal-cursor"),
      },
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    // Fit (and tell the PTY the real size) BEFORE replaying the scrollback —
    // otherwise the replay wraps at the spawn-time 100 cols and looks mangled
    // until the CLI's next full redraw.
    const syncSize = () => {
      fit.fit();
      void invoke("delegate_pty_resize", { sessionId, rows: term.rows, cols: term.cols });
    };
    syncSize();
    term.write(getTaskBuffer(sessionId));
    term.focus();

    const unlisten = listen<{ sessionId: string; data: string }>(
      "delegate-pty:data",
      (e) => {
        if (e.payload.sessionId === sessionId) term.write(e.payload.data);
      }
    );
    term.onData((data) => {
      void invoke("delegate_pty_write", { sessionId, data });
    });

    const resize = new ResizeObserver(syncSize);
    resize.observe(ref.current);

    return () => {
      unlisten.then((u) => u());
      resize.disconnect();
      term.dispose();
    };
    // `theme` re-creates the terminal so cssVar() picks up the new palette —
    // same pattern as TerminalPanel. The replay buffer restores the content.
  }, [sessionId, theme]);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "color-mix(in srgb, var(--terminal-bg) 96%, var(--bg))",
        borderTop: "1px solid var(--terminal-border)",
      }}
    >
      <div ref={ref} style={{ minHeight: 0, padding: 4, height: "min(100%, 520px)" }} />
    </div>
  );
}

// Custom model picker. The native <select> works but is cramped for 17+
// opencode models and can't group the opencode-go (paid) and opencode
// (free) tiers. This is a button + popover list with click-outside dismiss,
// grouped headers, and the opencode logo for opencode groups.
function ModelSelect({
  models,
  value,
  onChange,
  emptyLabel,
}: {
  models: string[];
  value: string;
  onChange: (m: string) => void;
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  // Group models by their provider prefix (the part before the first "/").
  // Claude/Codex don't have a slash, so they land in an empty-prefix group;
  // opencode splits naturally into "opencode-go" (paid) and "opencode"
  // (free). Empty groups are dropped so a single-provider list stays flat.
  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const m of models) {
      const slash = m.indexOf("/");
      const key = slash >= 0 ? m.slice(0, slash) : "";
      const arr = map.get(key) ?? [];
      arr.push(m);
      map.set(key, arr);
    }
    return Array.from(map.entries()).map(([provider, items]) => ({ provider, items }));
  }, [models]);

  const isOpencodeGroup = (p: string) => p === "opencode" || p === "opencode-go";
  const label = value || emptyLabel || "Select a model";

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          padding: "5px 9px",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--border)",
          color: value ? "var(--fg-strong)" : "var(--fg-subtle)",
          background: "var(--bg-elevated)",
          fontFamily: "var(--font-mono)",
          minWidth: 220,
          maxWidth: 320,
          cursor: "pointer",
        }}
      >
        <span
          style={{
            flex: 1,
            textAlign: "left",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        <span style={{ color: "var(--fg-subtle)", fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            minWidth: 280,
            maxHeight: 360,
            overflowY: "auto",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--panel-shadow)",
            zIndex: 20,
          }}
        >
          {groups.length === 0 ? (
            <div style={{ padding: "12px", fontSize: 11, color: "var(--fg-dim)" }}>
              No models available.
            </div>
          ) : (
            groups.map(({ provider, items }) => (
              <div key={provider || "default"}>
                {provider && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 10,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "var(--fg-dim)",
                      padding: "8px 12px 4px",
                      fontFamily: "var(--font-mono)",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    {isOpencodeGroup(provider) ? (
                      <>
                        <span
                          className="opencode-logo"
                          style={{ width: 12, height: 12, display: "inline-block" }}
                          aria-hidden="true"
                        >
                          <img
                            className="opencode-logo-light"
                            src="/opencode-logo-light.svg"
                            alt=""
                            style={{ width: 12, height: 12 }}
                          />
                          <img
                            className="opencode-logo-dark"
                            src="/opencode-logo-dark.svg"
                            alt=""
                            style={{ width: 12, height: 12 }}
                          />
                        </span>
                        <span>
                          opencode · {provider === "opencode-go" ? "paid" : "free"}
                        </span>
                      </>
                    ) : (
                      <span>{provider}</span>
                    )}
                  </div>
                )}
                {items.map((m) => {
                  const isSelected = m === value;
                  return (
                    <button
                      key={m}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => {
                        onChange(m);
                        setOpen(false);
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        fontSize: 12,
                        padding: "7px 12px",
                        color: isSelected ? "var(--accent)" : "var(--fg)",
                        background: isSelected ? "var(--bg-selected)" : "transparent",
                        border: "none",
                        cursor: "pointer",
                        fontFamily: "var(--font-mono)",
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "transparent";
                      }}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function TaskDetail({ task, theme }: { task: TaskSession; theme: ThemeId }) {
  const [agent, setAgent] = useState<TaskSource>(lastAgent);
  const [model, setModel] = useState<string>(lastModel(lastAgent()));
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // queued/error = the todo needs (re)dispatching; running/done = a delegate
  // worked on it and the terminal is the record.
  const needsAgent = task.status === "queued" || task.status === "error";

  // Reload the model list whenever the user picks a different source. We
  // also clear `model` immediately so the dropdown doesn't flash the
  // previous provider's model name during the refetch.
  useEffect(() => {
    let cancelled = false;
    setLoadingModels(true);
    setModels([]);
    setModel("");
    listProviderModels(agent)
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        const remembered = lastModel(agent);
        if (list.includes(remembered)) {
          setModel(remembered);
        } else if (list.length > 0) {
          setModel(list[0]);
        } else {
          setModel("");
        }
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agent]);

  async function send() {
    setFailure(null);
    try {
      // Pass undefined (not "") so the Rust side skips the model flag and the
      // CLI uses its own default. The tasks store remembers the pick for
      // next time regardless.
      await dispatchTask(task.id, agent, model || undefined);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "20px 24px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <RunAvatar source={task.source ?? "klide"} kind="task" size={30} />
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span
              style={{ fontSize: 12, color: "var(--fg-strong)", fontFamily: "var(--font-mono)" }}
            >
              {task.source ? SOURCE_LABEL[task.source] : "Todo"}
            </span>
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: STATUS_COLOR[task.status],
                fontFamily: "var(--font-mono)",
              }}
            >
              <StatusDot status={task.status} size={6} />
              {STATUS_LABEL[task.status]}
            </span>
          </div>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {task.status === "running" ? (
              <ActionButton label="Stop" onClick={() => void stopTask(task.id)} />
            ) : (
              <ActionButton label="Remove" onClick={() => removeTask(task.id)} />
            )}
          </span>
        </div>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-strong)", margin: 0 }}>
          {task.title}
        </h2>
        {task.cwd && (
          <div
            style={{
              marginTop: 6,
              fontSize: 11,
              color: "var(--fg-subtle)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {task.cwd}
          </div>
        )}
      </div>
      {needsAgent ? (
        <div style={{ padding: "6px 24px 24px" }}>
          <DetailLabel>Send an agent</DetailLabel>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {DELEGATE_IDS.map((s) => (
              <FilterChip
                key={s}
                label={SOURCE_LABEL[s]}
                active={agent === s}
                onClick={() => setAgent(s)}
              />
            ))}
            <span style={{ marginLeft: 10 }}>
              <ActionButton label="Send agent" primary onClick={() => void send()} />
            </span>
          </div>
          <div
            style={{
              marginTop: 10,
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontSize: 10,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--fg-subtle)",
                fontFamily: "var(--font-mono)",
              }}
            >
              Model
            </span>
            {loadingModels ? (
              <span
                style={{
                  fontSize: 12,
                  padding: "5px 9px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border)",
                  color: "var(--fg-dim)",
                  background: "var(--bg-elevated)",
                  fontFamily: "var(--font-mono)",
                  minWidth: 220,
                  maxWidth: 320,
                  opacity: 0.7,
                }}
              >
                Loading {SOURCE_LABEL[agent]} models…
              </span>
            ) : models.length > 0 ? (
              <ModelSelect
                models={models}
                value={model}
                onChange={setModel}
                emptyLabel={`Default ${SOURCE_LABEL[agent]} model`}
              />
            ) : (
              <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                {SOURCE_LABEL[agent]} CLI isn't installed — install it to pick a model.
              </span>
            )}
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-subtle)", lineHeight: 1.5 }}>
            The agent opens in the workspace with this task as its first
            prompt. You can watch it live here, type to take over, or stop it.
          </div>
          {failure && (
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--danger)" }}>
              {failure}
            </div>
          )}
        </div>
      ) : (
        <TaskTerminal sessionId={task.id} theme={theme} />
      )}
    </div>
  );
}

function RunDetail({
  run,
  workspaceRoot,
  messages,
  handoffPrompt,
  hasMemory,
  onRename,
  onArchive,
  onFork,
  onForkInWorktree,
  onMergeWorktree,
  forkParent,
  forkChildren = [],
  onSelectLineageRun,
  race = null,
  raceEntries = [],
  onOpenInAiPanel,
  onResumeKlide,
  onReviewRun,
  onOpenArtifact,
  onSaveMemory,
  summarizingFromRunId,
}: {
  run: RunLedgerEntry;
  workspaceRoot: string | null;
  messages?: RunMessage[];
  /** A durable Project Memory note exists for this run (matched by runId). */
  hasMemory?: boolean;
  onRename?: (run: RunLedgerEntry, title: string) => void;
  onArchive?: (run: RunLedgerEntry, archived: boolean) => void;
  onFork?: (run: RunLedgerEntry, messages?: RunMessage[]) => void;
  onForkInWorktree?: (run: RunLedgerEntry, messages?: RunMessage[]) => void;
  onMergeWorktree?: (run: RunLedgerEntry) => void;
  forkParent?: RunLedgerEntry | null;
  forkChildren?: RunLedgerEntry[];
  onSelectLineageRun?: (run: RunLedgerEntry) => void;
  /** The race this run belongs to (same task, N agents in worktrees), with
   *  each member's ledger entry when it has landed on the board. */
  race?: RaceGroup | null;
  raceEntries?: { member: RaceMember; entry: RunLedgerEntry | null }[];
  /** Compact task state used when handing a Klide run off to an external CLI. */
  handoffPrompt: string | null;
  /** Land the user in a new AI panel pinned to the chosen delegate provider. */
  onOpenInAiPanel?: (opts: {
    provider: TaskSource;
    workspaceRoot: string | null;
    resumeSessionId?: string;
    initialTask?: string;
  }) => void;
  onResumeKlide?: (runId: string) => void;
  /** Open this Run's changes in Mission Control's docked Artifact Inspector. */
  onReviewRun?: (run: RunLedgerEntry) => void;
  /** Open one file or diff without leaving the selected Run. */
  onOpenArtifact?: (request: ArtifactRequest) => void;
  onSaveMemory?: (run: { id: string; source: string; provider?: string | null; model: string | null; cwd: string | null }) => void;
  summarizingFromRunId?: string | null;
}) {
  // All 3 external CLIs support resume flags today: `claude --resume <id>`,
  // `codex resume <id>`, and `opencode -s <id>`. The Rust seam builds the
  // right command for each, so the UI just needs to be honest about it.
  const resumable = isDelegateId(run.source) && run.capabilities.canResume;
  // The full set of CLI sources we can offer as "Open in {source}". Klide
  // runs hand off to one of these with compact task state as the prompt.
  const cliSources: DelegateId[] = handoffTargetsFor(run);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(run.title);
  const [exportState, setExportState] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const [evidenceState, setEvidenceState] = useState<"idle" | "exporting" | "saved" | "error">("idle");
  const [compareState, setCompareState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [branchDiff, setBranchDiff] = useState<GitBranchDiffSummary | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);

  useEffect(() => {
    setRenameDraft(run.title);
    setRenaming(false);
    setCompareState("idle");
    setBranchDiff(null);
    setCompareError(null);
    setEvidenceState("idle");
  }, [run.id, run.source, run.title]);

  function commitRename() {
    const title = renameDraft.trim();
    if (!title || title === run.title) {
      setRenaming(false);
      setRenameDraft(run.title);
      return;
    }
    onRename?.(run, title);
    setRenaming(false);
  }

  async function exportTranscript() {
    setExportState("copying");
    try {
      const rows = await messagesForRun(run, messages);
      if (rows.length === 0) throw new Error("No readable messages.");
      await navigator.clipboard.writeText(runMessagesToMarkdown(run, rows, runAgentLabel(run)));
      setExportState("copied");
      window.setTimeout(() => setExportState((state) => (state === "copied" ? "idle" : state)), 1400);
    } catch {
      setExportState("error");
      window.setTimeout(() => setExportState((state) => (state === "error" ? "idle" : state)), 1800);
    }
  }

  async function exportEvidence() {
    setEvidenceState("exporting");
    try {
      const res = await invoke<{ markdown: string; relPath: string | null; absPath: string | null }>(
        "agent_export_evidence",
        { runId: run.id, workspaceRoot: run.cwd ?? workspaceRoot ?? null },
      );
      setEvidenceState("saved");
      notify(res.relPath ? `Evidence packet saved to ${res.relPath}` : "Evidence packet generated", {
        action: {
          label: "Copy Markdown",
          run: () => void navigator.clipboard.writeText(res.markdown),
        },
      });
      window.setTimeout(() => setEvidenceState((state) => (state === "saved" ? "idle" : state)), 1400);
    } catch (err) {
      setEvidenceState("error");
      notify(`Evidence export failed: ${err instanceof Error ? err.message : String(err)}`);
      window.setTimeout(() => setEvidenceState((state) => (state === "error" ? "idle" : state)), 1800);
    }
  }

  async function compareBranchWithBase() {
    if (!workspaceRoot || !run.branch) {
      setCompareError("No base workspace or branch available for this run.");
      setCompareState("error");
      return;
    }
    setCompareState("loading");
    setCompareError(null);
    try {
      const next = await invoke<GitBranchDiffSummary>("git_branch_diff", {
        workspaceRoot,
        branch: run.branch,
        baseBranch: null,
      });
      setBranchDiff(next);
      setCompareState("ready");
    } catch (err) {
      setBranchDiff(null);
      setCompareError(err instanceof Error ? err.message : String(err));
      setCompareState("error");
    }
  }

  return (
    <div style={{ padding: "20px 24px", overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <RunAvatar source={run.source} kind={run.kind} model={run.model} provider={run.provider} size={30} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span
            style={{ fontSize: 12, color: "var(--fg-strong)", fontFamily: "var(--font-mono)" }}
          >
            {runAgentLabel(run)}
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: LIFECYCLE_COLOR[run.lifecycle],
              fontFamily: "var(--font-mono)",
            }}
          >
            <StatusDot status={run.status} size={6} />
            {LIFECYCLE_LABEL[run.lifecycle]}
          </span>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 14px", flexWrap: "wrap" }}>
        {renaming ? (
          <input
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setRenaming(false);
                setRenameDraft(run.title);
              }
            }}
            onBlur={commitRename}
            autoFocus
            aria-label="Rename session"
            style={{
              minWidth: "min(420px, 100%)",
              flex: "1 1 260px",
              height: 32,
              padding: "0 9px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border-strong)",
              background: "var(--bg)",
              color: "var(--fg-strong)",
              fontSize: 18,
              fontWeight: 600,
              fontFamily: "inherit",
              outline: "none",
            }}
          />
        ) : (
          <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--fg-strong)", margin: 0 }}>
            {run.title}
          </h2>
        )}
        <RoutineBadge run={run} />
      </div>

      <RunEvidenceStrip run={run} hasMemory={hasMemory} />

      {(forkParent || forkChildren.length > 0) && (
        <div
          style={{
            margin: "0 0 12px",
            padding: "8px 10px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border)",
            background: "var(--bg-elevated)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            fontSize: 12,
          }}
        >
          {forkParent && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span style={{ color: "var(--fg-subtle)", flexShrink: 0 }}>Parent</span>
              <span
                style={{
                  minWidth: 0,
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--fg-strong)",
                }}
                title={forkParent.title}
              >
                {forkParent.title}
              </span>
              {onSelectLineageRun && (
                <ActionButton label="Open parent" onClick={() => onSelectLineageRun(forkParent)} />
              )}
            </div>
          )}
          {forkChildren.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ color: "var(--fg-subtle)" }}>
                Forks from this run
              </div>
              {forkChildren.slice(0, 5).map((child) => (
                <button
                  key={child.id}
                  type="button"
                  onClick={() => onSelectLineageRun?.(child)}
                  disabled={!onSelectLineageRun}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    minWidth: 0,
                    padding: "4px 0",
                    border: "none",
                    background: "transparent",
                    color: "var(--fg-strong)",
                    cursor: onSelectLineageRun ? "pointer" : "default",
                    textAlign: "left",
                    font: "inherit",
                  }}
                >
                  <span style={{ color: "var(--fg-subtle)", fontFamily: "var(--font-mono)", fontSize: 11, flexShrink: 0 }}>
                    #{(child.forkedFrom?.messageIndex ?? 0) + 1}
                  </span>
                  <span
                    style={{
                      minWidth: 0,
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={child.title}
                  >
                    {child.title}
                  </span>
                  {child.worktree && (
                    <span style={{ color: "var(--fg-subtle)", fontFamily: "var(--font-mono)", fontSize: 11, flexShrink: 0 }}>
                      worktree
                    </span>
                  )}
                </button>
              ))}
              {forkChildren.length > 5 && (
                <div style={{ color: "var(--fg-subtle)", fontSize: 11 }}>
                  +{forkChildren.length - 5} more forks
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {race && raceEntries.length > 0 && (
        <div
          style={{
            margin: "0 0 12px",
            padding: "8px 10px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border)",
            background: "var(--bg-elevated)",
            fontSize: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: "var(--fg-subtle)",
              marginBottom: 7,
            }}
            title={`Same task, ${raceEntries.length} agents: “${race.prompt}”`}
          >
            <RaceMark size={11} />
            Race
          </div>
          <RaceCompareTable
            raceEntries={raceEntries}
            currentRunId={run.id}
            onSelectRun={onSelectLineageRun}
          />
        </div>
      )}

      {run.archived && (
        <div
          style={{
            margin: "0 0 12px",
            padding: "7px 9px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border)",
            background: "var(--bg-hover)",
            color: "var(--fg-subtle)",
            fontSize: 12,
          }}
        >
          Archived session
        </div>
      )}

      {/* Icon-only action bar — no chrome, just two purpose-grouped clusters
          pushed to opposite edges. LEFT (ragged-right) = continue this run:
          resume / hand off / fork / review. RIGHT (ragged-left) = manage it:
          memory, export, rename, archive, copy. Every control carries a
          tooltip + aria-label so the meaning stays one hover away. */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 20,
          rowGap: 10,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        {/* LEFT cluster — act on / continue the run */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {/* Headline: resume this same agent (CLI runs reopen the delegate,
              Klide runs reopen the AI panel) — wears the agent's own logo. */}
          {resumable && onOpenInAiPanel && (
            <IconActionButton
              tone="primary"
              label={`Resume in ${SOURCE_LABEL[run.source]}`}
              icon={<SourceLogo source={run.source} size={16} />}
              onClick={() =>
                onOpenInAiPanel({
                  provider: run.source as TaskSource,
                  workspaceRoot: run.cwd,
                  resumeSessionId: run.id,
                })
              }
            />
          )}
          {run.source === "klide" && run.capabilities.canResume && onResumeKlide && (
            <IconActionButton
              tone="primary"
              label="Resume in Klide"
              icon={<KlideLogo size={16} />}
              onClick={() => onResumeKlide(run.id)}
            />
          )}
          {/* "Open in {other CLI}" hands the run off to a fresh delegate TUI in
              a new AI panel — each wears that CLI's provider logo. Klide runs
              pass compact task state so the session starts with context. */}
          {onOpenInAiPanel &&
            run.capabilities.canOpenInOtherAgent &&
            cliSources.map((s) => (
              <IconActionButton
                key={s}
                label={`Open in ${SOURCE_LABEL[s]}`}
                icon={<SourceLogo source={s} size={16} />}
                onClick={() =>
                  onOpenInAiPanel({
                    provider: s,
                    workspaceRoot: run.cwd,
                    initialTask:
                      run.source === "klide" && handoffPrompt ? handoffPrompt : undefined,
                  })
                }
              />
            ))}
          {onReviewRun && run.capabilities.canReviewDiff && (
            <IconActionButton
              label="Review changes"
              icon={DiffGlyph}
              onClick={() => onReviewRun(run)}
            />
          )}
          {onFork && run.capabilities.canFork && (
            <IconActionButton label="Fork" icon={ForkGlyph} onClick={() => onFork(run, messages)} />
          )}
          {onForkInWorktree && run.capabilities.canFork && (run.cwd || run.source === "klide") && (
            <IconActionButton
              label="Fork in worktree"
              icon={WorktreeGlyph}
              onClick={() => onForkInWorktree(run, messages)}
            />
          )}
          {onMergeWorktree && run.worktree && run.branch && (
            <IconActionButton label="Merge worktree" icon={MergeGlyph} onClick={() => onMergeWorktree(run)} />
          )}
          {run.worktree && run.branch && (
            <IconActionButton
              label={
                compareState === "loading"
                  ? "Comparing…"
                  : branchDiff
                  ? "Refresh compare"
                  : "Compare with base"
              }
              icon={CompareGlyph}
              disabled={compareState === "loading"}
              onClick={() => void compareBranchWithBase()}
            />
          )}
        </div>

        {/* RIGHT cluster — manage / meta utilities */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {onSaveMemory && run.source === "klide" && run.capabilities.canSaveMemory && (
            <IconActionButton
              label={summarizingFromRunId === run.id ? "Saving memory…" : "Save memory"}
              icon={MemoryGlyph}
              disabled={summarizingFromRunId === run.id}
              onClick={() =>
                onSaveMemory({
                  id: run.id,
                  source: run.source,
                  provider: run.provider ?? null,
                  model: run.model,
                  cwd: run.cwd,
                })
              }
            />
          )}
          {run.capabilities.canExportTranscript && (
            <IconActionButton
              tone={exportState === "copied" ? "success" : "default"}
              label={
                exportState === "copying"
                  ? "Exporting…"
                  : exportState === "copied"
                  ? "Copied transcript"
                  : exportState === "error"
                  ? "Export failed — try again"
                  : "Export transcript"
              }
              icon={exportState === "copied" ? CheckGlyph : ExportGlyph}
              disabled={exportState === "copying"}
              onClick={() => void exportTranscript()}
            />
          )}
          {run.capabilities.canExportEvidence && (
            <IconActionButton
              tone={evidenceState === "saved" ? "success" : "default"}
              label={
                evidenceState === "exporting"
                  ? "Exporting…"
                  : evidenceState === "saved"
                  ? "Evidence saved"
                  : evidenceState === "error"
                  ? "Evidence export failed — try again"
                  : "Export evidence packet"
              }
              icon={evidenceState === "saved" ? CheckGlyph : EvidenceGlyph}
              disabled={evidenceState === "exporting"}
              onClick={() => void exportEvidence()}
            />
          )}
          {onRename && run.capabilities.canRename && (
            <IconActionButton
              tone={renaming ? "success" : "default"}
              label={renaming ? "Save name" : "Rename"}
              icon={renaming ? CheckGlyph : PencilGlyph}
              onClick={() => {
                if (renaming) commitRename();
                else setRenaming(true);
              }}
            />
          )}
          {onArchive && run.capabilities.canArchive && (
            <IconActionButton
              label={run.archived ? "Unarchive" : "Archive"}
              icon={ArchiveGlyph}
              onClick={() => onArchive(run, !run.archived)}
            />
          )}
          <CopyButton value={run.path || null} label="Copy log path" icon={CopyGlyph} />
          <CopyButton value={run.cwd} label="Copy cwd" icon={FolderGlyph} />
        </div>
      </div>

      {(branchDiff || compareError) && (
        <div
          style={{
            margin: "0 0 16px",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            background: "var(--bg-elevated)",
            overflow: "hidden",
          }}
        >
          {branchDiff ? (
            <>
              <div
                style={{
                  padding: "9px 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                  fontSize: 12,
                }}
              >
                <span style={{ color: "var(--fg-subtle)" }}>Compare</span>
                <span style={{ color: "var(--fg-strong)", fontFamily: "var(--font-mono)" }}>
                  {branchDiff.baseBranch}...{branchDiff.branch}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ color: "var(--success)", fontFamily: "var(--font-mono)" }}>+{branchDiff.additions}</span>
                <span style={{ color: "var(--danger)", fontFamily: "var(--font-mono)" }}>-{branchDiff.deletions}</span>
              </div>
              <div style={{ maxHeight: 180, overflow: "auto", padding: "4px 0" }}>
                {branchDiff.files.length === 0 ? (
                  <div style={{ padding: "10px", color: "var(--fg-subtle)", fontSize: 12 }}>
                    No committed changes against base.
                  </div>
                ) : (
                  branchDiff.files.map((file) => (
                    <button
                      key={`${file.status}-${file.path}`}
                      type="button"
                      onClick={
                        onOpenArtifact && (run.cwd || workspaceRoot)
                          ? () =>
                              onOpenArtifact({
                                kind: "patch",
                                runId: run.id,
                                workspaceRoot: run.cwd ?? workspaceRoot!,
                                path: file.path,
                                diff: patchForFile(branchDiff.diff, file.path),
                                additions: file.additions,
                                deletions: file.deletions,
                                status: file.status,
                              })
                          : undefined
                      }
                      style={{
                        display: "grid",
                        gridTemplateColumns: "48px minmax(0, 1fr) 64px",
                        gap: 8,
                        alignItems: "center",
                        padding: "5px 10px",
                        fontSize: 12,
                        borderTop: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
                        borderRight: "none",
                        borderBottom: "none",
                        borderLeft: "none",
                        width: "100%",
                        background: "transparent",
                        textAlign: "left",
                        font: "inherit",
                        cursor: onOpenArtifact ? "pointer" : "default",
                      }}
                    >
                      <span style={{ color: "var(--fg-subtle)", fontFamily: "var(--font-mono)" }}>{file.status}</span>
                      <span
                        style={{
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          color: "var(--fg-strong)",
                          fontFamily: "var(--font-mono)",
                        }}
                        title={file.path}
                      >
                        {file.path}
                      </span>
                      <span style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>
                        <span style={{ color: "var(--success)" }}>+{file.additions}</span>{" "}
                        <span style={{ color: "var(--danger)" }}>-{file.deletions}</span>
                      </span>
                    </button>
                  ))
                )}
              </div>
              {branchDiff.diff.trim() && (
                <details style={{ borderTop: "1px solid var(--border)" }}>
                  <summary style={{ cursor: "pointer", padding: "8px 10px", color: "var(--fg-subtle)", fontSize: 12 }}>
                    Raw diff
                  </summary>
                  <pre
                    style={{
                      margin: 0,
                      padding: 10,
                      maxHeight: 260,
                      overflow: "auto",
                      background: "var(--bg)",
                      color: "var(--fg)",
                      fontSize: 11,
                      lineHeight: 1.5,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {branchDiff.diff}
                  </pre>
                </details>
              )}
            </>
          ) : (
            <div style={{ padding: "9px 10px", color: "var(--danger)", fontSize: 12 }}>
              {compareError}
            </div>
          )}
        </div>
      )}

      <div
        style={{
          height: 1,
          background: "var(--border)",
          margin: "0 0 16px",
        }}
        aria-hidden="true"
      />

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "7px 18px",
          fontSize: 12,
          margin: "0 0 12px",
        }}
      >
        <dt style={{ color: "var(--fg-subtle)" }}>Model</dt>
        <dd
          style={{
            margin: 0,
            color: "var(--fg-strong)",
            fontFamily: "var(--font-mono)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {run.source === "opencode" && run.model ? (
            <>
              <ModelProviderBadge model={run.model} />
              {modelProvider(run.model)} . {modelShortName(run.model)}
            </>
          ) : run.model ? (
            <>
              {/* Klide rows show the model's own provider logo; external
                  product runs (claude-code/codex) keep their product mark. */}
              {run.source === "klide" && run.provider
                ? providerMark(run.provider, 13)
                : run.source === "klide"
                ? resolveModelLogo(run.model, 13) ?? <ProviderLogo id={run.source as any} size={13} />
                : <ProviderLogo id={run.source as any} size={13} />}
              {runModelLabel(run)}
            </>
          ) : null}
        </dd>
        <MetaRow label="Project" value={run.project ?? "—"} />
        <MetaRow label="Branch" value={run.branch ?? "—"} />
        <MetaRow label="Messages" value={String(run.messageCount)} />
        <MetaRow label="Updated" value={relativeTime(run.updatedMs)} />
      </dl>

      {/* Secondary facts — fork lineage and the long log/cwd paths — are the
          noisiest rows but the least-glanced-at, so they sit behind a
          disclosure rather than pushing the conversation further down. */}
      {(run.forkedFrom || run.path || run.cwd) && (
        <details className="klide-disclosure" style={{ margin: "0 0 22px" }}>
          <summary
            style={{
              color: "var(--fg-subtle)",
              fontSize: 12,
              marginBottom: 8,
            }}
          >
            <span className="klide-disclosure-chevron" aria-hidden>
              <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                <path d="M3.5 2L7 5L3.5 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            More details
          </summary>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: "7px 18px",
              fontSize: 12,
              margin: 0,
            }}
          >
            {run.forkedFrom && (
              <>
                <MetaRow label="Forked from" value={run.forkedFrom.title} />
                <MetaRow
                  label="Fork point"
                  value={`${run.forkedFrom.mode === "worktree" ? "worktree" : "chat"} message #${run.forkedFrom.messageIndex + 1}`}
                />
              </>
            )}
            {run.path && <MetaRow label="Log" value={run.path} />}
            {run.cwd && <MetaRow label="Directory" value={run.cwd} />}
          </dl>
        </details>
      )}

      {run.source === "klide" && (
        <>
          <DetailLabel id={`klide-checkpoints-${run.id}`}>Checkpoints</DetailLabel>
          <div style={{ marginBottom: 22 }}>
            <CheckpointPanel
              runId={run.id}
              onOpenFile={
                onOpenArtifact
                  ? (entry) =>
                      onOpenArtifact({
                        kind: "file",
                        runId: run.id,
                        workspaceRoot: entry.workspaceRoot,
                        path: entry.path,
                      })
                  : undefined
              }
              onOpenDiff={
                onOpenArtifact
                  ? (entry) =>
                      onOpenArtifact({
                        kind: "diff",
                        runId: run.id,
                        workspaceRoot: entry.workspaceRoot,
                        path: entry.path,
                        original: entry.oldContent,
                        modified: entry.newContent,
                        isCreate: entry.isCreate,
                      })
                  : undefined
              }
            />
          </div>
        </>
      )}

      <DetailLabel>Conversation</DetailLabel>
      <ConversationView run={run} preloaded={messages} />
    </div>
  );
}

function ActionButton({
  label,
  primary,
  disabled,
  onClick,
}: {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={disabled && !onClick ? "Not wired yet" : undefined}
      style={{
        fontSize: 12,
        fontWeight: primary ? 560 : 400,
        padding: "5px 12px",
        borderRadius: "var(--radius-sm)",
        border: `1px solid ${primary && !disabled ? "var(--accent)" : "var(--border)"}`,
        color: disabled ? "var(--fg-subtle)" : primary ? "var(--control-primary-fg)" : "var(--fg)",
        background: primary && !disabled ? "var(--accent)" : "transparent",
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? "default" : "pointer",
        transition: "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        if (primary) e.currentTarget.style.filter = "brightness(1.08)";
        else { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.borderColor = "var(--border-strong)"; }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.filter = "none";
        if (!primary) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "var(--border)"; }
      }}
    >
      {label}
    </button>
  );
}

// Icon-only action button — the detail-pane action bar reads as a tidy row of
// glyphs (and provider logos) rather than a wall of text buttons. The label is
// surfaced via tooltip + aria-label so it stays accessible.
//   tone="primary"  → accent ring + soft fill (the headline action: Resume)
//   tone="success"  → accent border, used for transient "done" feedback
function IconActionButton({
  icon,
  label,
  tone = "default",
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  tone?: "default" | "primary" | "success";
  disabled?: boolean;
  onClick?: () => void;
}) {
  const accent = tone === "primary" || tone === "success";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        width: 28,
        height: 28,
        flexShrink: 0,
        display: "grid",
        placeItems: "center",
        border: "none",
        color: accent ? "var(--accent)" : "var(--fg-subtle)",
        background: "transparent",
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "default" : "pointer",
        transform: "scale(1)",
        transformOrigin: "center bottom",
        transition:
          "transform 220ms cubic-bezier(0.22, 1, 0.36, 1), color 160ms var(--ease-out)",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.transform = "scale(1.45)";
        if (!accent) e.currentTarget.style.color = "var(--fg)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "scale(1)";
        if (!accent) e.currentTarget.style.color = "var(--fg-subtle)";
      }}
    >
      {icon}
    </button>
  );
}

// Shared svg frame for the action-bar glyphs — line icons at 24-grid, 14px.
function Glyph({
  children,
  size = 14,
  fill = false,
  sw = 1.7,
}: {
  children: React.ReactNode;
  size?: number;
  fill?: boolean;
  sw?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const PencilGlyph = <Glyph><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></Glyph>;
const CheckGlyph = <Glyph sw={2}><path d="m20 6-11 11-5-5" /></Glyph>;
const ArchiveGlyph = <Glyph><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" /><path d="M10 12h4" /></Glyph>;
const ExportGlyph = <Glyph><path d="M12 15V3" /><path d="m8 7 4-4 4 4" /><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></Glyph>;
const ForkGlyph = <Glyph><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M6 8.5v1a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-1" /><path d="M12 11.5v4" /></Glyph>;
const WorktreeGlyph = <Glyph><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M6 8.5v7" /><circle cx="18" cy="9" r="2.5" /><path d="M18 11.5a6 6 0 0 1-6 6" /></Glyph>;
const MergeGlyph = <Glyph><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="9" r="2.5" /><path d="M6 8.5v7" /><path d="M6 12a6 6 0 0 0 6-6h3.5" /></Glyph>;
const CompareGlyph = <Glyph><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><path d="m16 9-3-3 3-3" /><path d="M11 18H8a2 2 0 0 1-2-2V9" /><path d="m8 15 3 3-3 3" /></Glyph>;
const DiffGlyph = <Glyph><path d="M12 4v8" /><path d="M8 8h8" /><path d="M6 20h12" /></Glyph>;
const MemoryGlyph = <Glyph><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z" /></Glyph>;
const CopyGlyph = <Glyph><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Glyph>;
const FolderGlyph = <Glyph><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" /></Glyph>;
// A document bearing a check — the run's proof, not just its words.
const EvidenceGlyph = <Glyph><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="m9 15 2 2 4-4" /></Glyph>;

function RefreshIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

// Source filter mark. Delegates (claude-code/codex/opencode/omp) are real
// ProviderIds with logos; the native "klide" source is NOT a ProviderId, so it
// would hit ProviderLogo's fallback circle — render the Klide mark instead.
function SourceMark({ source, size = 16 }: { source: RunSource; size?: number }) {
  if (source === "klide") {
    return (
      <img
        src="/klide-logo.png"
        alt=""
        aria-hidden
        width={size}
        height={size}
        className="provider-logo-img"
        style={{ width: size, height: size, objectFit: "contain", flexShrink: 0 }}
      />
    );
  }
  return <ProviderLogo id={source as ProviderId} size={size} />;
}

// A project option: its name + whether it actually has runs (vs. a known
// workspace you've opened but not run anything in yet).
type ProjectOpt = { name: string; hasRuns: boolean };

// Recent workspaces App.tsx records in localStorage, as project names — lets
// you pre-scope a project before it has any runs.
function recentProjectNames(): string[] {
  try {
    const raw = localStorage.getItem("klide.recentFolders");
    const paths: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(paths)) return [];
    return paths
      .filter((p): p is string => typeof p === "string")
      .map((p) => projectName(p))
      .filter((n): n is string => !!n);
  } catch {
    return [];
  }
}

// Title-level project scope switcher — a quiet breadcrumb pill that opens a
// menu of projects (plus "All projects"). Replaces the old inline dropdown.
function ProjectSwitcher({
  value,
  options,
  onChange,
}: {
  value: ProjectFilter;
  options: ProjectOpt[];
  onChange: (v: ProjectFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const label = value === "all" ? "All projects" : value;
  const pick = (v: ProjectFilter) => { onChange(v); setOpen(false); };
  return (
    <div ref={ref} style={{ position: "relative", minWidth: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch project"
        style={{
          display: "inline-flex", alignItems: "center", gap: 5, maxWidth: 130,
          height: 22, padding: "0 7px", borderRadius: 6, border: "none",
          background: open ? "var(--bg-hover)" : "transparent",
          color: "var(--fg)", fontFamily: "inherit", fontSize: 12, cursor: "pointer",
          transition: "background var(--motion-fast) var(--ease-out)",
        }}
        onMouseEnter={(e) => { if (!open) e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = "transparent"; }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ opacity: 0.55, flexShrink: 0 }}><path d="M3 4.5l3 3 3-3" /></svg>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute", top: "calc(100% + 5px)", right: 0, zIndex: 50,
            minWidth: 180, maxHeight: "min(50vh, 320px)", overflowY: "auto",
            background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
            borderRadius: 8, boxShadow: "var(--panel-shadow)", padding: 4,
          }}
        >
          <ProjectOption label="All projects" active={value === "all"} onClick={() => pick("all")} />
          {options.length > 0 && <div aria-hidden style={{ height: 1, background: "var(--border)", margin: "4px 6px" }} />}
          {options.map((o) => (
            <ProjectOption key={o.name} label={o.name} active={value === o.name} muted={!o.hasRuns} onClick={() => pick(o.name)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectOption({ label, active, muted, onClick }: { label: string; active: boolean; muted?: boolean; onClick: () => void }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      title={muted ? "No runs yet" : undefined}
      style={{
        width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "7px 9px",
        borderRadius: 6, border: "none", background: active ? "var(--bg-hover)" : "transparent",
        color: "var(--fg-strong)", fontFamily: "inherit", fontSize: 12.5, textAlign: "left", cursor: "pointer",
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: muted ? 0.5 : 1 }}>{label}</span>
      {/* Workspaces with no runs yet read quieter, with a hint, so an empty
          board after selecting one isn't a surprise. */}
      {muted && <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--fg-dim)", flexShrink: 0 }}>no runs</span>}
      {active && (
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M11.5 4l-5.5 6L2.5 7" /></svg>
      )}
    </button>
  );
}

const PAGE = 20;
const RUN_REFRESH_MS = 7_500;

// One live delegate PTY, mirror of Rust's `LiveDelegateSession`.
type LiveDelegateSession = {
  sessionId: string;
  convoId: string;
  provider: string;
  cwd: string | null;
  task: string | null;
  model: string | null;
  startedMs: number;
  updatedMs: number;
  /** Hook-reported when the CLI has Klide's status hooks (working/blocked/
   *  waiting — see Rust delegate/status.rs); otherwise the PTY idle-timer
   *  heuristic (running/idle). */
  status: "running" | "idle" | "working" | "blocked" | "waiting";
  bufferedBytes: number;
};

// One persisted-but-ended delegate session, mirror of Rust's
// `RecentDelegateSession`. Its PTY died (CLI finished, or the app restarted)
// but its scrollback survives on disk — reopening repaints the terminal
// history, and resumes the CLI session when `resumeSessionId` is known.
type RecentDelegateSession = {
  sessionId: string;
  convoId: string;
  provider: string;
  cwd: string | null;
  task: string | null;
  model: string | null;
  resumeSessionId: string | null;
  startedMs: number;
  endedMs: number | null;
};

/** Only surface recently-ended sessions (the interrupted-by-restart case);
 *  older history stays reachable through the run board, not the strip. */
const RECENT_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_SESSION_MAX_ROWS = 4;

// Live-strip status rendering: the one status vocabulary (see runs.ts
// STATUS_LABEL) — Working / Waiting / Blocked (+ Idle for the timer
// heuristic). No chips, no dots — the word and its color carry the state;
// precise phrasing lives in the row tooltip.
const LIVE_STATUS_TEXT: Record<LiveDelegateSession["status"], string> = {
  running: "Working",
  working: "Working",
  idle: "Idle",
  blocked: "Blocked",
  waiting: "Waiting",
};
const LIVE_STATUS_COLOR: Record<LiveDelegateSession["status"], string> = {
  running: "var(--accent)",
  working: "var(--accent)",
  idle: "var(--fg-subtle)",
  blocked: "var(--warning)",
  waiting: "var(--success)",
};

// "Live now" strip — the delegate sessions still running *in this Klide
// process*, which we can reconnect to in-process and replay (Slice 1/2,
// inspired by Unpeel's reattachable session host). Distinct from the run board
// below, which lists on-disk runs (live or finished) that need a fresh
// `--resume` to rejoin. Polls every few seconds; renders nothing when idle so
// it never adds chrome to a quiet board.
function LiveSessionsStrip({
  sessions,
  recent,
  workspaceRoot,
  onReattach,
}: {
  sessions: LiveDelegateSession[];
  recent: RecentDelegateSession[];
  workspaceRoot: string | null;
  onReattach?: (opts: {
    provider: ProviderId;
    conversationId: string;
    workspaceRoot: string | null;
    resumeSessionId?: string | null;
  }) => void;
}) {
  // Idle sessions collapse into one quiet line: with the ptyd daemon,
  // sessions outlive the app, so a busy day leaves a tail of parked CLIs —
  // rows that say nothing new individually. Anything the user should act on
  // (working / blocked / waiting) keeps its own row; the idle tail is a
  // count you can expand, with a stop-all for cleaning up in one move.
  const [idleOpen, setIdleOpen] = useState(false);
  if (sessions.length === 0 && recent.length === 0) return null;
  const activeSessions = sessions.filter((s) => s.status !== "idle");
  const idleSessions = sessions.filter((s) => s.status === "idle");
  // Show ~5 flat rows, scroll past that. ~30px per row. The idle group
  // counts as one row collapsed, or toggle + rows expanded.
  const rowCount =
    activeSessions.length +
    (idleSessions.length === 1 ? 1 : 0) +
    (idleSessions.length >= 2 ? 1 + (idleOpen ? idleSessions.length : 0) : 0);
  const maxVisible = 5;
  const scrolls = rowCount > maxVisible;

  const renderSessionRow = (s: LiveDelegateSession) => {
    const providerId = s.provider as ProviderId;
    const title = s.task?.trim() || `${providerName(providerId)} session`;
    const canReattach = isDelegateProvider(providerId) && !!onReattach;
    const idle = s.status === "idle";
    const statusLabel = LIVE_STATUS_TEXT[s.status] ?? "Working";
    const statusColor = LIVE_STATUS_COLOR[s.status] ?? "var(--accent)";
    // Blocked is the one state worth a resting wash — the agent is
    // parked on the user. Everything else stays flat until hover.
    const restBg =
      s.status === "blocked"
        ? "color-mix(in srgb, var(--warning) 6%, transparent)"
        : "transparent";
    const statusText = idle ? `Idle ${relativeTime(s.updatedMs)}` : statusLabel;
    const reattach = () =>
      canReattach &&
      onReattach!({
        provider: providerId,
        conversationId: s.convoId,
        workspaceRoot: s.cwd ?? workspaceRoot,
      });
    return (
      <button
        key={s.sessionId}
        type="button"
        onClick={reattach}
        disabled={!canReattach}
        className={`klide-enter-rise live-row${canReattach ? " has-act" : ""}`}
        title={canReattach ? `Reattach · ${title} · ${statusText}` : `${title} · ${statusText}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          width: "100%",
          textAlign: "left",
          height: 30,
          padding: "0 8px",
          margin: "0 -8px",
          borderRadius: "var(--radius-sm)",
          border: "none",
          background: restBg,
          cursor: canReattach ? "pointer" : "default",
          font: "inherit",
          transition: "background var(--motion-fast) var(--ease-out)",
        }}
        onMouseEnter={(e) => {
          if (canReattach) e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = restBg;
        }}
      >
        <span style={{ flexShrink: 0, display: "grid", placeItems: "center", opacity: 0.9 }}>
          <ProviderLogo id={s.provider as ProviderId} size={13} />
        </span>
        <span
          style={{
            flex: 1, minWidth: 0, fontSize: 12.5, color: "var(--fg-strong)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}
        >
          {title}
        </span>
        <span
          style={{
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            maxWidth: 88,
            fontSize: 11,
            color: statusColor,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {statusLabel}
        </span>
        <span
          style={{
            flexShrink: 0,
            minWidth: 64,
            display: "inline-flex",
            justifyContent: "flex-end",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
          }}
        >
          <span className="live-rest" style={{ color: "var(--fg-dim)" }}>
            {relativeTime(s.startedMs)}
          </span>
          {canReattach && <span className="live-act">Reattach</span>}
        </span>
      </button>
    );
  };

  return (
    <div className="klide-enter-rise" style={{ padding: "14px 8px 12px 16px", borderBottom: "1px solid var(--border)" }}>
      {sessions.length > 0 && (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          marginBottom: 6,
          paddingRight: 8,
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--fg-subtle)",
        }}
      >
        <span>Live</span>
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500, letterSpacing: 0, color: "var(--fg-dim)" }}>
          {sessions.length}
        </span>
      </div>
      )}
      <div
        className={scrolls ? "live-scroll" : undefined}
        style={{
          maxHeight: scrolls ? maxVisible * 30 : undefined,
          paddingRight: scrolls ? 4 : 8,
        }}
      >
        {activeSessions.map(renderSessionRow)}
        {idleSessions.length === 1 && idleSessions.map(renderSessionRow)}
        {idleSessions.length >= 2 && (
          <button
            type="button"
            className="live-row has-act"
            onClick={() => setIdleOpen((v) => !v)}
            title={idleOpen ? "Hide idle sessions" : "Show idle sessions"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              width: "100%",
              textAlign: "left",
              height: 30,
              padding: "0 8px",
              margin: "0 -8px",
              borderRadius: "var(--radius-sm)",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              font: "inherit",
              transition: "background var(--motion-fast) var(--ease-out)",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            {/* Same leading slot as the provider logo above, so the “+”
                lines up with the icon column. Rotates to “×” when open —
                the glyph carries the state, no Show/Hide text needed. */}
            <span
              aria-hidden
              style={{
                flexShrink: 0,
                width: 13,
                display: "grid",
                placeItems: "center",
                fontSize: 13,
                lineHeight: 1,
                color: "var(--fg-dim)",
                transform: idleOpen ? "rotate(45deg)" : "none",
                transition: "transform var(--motion-fast) var(--ease-out)",
              }}
            >
              +
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {idleSessions.length} idle session{idleSessions.length === 1 ? "" : "s"}
            </span>
            <span style={{ flexShrink: 0, display: "inline-flex", fontSize: 11, fontFamily: "var(--font-mono)" }}>
              <span
                className="live-act"
                title="Stop every idle session — history stays in Recent, resumable"
                onClick={(e) => {
                  e.stopPropagation();
                  for (const s of idleSessions) {
                    void invoke("delegate_pty_stop", { sessionId: s.sessionId });
                  }
                }}
              >
                Stop all
              </span>
            </span>
          </button>
        )}
        {idleOpen && idleSessions.length >= 2 && idleSessions.map(renderSessionRow)}
      </div>
      {recent.length > 0 && (
        <>
          <div
            style={{
              marginTop: sessions.length > 0 ? 10 : 0,
              marginBottom: 6,
              paddingRight: 8,
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--fg-dim)",
            }}
          >
            Recent
          </div>
          {recent.map((s) => {
            const providerId = s.provider as ProviderId;
            const title = s.task?.trim() || `${providerName(providerId)} session`;
            const canReopen = isDelegateProvider(providerId) && !!onReattach;
            const reopen = () =>
              canReopen &&
              onReattach!({
                provider: providerId,
                conversationId: s.convoId,
                workspaceRoot: s.cwd ?? workspaceRoot,
                resumeSessionId: s.resumeSessionId,
              });
            return (
              <button
                key={s.sessionId}
                type="button"
                onClick={reopen}
                disabled={!canReopen}
                className={`live-row${canReopen ? " has-act" : ""}`}
                title={
                  canReopen
                    ? `Reopen · ${title}${s.resumeSessionId ? " · resumes the CLI session" : " · history only"}`
                    : title
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  width: "100%",
                  textAlign: "left",
                  height: 30,
                  padding: "0 8px",
                  margin: "0 -8px",
                  borderRadius: "var(--radius-sm)",
                  border: "none",
                  background: "transparent",
                  cursor: canReopen ? "pointer" : "default",
                  font: "inherit",
                  transition: "background var(--motion-fast) var(--ease-out)",
                }}
                onMouseEnter={(e) => {
                  if (canReopen) e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <span style={{ flexShrink: 0, display: "grid", placeItems: "center", opacity: 0.55 }}>
                  <ProviderLogo id={providerId} size={13} />
                </span>
                <span
                  style={{
                    flex: 1, minWidth: 0, fontSize: 12.5, color: "var(--fg)",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}
                >
                  {title}
                </span>
                <span
                  style={{
                    flexShrink: 0,
                    minWidth: 96,
                    display: "inline-flex",
                    justifyContent: "flex-end",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <span className="live-rest" style={{ color: "var(--fg-dim)" }}>
                    ended {relativeTime(s.endedMs ?? s.startedMs)}
                  </span>
                  {canReopen && <span className="live-act">Reopen</span>}
                </span>
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}

export function MissionControl({
  workspaceRoot,
  theme,
  onResumeKlideRun,
  onOpenInAiPanel,
  onReattachLiveSession,
  onWatchRace,
  onSaveMemory,
  onForkRun,
  onForkRunInWorktree,
  onMergeWorktreeRun,
  summarizingFromRunId,
}: {
  workspaceRoot: string | null;
  theme: ThemeId;
  onResumeKlideRun?: (runId: string) => void;
  /** Land the user in a new AI panel pinned to the chosen delegate provider.
   *  Used by every "Resume in {CLI}" / "Open in {CLI}" action — the AI panel
   *  is the natural home for an agent TUI. */
  onOpenInAiPanel?: (opts: {
    provider: TaskSource;
    workspaceRoot: string | null;
    resumeSessionId?: string;
    initialTask?: string;
  }) => void;
  /** "Reattach" — reconnect to a delegate PTY still running in this Klide
   *  process. Opens an AI panel bound to the session's conversation id so its
   *  terminal lands on the same PTY and replays its scrollback. */
  onReattachLiveSession?: (opts: {
    provider: ProviderId;
    conversationId: string;
    workspaceRoot: string | null;
    /** Set when reopening a persisted (ended) session whose CLI session id is
     *  known — the fresh spawn `--resume`s it under the same terminal history. */
    resumeSessionId?: string | null;
  }) => void;
  /** Race "watch live" — open every racer in its own AI panel right after
   *  dispatch (side-by-side floating panels, or tabs in Focus mode). */
  onWatchRace?: (group: RaceGroup) => void;
  /** "Save Memory" — fetch the run's transcript, ask the model for a
   *  structured note, and open the memory modal. Klide-only in this
   *  slice; CLI rows get a "not supported" toast. */
  onSaveMemory?: (run: { id: string; source: string; provider?: string | null; model: string | null; cwd: string | null }) => void;
  onForkRun?: (run: Run, messages?: RunMessage[]) => void;
  onForkRunInWorktree?: (run: Run, messages?: RunMessage[]) => void;
  onMergeWorktreeRun?: (run: Run) => void;
  /** runId currently being summarised by `onSaveMemory`. Used to show a
   *  subtle spinner on the row so the user knows the model call is in
   *  flight. */
  summarizingFromRunId?: string | null;
}) {
  const tasks = useSyncExternalStore(subscribeTasks, getTaskSessions);
  const convos = useSyncExternalStore(subscribeKlideConvos, getKlideConvos);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const {
    artifactTabs,
    activeArtifactKey,
    artifactOpen,
    setActiveArtifactKey,
    setArtifactDirty,
    openArtifact,
    closeArtifact,
    closeArtifactTab,
  } = useArtifactInspector();
  const [sourceFilter, setSourceFilter] = useState<RunSourceFilter>("all");
  // Default the project filter to the project Klide is currently rooted in, so a
  // user juggling several projects only sees the active one's runs on open. They
  // can switch to "All projects" (or any other) from the dropdown.
  // Board scopes to the current project by default; the title-level
  // ProjectSwitcher lets you change it (or see "All projects").
  const currentProject = projectName(workspaceRoot);
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>(() => currentProject ?? "all");
  const runWorkspaceScope =
    workspaceRoot && currentProject && projectFilter === currentProject ? workspaceRoot : null;
  const [sessionQuery, setSessionQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  // Delegate PTYs still live in this process — drives the "Live now" strip and
  // dedupes the board (a live session shown in the strip is hidden from the
  // sections below, so it doesn't appear twice). Polled here, not in the strip,
  // so both consumers share one source.
  const [liveSessions, setLiveSessions] = useState<LiveDelegateSession[]>([]);
  // Persisted sessions whose PTY is gone (CLI finished / app restarted) but
  // whose scrollback survives on disk — drives the strip's "Recent" rows.
  const [recentSessions, setRecentSessions] = useState<RecentDelegateSession[]>([]);
  useEffect(() => {
    void refreshCustomCli().catch(() => {});
  }, []);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const live = await invoke<LiveDelegateSession[]>("delegate_pty_live_sessions");
        if (!cancelled) setLiveSessions(live);
      } catch {
        if (!cancelled) setLiveSessions([]); // outside Tauri / command missing
      }
      try {
        const recent = await invoke<RecentDelegateSession[]>("delegate_pty_recent_sessions");
        if (!cancelled) setRecentSessions(recent);
      } catch {
        if (!cancelled) setRecentSessions([]);
      }
    };
    void poll();
    const t = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);
  const liveConvoIds = useMemo(
    () => new Set(liveSessions.map((s) => s.convoId)),
    [liveSessions]
  );
  // Keep the Recent rows quiet: only sessions ended in the last day, a few at
  // most, and never one whose conversation is live again.
  const recentStripSessions = useMemo(() => {
    const cutoff = Date.now() - RECENT_SESSION_WINDOW_MS;
    return recentSessions
      .filter((s) => (s.endedMs ?? s.startedMs) >= cutoff)
      .filter((s) => !liveConvoIds.has(s.convoId))
      .slice(0, RECENT_SESSION_MAX_ROWS);
  }, [recentSessions, liveConvoIds]);
  const [ledgerMetadata, setLedgerMetadata] = useState<RunLedgerMetadataStore>(() => readRunLedgerMetadata());
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [expandedSubagentParents, setExpandedSubagentParents] = useState<Set<string>>(new Set());
  const [dismissedBoardRuns, setDismissedBoardRuns] = useState<Set<string>>(() => readDismissedBoardRuns());
  // Compact task state for the currently selected Klide run. Used as the
  // prompt when handing the run off to a CLI via "Open in {CLI}".
  const [handoffPrompt, setHandoffPrompt] = useState<string | null>(null);
  // Run ids that already have a durable Project Memory note (matched by the
  // note's `runId` frontmatter). Drives the "memory saved" evidence signal so
  // the board shows which completed runs are remembered vs still un-captured.
  // Re-runs when a Save-memory action settles (`summarizingFromRunId` clears).
  const [memoryRunIds, setMemoryRunIds] = useState<Set<string>>(new Set());
  // Bumped whenever a memory note is written anywhere (accept a draft, manual
  // Summarize, MC "Save memory"), so the "memory saved" chips reload promptly
  // instead of only on reopen.
  const [memoryVersion, setMemoryVersion] = useState(0);
  useEffect(
    () => subscribeMemoryChanged(() => setMemoryVersion((v) => v + 1)),
    []
  );
  useEffect(() => {
    if (!workspaceRoot) {
      setMemoryRunIds(new Set());
      return;
    }
    let cancelled = false;
    listMemory(workspaceRoot)
      .then((entries) => {
        if (cancelled) return;
        setMemoryRunIds(
          new Set(entries.map((e) => e.runId).filter((id): id is string => !!id))
        );
      })
      .catch(() => {
        /* no .klide/memory/ yet, or outside Tauri — leave the set empty */
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot, summarizingFromRunId, memoryVersion]);

  // Initial load (and refresh) — just the most-recent page.
  async function load() {
    setLoading(true);
    try {
      const { runs: rows, hasMore } = await fetchAgentRuns(PAGE, 0, runWorkspaceScope);
      setRuns(rows);
      setHasMore(hasMore);
      setNextOffset(PAGE);
      setError(false);
    } catch {
      // Outside Tauri (or the command failed) — show the illustrative seed.
      setRuns(seedRuns());
      setHasMore(false);
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  // Page in the next batch of older runs, appended (deduped by id).
  async function loadMore() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const { runs: rows, hasMore } = await fetchAgentRuns(PAGE, nextOffset, runWorkspaceScope);
      setRuns((prev) => mergeRunPages(prev, rows));
      setHasMore(hasMore);
      setNextOffset((o) => o + PAGE);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    void load();
  }, [runWorkspaceScope]);

  // External delegate logs (Claude Code, Codex Desktop, OpenCode) are not
  // live PTYs unless Klide spawned them, so keep the newest durable page warm
  // while Mission Control is open. This is what makes a Codex/Claude session
  // started elsewhere appear on the board while it is still working.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const refreshLatest = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const { runs: rows, hasMore } = await fetchAgentRuns(PAGE, 0, runWorkspaceScope);
        if (cancelled) return;
        setRuns((prev) => mergeRunPages(prev, rows));
        setHasMore(hasMore);
        setError(false);
      } catch {
        // Keep the last good board; the initial load path owns the fallback UI.
      } finally {
        inFlight = false;
      }
    };
    const t = setInterval(refreshLatest, RUN_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [runWorkspaceScope]);

  // The run ledger is the canonical Mission Control projection: todos,
  // live/durable Klide conversations, and on-disk transcripts all become
  // one normalized row shape with capability flags attached.
  const allRuns = useMemo(
    () =>
      buildRunLedger({
        tasks,
        convos,
        runs,
        workspaceRoot,
        dismissedBoardRuns,
        dismissKey: boardDismissKey,
        metadata: ledgerMetadata,
        showArchived,
      }),
    [tasks, convos, runs, workspaceRoot, dismissedBoardRuns, ledgerMetadata, showArchived]
  );

  // Parent links come exclusively from the Rust spawn mapping
  // (`by_delegate`/`by_external` in list_agent_runs), which records a real
  // parentId only when Klide actually spawned the delegate. We deliberately
  // do NOT infer parents from project + time proximity: a user's own Claude
  // Code / Codex sessions share the workspace and overlap in time with Klide
  // conversations, and a fuzzy heuristic wrongly adopted them as children of
  // unrelated Klide runs. Separate conversations stay separate.
  const linkedRuns = allRuns;

  // Which source chips to show — only sources actually present.
  const presentSources = useMemo(() => presentRunSources(allRuns), [allRuns]);

  // Projects to offer in the switcher: every project with runs, MERGED with
  // recent workspaces (so you can pre-scope a project before it has any runs)
  // and the current one. Run-backed projects are marked hasRuns; the rest read
  // quieter in the menu.
  const projectOptions = useMemo<ProjectOpt[]>(() => {
    const withRuns = new Set(presentProjects(allRuns));
    const all = new Set<string>(withRuns);
    for (const name of recentProjectNames()) all.add(name);
    if (currentProject) all.add(currentProject);
    return [...all]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, hasRuns: withRuns.has(name) }));
  }, [allRuns, currentProject]);

  const filtered = useMemo(() => {
    return linkedRuns.filter(
      (r) =>
        // A live, in-process session is shown in the "Live now" strip — don't
        // also list it in the board sections below.
        !liveConvoIds.has(r.id) &&
        sourceMatchesFilter(r, sourceFilter) &&
        projectMatchesFilter(r, projectFilter, workspaceRoot) &&
        runMatchesLedgerQuery(r, sessionQuery)
    );
  }, [linkedRuns, liveConvoIds, sourceFilter, projectFilter, workspaceRoot, sessionQuery]);

  // Race membership for the board: runId → its group + "A"/"B" label. Drives
  // the row mark + spine and keeps siblings adjacent, so a race reads as one
  // comparison rather than two unrelated runs.
  const [raceTick, setRaceTick] = useState(0);
  useEffect(() => subscribeRaces(() => setRaceTick((t) => t + 1)), []);
  const raceInfoByRunId = useMemo(() => {
    const map = new Map<string, RaceRowInfo>();
    for (const g of listRaces()) {
      g.members.forEach((m, i) => {
        map.set(m.runId, {
          groupId: g.id,
          memberIndex: i,
          label: String.fromCharCode(65 + i),
          size: g.members.length,
          prompt: g.prompt,
        });
      });
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raceTick]);

  const grouped = useMemo(() => {
    const by: Record<RunBoardSection, RunLedgerEntry[]> = {
      running: [],
      blocked: [],
      ready_for_review: [],
      done: [],
    };
    for (const r of filtered) by[boardSectionForRun(r)].push(r);
    // Order each section by recency with a stable id tiebreak. Without this the
    // row order followed the [tasks, convos, runs] concatenation, so paging in
    // older runs — or swapping a live convo for its on-disk twin — reshuffled
    // rows already on screen. Newest on top; ties break deterministically by id.
    for (const section of Object.keys(by) as RunBoardSection[]) {
      by[section].sort(
        (a, b) => b.updatedMs - a.updatedMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
      );
      if (raceInfoByRunId.size > 0) {
        by[section] = clusterRaceRows(by[section], raceInfoByRunId);
      }
    }
    return by;
  }, [filtered, raceInfoByRunId]);

  // Keep a valid selection as the filter/data changes — unless pinned.
  useEffect(() => {
    if (pinnedId && allRuns.some((r) => r.id === pinnedId)) return;
    if (filtered.length === 0) {
      if (selectedId !== null) setSelectedId(null);
    } else if (!filtered.some((r) => r.id === selectedId)) {
      const nextSelectedId = filtered[0].id;
      if (selectedId !== nextSelectedId) setSelectedId(nextSelectedId);
    }
  }, [filtered, selectedId, pinnedId, allRuns]);

  const inspection = useMemo(
    () =>
      resolveRunInspection({
        selectedId,
        tasks,
        conversations: convos,
        entries: allRuns,
        workspaceRoot,
      }),
    [selectedId, tasks, convos, allRuns, workspaceRoot],
  );
  const selectedTask = inspection?.kind === "task" ? inspection.task : null;
  const selectedRun = inspection?.kind === "run" ? inspection.run : null;
  const selectedConvo =
    inspection?.kind === "run" ? inspection.liveConversation : null;
  const selectedForkParent =
    inspection?.kind === "run" ? inspection.lineage.parent : null;
  const selectedForkChildren =
    inspection?.kind === "run" ? inspection.lineage.children : [];

  // Race grouping for the detail pane: when the selected run was dispatched
  // as part of a race, surface its siblings so their evidence can be compared.
  const selectedRace = useMemo(
    () => (selectedRun ? raceForRun(selectedRun.id) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedRun?.id, raceTick],
  );
  const selectedRaceEntries = useMemo(
    () =>
      selectedRace
        ? selectedRace.members.map((member) => ({
            member,
            entry: allRuns.find((r) => r.id === member.runId) ?? null,
          }))
        : [],
    [selectedRace, allRuns],
  );

  // When a Klide run (kind=run) is selected, fetch its transcript once and
  // build the prompt we'll hand off to a fresh delegate session if the user
  // opens this run in another CLI.
  useEffect(() => {
    if (!selectedRun || selectedRun.source !== "klide" || selectedRun.kind !== "run") {
      setHandoffPrompt((current) => (current === null ? current : null));
      return;
    }
    let cancelled = false;
    setHandoffPrompt((current) => (current === null ? current : null));
    fetchRunMessages(selectedRun)
      .then((msgs) => {
        if (cancelled) return;
        const handoff = buildRunHandoff({
          title: selectedRun.title,
          sourceLabel: runAgentLabel(selectedRun),
          cwd: selectedRun.cwd,
          model: selectedRun.model,
          messages: msgs.map((m) => ({ role: m.role, text: m.text })),
        });
        setHandoffPrompt(handoff.delegatePrompt);
      })
      .catch(() => {
        if (!cancelled) setHandoffPrompt(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRun?.id, selectedRun?.source, selectedRun?.kind]);

  async function reviewRun(run: RunLedgerEntry) {
    if (run.source === "klide") {
      try {
        const entries = await listCheckpoints(run.id);
        if (entries.length === 0) {
          notify("This Run has no reviewable file checkpoints yet.");
          return;
        }
        openArtifact({ kind: "checkpoint-set", runId: run.id, title: run.title, entries });
      } catch (err) {
        notify(`Unable to open changes: ${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
      }
      return;
    }

    const root = run.cwd ?? workspaceRoot;
    if (!root) {
      notify("This Run has no workspace checkout to review.", { tone: "error" });
      return;
    }
    openArtifact({
      kind: "run-review",
      runId: run.id,
      title: run.title,
      workspaceRoot: root,
      branch: run.branch,
    });
  }

  function selectRun(run: Run) {
    if (run.id !== selectedId && artifactTabs.length > 0 && !closeArtifact()) return;
    setSelectedId(run.id);
    if (run.source === "claude-code" || run.source === "codex" || run.source === "opencode") {
      setPinnedId(run.id);
    } else {
      setPinnedId(null);
    }
  }

  function selectLineageRun(run: RunLedgerEntry) {
    if (run.id !== selectedId && artifactTabs.length > 0 && !closeArtifact()) return;
    setSourceFilter("all");
    setSessionQuery("");
    setSelectedId(run.id);
    setPinnedId(run.id);
  }

  function toggleSubagentStack(parentId: string) {
    setExpandedSubagentParents((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  }

  function dismissBoardRun(run: Run) {
    if (run.kind === "task") {
      removeTask(run.id);
      return;
    }
    setDismissedBoardRuns((prev) => {
      const next = new Set(prev);
      next.add(boardDismissKey(run));
      writeDismissedBoardRuns(next);
      return next;
    });
  }

  function patchLedgerMetadata(
    run: RunLedgerEntry,
    patch: (current: NonNullable<RunLedgerMetadataStore[string]>) => NonNullable<RunLedgerMetadataStore[string]>
  ) {
    setLedgerMetadata((prev) => {
      const key = runLedgerKey(run);
      const next = {
        ...prev,
        [key]: patch(prev[key] ?? {}),
      };
      writeRunLedgerMetadata(next);
      return next;
    });
  }

  function renameLedgerRun(run: RunLedgerEntry, title: string) {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    if (run.origin === "task") {
      renameTask(run.id, nextTitle);
    } else if (run.origin === "klide-convo" || run.source === "klide") {
      renameKlideConvo(run.id, nextTitle);
    }
    patchLedgerMetadata(run, (current) => ({
      ...current,
      title: nextTitle,
      updatedMs: Date.now(),
    }));
  }

  function archiveLedgerRun(run: RunLedgerEntry, archived: boolean) {
    patchLedgerMetadata(run, (current) => ({
      ...current,
      archived,
      updatedMs: Date.now(),
    }));
    if (archived && selectedId === run.id && !showArchived) {
      setPinnedId(null);
      setSelectedId(null);
    }
  }


  return (
    <div
      className="mission-control-workbench"
      data-inspector-open={artifactOpen ? "true" : undefined}
      style={{ flex: 1, display: "flex", minWidth: 0, background: "var(--bg)" }}
    >
      {/* Board motion — same de-blur/spring-settle family as the rest of the app
          (klide-orch-in). Rows fade + rise on first mount with a capped stagger;
          a section's explanation reveals on hover instead of a native tooltip;
          cards firm their hairline to charcoal on hover. All disabled under
          prefers-reduced-motion. */}
      <style>{`
        @keyframes mc-row-in {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .mc-row { animation: mc-row-in 320ms var(--ease-out) backwards; }
        .mc-card { transition: border-color var(--motion-fast) var(--ease-out); }
        .mc-card:hover { border-color: var(--border-strong); }
        .mc-sec-head .mc-hint {
          opacity: 0;
          transform: translateX(-3px);
          transition: opacity var(--motion-med) var(--ease-out), transform var(--motion-med) var(--ease-out);
          pointer-events: none;
        }
        .mc-sec-head:hover .mc-hint { opacity: 0.85; transform: translateX(0); }
        /* Header: status chips, source-logo toggles, icon buttons. */
        .mc-chip { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 9px 0 7px; border-radius: 999px; background: var(--bg-hover); font-family: var(--font-mono); font-size: 11px; color: var(--fg-strong); font-variant-numeric: tabular-nums; }
        .mc-chip i { width: 6px; height: 6px; border-radius: 999px; display: inline-block; flex-shrink: 0; }
        .mc-iconbtn { width: 28px; height: 28px; display: grid; place-items: center; flex-shrink: 0; border: none; background: transparent; color: var(--fg-subtle); border-radius: 6px; cursor: pointer; transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
        .mc-iconbtn:hover { background: var(--bg-hover); color: var(--fg-strong); }
        /* source filter — agent logos as toggles; "All" is the resting state.
           Every present source shows; the strip scrolls horizontally rather
           than squeezing search or wrapping. */
        .mc-srcscroll { display: flex; align-items: center; gap: 1px; min-width: 0; max-width: 58%; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; -ms-overflow-style: none; scroll-snap-type: x proximity; }
        .mc-srcscroll::-webkit-scrollbar { height: 0; width: 0; display: none; }
        .mc-src { height: 28px; min-width: 28px; flex-shrink: 0; padding: 0 7px; border: none; background: transparent; border-radius: 7px; cursor: pointer; display: grid; place-items: center; font-family: var(--font-mono); font-size: 11px; color: var(--fg-subtle); opacity: 0.42; transition: opacity var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
        .mc-src:hover { opacity: 1; }
        .mc-src.active { opacity: 1; background: var(--bg-hover); color: var(--fg-strong); }
        .mc-srcdiv { width: 1px; height: 16px; background: var(--border); margin: 0 4px; flex-shrink: 0; }
        /* Live-strip hover swap — the row rests as data (relative time) and
           offers its action (Reattach) in the same footprint under the
           pointer. Rows without an action keep the timestamp. */
        .live-act { display: none; color: var(--accent); font-weight: 500; }
        .live-row.has-act:hover .live-act { display: inline; }
        .live-row.has-act:hover .live-rest { display: none; }
        @media (prefers-reduced-motion: reduce) {
          .mc-row { animation: none; }
          .mc-sec-head .mc-hint { transition: none; }
        }
      `}</style>
      {/* Left: the board */}
      <div
        className="mission-control-board"
        style={{
          width: artifactOpen ? 320 : 340,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <header style={{ padding: "16px 16px 12px", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Row 1 — title · status chips · refresh. No back chevron: Esc
              returns to the editor and the activity bar stays reachable. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h1 style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-strong)", margin: 0, flexShrink: 0 }}>
              Mission Control
            </h1>
            {loading && (
              <span style={{ fontSize: 11, color: "var(--fg-subtle)", fontFamily: "var(--font-mono)" }}>loading…</span>
            )}
            {/* Project switcher + refresh ride together on the right. */}
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              {projectOptions.length > 0 && (
                <ProjectSwitcher value={projectFilter} options={projectOptions} onChange={setProjectFilter} />
              )}
              <Tooltip label="Refresh" description="Re-reads session logs and Klide conversations">
                <button onClick={() => void load()} aria-label="Refresh runs" className="mc-iconbtn">
                  <RefreshIcon />
                </button>
              </Tooltip>
            </div>
          </div>

          {/* Row 2 — source filter (agent logos) · search · archived.
              Project switching lives in the native macOS Projects menu;
              the board stays scoped to the current project by default. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div role="group" aria-label="Filter by agent" className="mc-srcscroll">
              <button
                type="button"
                className={`mc-src${sourceFilter === "all" ? " active" : ""}`}
                aria-pressed={sourceFilter === "all"}
                onClick={() => setSourceFilter("all")}
                title="All runs"
              >
                All
              </button>
              {presentSources.length > 0 && <span className="mc-srcdiv" aria-hidden />}
              {presentSources.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`mc-src${sourceFilter === s ? " active" : ""}`}
                  aria-pressed={sourceFilter === s}
                  aria-label={SOURCE_LABEL[s]}
                  title={SOURCE_LABEL[s]}
                  onClick={() => setSourceFilter(sourceFilter === s ? "all" : s)}
                >
                  <SourceMark source={s} size={16} />
                </button>
              ))}
            </div>
            <div style={{ position: "relative", flex: "1 1 auto", minWidth: 0 }}>
              <span aria-hidden style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", display: "grid", placeItems: "center", color: "var(--fg-subtle)", pointerEvents: "none" }}>
                <SearchIcon />
              </span>
              <input
                value={sessionQuery}
                onChange={(e) => setSessionQuery(e.target.value)}
                aria-label="Search sessions"
                placeholder="Search"
                style={{ width: "100%", height: 28, padding: "3px 8px 3px 28px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--fg-strong)", fontSize: 11, fontFamily: "inherit", outline: "none", transition: "border-color var(--motion-fast) var(--ease-out)" }}
                onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
                onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
              />
            </div>
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              aria-pressed={showArchived}
              title={showArchived ? "Hide archived sessions" : "Show archived sessions"}
              className="mc-iconbtn"
              style={showArchived ? { color: "var(--accent)", background: "var(--accent-soft)" } : undefined}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="4" rx="1" />
                <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
              </svg>
            </button>
          </div>
        </header>

        <LiveSessionsStrip
          sessions={liveSessions}
          recent={recentStripSessions}
          workspaceRoot={workspaceRoot}
          onReattach={onReattachLiveSession}
        />

        <div style={{ overflowY: "auto", padding: "8px 8px 16px", minHeight: 0, flex: 1 }}>
          <TaskComposer
            workspaceRoot={workspaceRoot}
            onAdded={(id) => setSelectedId(id)}
          />
          <RaceComposer
            workspaceRoot={workspaceRoot}
            onStarted={(id) => {
              setSelectedId(id);
              void load();
            }}
            onWatch={onWatchRace}
          />
          {!loading && filtered.length === 0 && (
            sessionQuery.trim() !== "" || sourceFilter !== "all" ? (
              <div className="klide-enter-rise" style={{ padding: "24px 12px", fontSize: 12, color: "var(--fg-subtle)", lineHeight: 1.55 }}>
                <div style={{ color: "var(--fg-strong)", marginBottom: 5 }}>
                  No matching runs.
                </div>
                Mission Control reads local session logs and Klide conversations.
                Adjust the search or source filter, or start a new agent run.
              </div>
            ) : (
              /* A genuinely empty board teaches the two ways runs appear,
                 then hands the keyboard back — quiet furniture, not a card. */
              <div className="klide-enter-rise" style={{ padding: "24px 12px", fontSize: 12, color: "var(--fg-subtle)", lineHeight: 1.55 }}>
                <div style={{ color: "var(--fg-strong)", marginBottom: 5 }}>
                  No runs yet.
                </div>
                Add a task above to queue work for an agent, or start a
                conversation in the AI panel — every run lands on this board.
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    marginTop: 16,
                    color: "var(--fg-dim)",
                    fontSize: 11.5,
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Kbd keys={["Esc"]} /> Back to the editor
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Kbd keys={keysFor("cheatsheet")} /> Shortcuts
                  </span>
                </div>
              </div>
            )
          )}
          {(() => {
            // Build parent → children map from ALL linked runs (not filtered).
            // This ensures children know their parent exists even when the parent
            // is hidden by the source filter (e.g. showing only "subagent").
            const childrenByParent = new Map<string, RunLedgerEntry[]>();
            const visibleParentIds = new Set(filtered.map((r) => r.id));
            for (const r of linkedRuns) {
              if (r.parentId) {
                const kids = childrenByParent.get(r.parentId) ?? [];
                kids.push(r);
                childrenByParent.set(r.parentId, kids);
              }
            }
            const hasChildren = (id: string) => (childrenByParent.get(id)?.length ?? 0) > 0;
            return BOARD_SECTION_ORDER.map((section) => {
              const list = grouped[section];
              if (list.length === 0) return null;
              // Hide children whose parent is in the visible list (they render nested).
              // Keep children whose parent is filtered out as flat items so
              // they don't vanish in subagent-only view.
              const visible = list.filter((r) => !r.parentId || !visibleParentIds.has(r.parentId));
              if (visible.length === 0) return null;
              return (
                <div key={section} style={{ marginBottom: 14 }}>
                  <div
                    className="mc-sec-head"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 10px",
                      fontSize: 10,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "var(--fg-subtle)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {BOARD_SECTION_LABEL[section]}
                    <span style={{ opacity: 0.7 }}>{visible.length}</span>
                    {/* The section's meaning, revealed softly on hover — no
                        abrupt native tooltip. */}
                    <span
                      className="mc-hint"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        textTransform: "none",
                        letterSpacing: "0.01em",
                        fontFamily: "var(--font-ui)",
                        fontSize: 10.5,
                        color: "var(--fg-dim)",
                      }}
                    >
                      {BOARD_SECTION_HINT[section]}
                    </span>
                  </div>
                  {visible.map((run, i) => {
                    const task = tasks.find((t) => t.id === run.id);
                    const sendable =
                      task && (task.status === "queued" || task.status === "error");
                    const resumable =
                      run.source === "klide" &&
                      run.kind === "run" &&
                      run.status !== "running" &&
                      onResumeKlideRun;
                    const cliResumable =
                      run.kind === "run" &&
                      (run.source === "claude-code" ||
                        run.source === "codex" ||
                        run.source === "opencode") &&
                      !isClaudeInternalSubagent(run) &&
                      run.status !== "running" &&
                      onOpenInAiPanel;
                    const children = (childrenByParent.get(run.id) ?? [])
                      .slice()
                      .sort((a, b) => a.createdMs - b.createdMs);
                    const expanded = children.length > 0 && expandedSubagentParents.has(run.id);
                    const parentSelected = run.id === selectedId;
                    const parentDismissible = section === "blocked" || runAttentionReason(run) !== null;
                    // Race siblings are adjacent (clusterRaceRows) — fuse their
                    // cards into one quiet container: a caption above the first,
                    // no gap between members, radii only on the group's ends.
                    const race = raceInfoByRunId.get(run.id) ?? null;
                    const prevRaceGroup =
                      i > 0 ? raceInfoByRunId.get(visible[i - 1].id)?.groupId : undefined;
                    const nextRaceGroup =
                      i < visible.length - 1
                        ? raceInfoByRunId.get(visible[i + 1].id)?.groupId
                        : undefined;
                    const raceFirst = !!race && race.groupId !== prevRaceGroup;
                    const raceLast = !!race && race.groupId !== nextRaceGroup;
                    return (
                      <div
                        key={run.id}
                        className="mc-row"
                        style={{
                          position: "relative",
                          margin: race && !raceLast ? "0 8px 0" : "0 8px 10px",
                          // Capped stagger — long lists (Done) still settle fast.
                          animationDelay: `${Math.min(i, 6) * 35}ms`,
                        }}
                      >
                        {race && raceFirst && (
                          <Tooltip label={`Same task, ${race.size} agents: “${race.prompt}”`}>
                            <div
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 5,
                                padding: "0 3px 4px",
                                fontSize: 10,
                                fontFamily: "var(--font-mono)",
                                color: "var(--fg-dim)",
                              }}
                            >
                              <RaceMark size={10} />
                              race
                            </div>
                          </Tooltip>
                        )}
                        {/* Main conversation card — top of the stack. */}
                        <div
                          className="mc-card"
                          style={{
                            position: "relative",
                            zIndex: children.length + 1,
                            border: "1px solid var(--border)",
                            borderTop:
                              race && !raceFirst ? "none" : "1px solid var(--border)",
                            borderRadius: race
                              ? raceFirst && raceLast
                                ? "var(--radius-md)"
                                : raceFirst
                                ? "var(--radius-md) var(--radius-md) 0 0"
                                : raceLast
                                ? "0 0 var(--radius-md) var(--radius-md)"
                                : "0"
                              : "var(--radius-md)",
                            background: "var(--bg-elevated)",
                            overflow: "hidden",
                          }}
                        >
                          <RunRow
                            run={run}
                            selected={parentSelected}
                            hasMemory={memoryRunIds.has(run.id)}
                            onSelect={() => {
                              selectRun(run);
                              if (hasChildren(run.id)) toggleSubagentStack(run.id);
                            }}
                            dismissAction={
                              parentDismissible
                                ? {
                                    label: run.kind === "task" ? "Delete" : "Dismiss",
                                    danger: run.kind === "task" || run.status === "error",
                                    onDismiss: () => dismissBoardRun(run),
                                  }
                                : undefined
                            }
                            action={
                              sendable ? (
                                <QuickSend
                                  taskId={run.id}
                                  onSent={() => setSelectedId(run.id)}
                                />
                              ) : resumable ? (
                                <ResumeKlide
                                  runId={run.id}
                                  onResume={(id) => onResumeKlideRun?.(id)}
                                />
                              ) : cliResumable ? (
                                <ResumeCli
                                  source={run.source}
                                  onResume={() =>
                                    onOpenInAiPanel?.({
                                      provider: run.source as TaskSource,
                                      workspaceRoot: run.cwd,
                                      resumeSessionId: run.id,
                                    })
                                  }
                                />
                              ) : undefined
                            }
                          />
                        </div>
                        {children.length > 0 && !expanded ? (
                          // Symmetric "sheets" peeking under the card — a calm depth cue
                          // that a stack sits underneath. One sheet for a single child, two
                          // for 2+ (a deeper, narrower one peeks below the nearest). The
                          // count lives in the row's SubagentStackToggle badge, so these
                          // stay unlabeled. No native `title` (it overlapped the next row).
                          (() => {
                            const sheets = Math.min(children.length, 2);
                            return (
                              <button
                                type="button"
                                onClick={() => toggleSubagentStack(run.id)}
                                aria-label={`Expand ${children.length} sub-agent${children.length > 1 ? "s" : ""}`}
                                style={{
                                  position: "relative",
                                  display: "block",
                                  width: "100%",
                                  height: sheets > 1 ? 10 : 6,
                                  margin: "-1px 0 0",
                                  border: "none",
                                  background: "transparent",
                                  cursor: "pointer",
                                  padding: 0,
                                }}
                              >
                                {/* Render deepest first so the nearest sheet paints on top. */}
                                {Array.from({ length: sheets }).map((_, k) => {
                                  const depth = sheets - 1 - k; // 0 = nearest the card
                                  return (
                                    <span
                                      key={k}
                                      aria-hidden
                                      style={{
                                        position: "absolute",
                                        left: 7 + depth * 5,
                                        right: 7 + depth * 5,
                                        top: depth * 4,
                                        height: 6,
                                        border: "1px solid var(--border)",
                                        borderTop: "none",
                                        borderRadius: "0 0 var(--radius-md) var(--radius-md)",
                                        background: "var(--bg-elevated)",
                                      }}
                                    />
                                  );
                                })}
                              </button>
                            );
                          })()
                        ) : null}
                        {children.length > 0 ? (
                          // Folder-tree layout that opens/closes smoothly. The grid track
                          // animates 0fr↔1fr (handles dynamic height in both directions
                          // with no unmount jank); the inner clip hides overflow while it
                          // grows. A vertical rail descends from the parent card; each child
                          // hangs off a ├ tick at its center, the last off a rounded └.
                          <div
                            style={{
                              display: "grid",
                              gridTemplateRows: expanded ? "1fr" : "0fr",
                              opacity: expanded ? 1 : 0,
                              transition:
                                "grid-template-rows var(--motion-med) var(--ease-soft), opacity var(--motion-med) var(--ease-soft)",
                            }}
                          >
                            <div style={{ overflow: "hidden", minHeight: 0 }}>
                              <div style={{ display: "flex", flexDirection: "column", marginTop: 6 }}>
                                {children.map((child, ci) => {
                                  const childSelected = child.id === selectedId;
                                  const childTask = tasks.find((t) => t.id === child.id);
                                  const childSendable =
                                    childTask && (childTask.status === "queued" || childTask.status === "error");
                                  const childCliResumable =
                                    child.kind === "run" &&
                                    (child.source === "claude-code" ||
                                      child.source === "codex" ||
                                      child.source === "opencode") &&
                                    !isClaudeInternalSubagent(child) &&
                                    child.status !== "running" &&
                                    onOpenInAiPanel;
                                  const childDismissible =
                                    boardSectionForRun(child) === "blocked" || runAttentionReason(child) !== null;
                                  const isLast = ci === children.length - 1;
                                  const first = ci === 0;
                                  return (
                                    <div
                                      key={child.id}
                                      style={{
                                        position: "relative",
                                        paddingLeft: 22,
                                        marginBottom: isLast ? 0 : 6,
                                      }}
                                    >
                                      {isLast ? (
                                        // └ — rail drops to the card's center, then a rounded turn.
                                        <span
                                          aria-hidden
                                          style={{
                                            position: "absolute",
                                            left: 9,
                                            top: first ? -6 : 0,
                                            height: first ? "calc(50% + 6px)" : "50%",
                                            width: 9,
                                            borderLeft: "1px solid var(--border)",
                                            borderBottom: "1px solid var(--border)",
                                            borderBottomLeftRadius: "var(--radius-sm)",
                                          }}
                                        />
                                      ) : (
                                        // ├ — rail runs straight through; tick meets the card center.
                                        <>
                                          <span
                                            aria-hidden
                                            style={{
                                              position: "absolute",
                                              left: 9,
                                              top: first ? -6 : 0,
                                              bottom: -6,
                                              borderLeft: "1px solid var(--border)",
                                            }}
                                          />
                                          <span
                                            aria-hidden
                                            style={{
                                              position: "absolute",
                                              left: 9,
                                              top: "50%",
                                              width: 9,
                                              borderTop: "1px solid var(--border)",
                                            }}
                                          />
                                        </>
                                      )}
                                      <div
                                        style={{
                                          border: "1px solid var(--border)",
                                          borderRadius: "var(--radius-md)",
                                          background: "var(--bg-elevated)",
                                          overflow: "hidden",
                                        }}
                                      >
                                        <RunRow
                                          run={child}
                                          selected={childSelected}
                                          hasMemory={memoryRunIds.has(child.id)}
                                          onSelect={() => selectRun(child)}
                                          dismissAction={
                                            childDismissible
                                              ? {
                                                  label: child.kind === "task" ? "Delete" : "Dismiss",
                                                  danger: child.kind === "task" || child.status === "error",
                                                  onDismiss: () => dismissBoardRun(child),
                                                }
                                              : undefined
                                          }
                                          action={
                                            childSendable ? (
                                              <QuickSend
                                                taskId={child.id}
                                                onSent={() => setSelectedId(child.id)}
                                              />
                                            ) : childCliResumable ? (
                                              <ResumeCli
                                                source={child.source}
                                                onResume={() =>
                                                  onOpenInAiPanel?.({
                                                    provider: child.source as TaskSource,
                                                    workspaceRoot: child.cwd,
                                                    resumeSessionId: child.id,
                                                  })
                                                }
                                              />
                                            ) : undefined
                                          }
                                        />
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            });
          })()}
          {hasMore && (
            <button
              onClick={() => void loadMore()}
              disabled={loadingMore}
              style={{
                width: "calc(100% - 16px)",
                margin: "4px 8px 0",
                padding: "8px",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: "var(--fg-subtle)",
                border: "1px dashed var(--border)",
                borderRadius: "var(--radius-sm)",
                background: "transparent",
              }}
              onMouseEnter={(e) => {
                if (!loadingMore) e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </div>

        {error && (
          <div
            style={{
              padding: "8px 16px",
              fontSize: 11,
              color: "var(--fg-subtle)",
              borderTop: "1px solid var(--border)",
            }}
          >
            Showing sample data. Local session logs were unavailable in this run.
          </div>
        )}
      </div>

      {/* Right: detail */}
      <div className="mission-control-detail" style={{ flex: 1, minWidth: 0 }}>
        {selectedTask ? (
          <TaskDetail task={selectedTask} theme={theme} />
        ) : selectedRun ? (
          <RunDetail
            run={selectedRun}
            workspaceRoot={workspaceRoot}
            messages={selectedConvo?.messages}
            handoffPrompt={
              selectedConvo
                ? buildRunHandoff({
                    title: selectedConvo.title,
                    sourceLabel: runAgentLabel(selectedRun),
                    cwd: selectedConvo.cwd,
                    model: selectedConvo.model,
                    messages: selectedConvo.messages.map((message) => ({
                      role: message.role,
                      text: message.text,
                    })),
                  }).delegatePrompt
                : handoffPrompt
            }
            hasMemory={memoryRunIds.has(selectedRun.id)}
            onRename={renameLedgerRun}
            onArchive={archiveLedgerRun}
            onFork={onForkRun}
            onForkInWorktree={onForkRunInWorktree}
            onMergeWorktree={onMergeWorktreeRun}
            forkParent={selectedForkParent}
            forkChildren={selectedForkChildren}
            onSelectLineageRun={selectLineageRun}
            race={selectedRace}
            raceEntries={selectedRaceEntries}
            onOpenInAiPanel={onOpenInAiPanel}
            onResumeKlide={onResumeKlideRun}
            onReviewRun={(run) => void reviewRun(run)}
            onOpenArtifact={openArtifact}
            onSaveMemory={onSaveMemory}
            summarizingFromRunId={summarizingFromRunId}
          />
        ) : (
          <div
            style={{
              height: "100%",
              display: "grid",
              placeItems: "center",
              color: "var(--fg-subtle)",
              fontSize: 13,
              textAlign: "center",
              padding: 24,
            }}
          >
            {loading ? "Loading runs..." : "Select a run to inspect its transcript and metadata."}
          </div>
        )}
      </div>

      <div
        className="artifact-inspector-shell"
        data-open={artifactOpen ? "true" : "false"}
        aria-hidden={!artifactOpen}
        style={{ pointerEvents: artifactOpen ? "auto" : "none" }}
      >
        {artifactTabs.length > 0 && activeArtifactKey !== null && (
          <Suspense
            fallback={<div className="artifact-inspector-state">Opening artifact…</div>}
          >
            <ArtifactInspector
              tabs={artifactTabs}
              activeTabKey={activeArtifactKey}
              theme={theme}
              onSelectTab={setActiveArtifactKey}
              onCloseTab={closeArtifactTab}
              onClose={closeArtifact}
              onDirtyChange={setArtifactDirty}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

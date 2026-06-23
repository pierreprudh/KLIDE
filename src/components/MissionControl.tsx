import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  stopTask,
  subscribeTasks,
  type TaskSession,
  type TaskSource,
} from "../tasks";
import {
  getKlideConvos,
  subscribeKlideConvos,
  type KlideConvo,
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
  runAttentionReason,
  runBoardReason,
  runNeedsAttention,
  runRoutineInfo,
  seedRuns,
  relativeTime,
  ATTENTION_LABEL,
  ATTENTION_TONE,
  SOURCE_COLOR,
  SOURCE_LABEL,
  STATUS_COLOR,
  STATUS_LABEL,
  type Run,
  type RunAttention,
  type RunBoardReasonTone,
  type RunBoardSection,
  type RunKind,
  type RunMessage,
  type RunSource,
  type RunStatus,
  type RunToolCall,
} from "../runs";
import { DELEGATE_IDS, isDelegateId, type DelegateId } from "../delegates";
import { CheckpointPanel } from "./CheckpointPanel";
import { ProviderLogo } from "./ai/icons";
import { modelBrand } from "../modelBrand";
import { renderMarkdown } from "./markdown";

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

// Present a dispatched task as a Run so it shares the board's rows, filters
// and status groups with the disk-log runs. `kind: "task"` is what tells
// the row renderer to use the task avatar + TASK badge (vs. the Klide
// spark used for AI-panel conversations).
function taskToRun(t: TaskSession): Run {
  return {
    id: t.id,
    path: "",
    kind: "task",
    // Undispatched todos wear the Klide mark until an agent is sent.
    source: t.source ?? "klide",
    title: t.title,
    status: t.status,
    model: t.model,
    project: t.cwd ? t.cwd.split("/").filter(Boolean).pop() ?? null : null,
    cwd: t.cwd,
    branch: null,
    messageCount: 0,
    updatedMs: t.startedMs,
    createdMs: t.startedMs,
  };
}

function isClaudeInternalSubagent(run: Pick<Run, "source" | "path">): boolean {
  return run.source === "claude-code" && run.path.includes("/subagents/");
}

function SubagentStackToggle({
  count,
  expanded,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <span
      role="button"
      aria-label={expanded ? "Collapse subagents" : "Expand subagents"}
      title={expanded ? "Collapse subagents" : "Expand subagents"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      style={{
        height: 22,
        minWidth: 30,
        padding: "0 6px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        background: expanded ? "var(--accent-soft)" : "var(--bg-hover)",
        color: expanded ? "var(--accent)" : "var(--fg-subtle)",
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        lineHeight: 1,
      }}
    >
      {count}
      <span aria-hidden style={{ fontSize: 10, transform: expanded ? "rotate(180deg)" : "none" }}>
        ▾
      </span>
    </span>
  );
}

// Same for an AI-panel conversation — Klide's own chats join the board.
function convoToRun(c: KlideConvo): Run {
  return {
    id: c.id,
    path: "",
    kind: "convo",
    source: "klide",
    title: c.title,
    status: c.status,
    model: c.model,
    project: c.cwd ? c.cwd.split("/").filter(Boolean).pop() ?? null : null,
    cwd: c.cwd,
    branch: null,
    messageCount: c.messages?.length ?? 0,
    updatedMs: c.updatedMs,
    createdMs: c.updatedMs,
  };
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
  return tone === "danger" ? "var(--danger, #B42318)" : "var(--fg-subtle)";
}

function RunReasonChip({ run }: { run: Run }) {
  const reason = runBoardReason(run);
  if (reason.tone === "success") return null;
  return (
    <span style={boardReasonChipStyle(reason.tone)} title={reason.detail}>
      {reason.label}
    </span>
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
    <span
      title={routine.label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        flexShrink: 0,
        height: 16,
        padding: "0 5px",
        borderRadius: 999,
        border: "1px solid color-mix(in srgb, var(--accent) 24%, var(--border))",
        background: "color-mix(in srgb, var(--accent-soft) 30%, transparent)",
        color: "var(--fg-subtle)",
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        lineHeight: 1,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 4,
          height: 4,
          borderRadius: "50%",
          background: "var(--accent)",
        }}
      />
      {routine.cadence === "routine" ? "Routine" : routine.cadence}
    </span>
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

function ModelProviderBadge({ model }: { model: string | null }) {
  const provider = modelProvider(model);
  if (!provider) return null;
  const color = provider === "opencode-go" ? "#D97757" : "var(--fg-dim)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        fontSize: 9,
        fontWeight: 600,
        fontFamily: "var(--font-mono)",
        letterSpacing: "0.04em",
        color,
        padding: "1px 5px",
        borderRadius: 3,
        background: `color-mix(in srgb, ${provider === "opencode-go" ? "#D97757" : "var(--fg-dim)"} 10%, var(--bg-elevated))`,
        border: `1px solid color-mix(in srgb, ${provider === "opencode-go" ? "#D97757" : "var(--border)"} 25%, var(--border))`,
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
  if (/gemini/i.test(model)) return <ProviderLogo id="gemini" size={size} />;
  if (/grok/i.test(model)) return <ProviderLogo id="xai" size={size} />;
  // Remaining on-device families (gemma, phi, nomic, …) served through
  // Ollama — wear the runtime's mark.
  if (/gemma|phi-?\d|nomic|mxbai|granite|smollm|starcoder/i.test(model))
    return <ProviderLogo id="ollama" size={size} />;
  return null;
}

function ModelBadge({ model, size = 13 }: { model: string; size?: number }) {
  return resolveModelLogo(model, size);
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
  size = 14,
}: {
  source: RunSource;
  kind?: RunKind;
  model?: string | null;
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
  // Klide's own runs wear the logo of the model they used — Ollama for local
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
  size = 22,
}: {
  source: RunSource;
  kind?: RunKind;
  model?: string | null;
  size?: number;
}) {
  return (
    <SourceLogo source={source} kind={kind} model={model} size={size} />
  );
}

function RunRow({
  run,
  selected,
  onSelect,
  action,
  dismissAction,
  compact,
  hasMemory,
}: {
  run: Run;
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
  const tokenSummary = runTokenSummary(run);
  const showEvidence = run.status !== "error";
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
        boxShadow:
          dismissAction && dragX < 0
            ? "8px 0 24px color-mix(in srgb, #000 11%, transparent)"
            : undefined,
        transition:
          dragging
            ? "background var(--motion-fast) var(--ease-out)"
            : "background var(--motion-fast) var(--ease-out), transform 420ms cubic-bezier(.18,.88,.22,1), box-shadow 420ms cubic-bezier(.18,.88,.22,1)",
        position: "relative",
        zIndex: swipeOpen ? 1 : 3,
      }}
    >
      {!compact && <RunAvatar source={run.source} kind={run.kind} model={run.model} />}
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
                background: "color-mix(in srgb, var(--accent) 14%, transparent)",
                border: "1px solid color-mix(in srgb, var(--accent) 28%, transparent)",
                padding: "1px 5px",
                borderRadius: 999,
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
        </span>
          {!compact && run.lastEvent ? (
            <span
              title={run.lastEvent}
              style={{
                fontSize: 11.5,
                color: "var(--fg-muted)",
                lineHeight: 1.3,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {run.lastEvent}
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
            {/* Klide rows carry the model logo on the avatar already, so the
                subtitle badge would just repeat it — skip it there (except in
                compact rows, which have no avatar). External runs keep their
                product/model mark inline. */}
            <RunReasonChip run={run} />
            {run.source === "klide" && !compact ? null : run.source === "claude-code" ? null : run.model ? (
              <ModelBadge model={run.model} size={13} />
            ) : run.source === "codex" ? (
              <CodexLogo size={13} />
            ) : (
              <ProviderLogo id={run.source as any} size={11} />
            )}
            {run.source === "opencode" && run.model ? (
              <>
                {modelProvider(run.model)} . {modelShortName(run.model)}
              </>
            ) : run.source === "claude-code" ? (
              <>
                <AnthropicMark size={11} />
                {SOURCE_LABEL[run.source]}
                {run.model ? <> · {run.model}</> : null}
              </>
            ) : (
              <>
                {SOURCE_LABEL[run.source]}
                {run.model ? <> · {run.model}</> : null}
              </>
            )}
            {run.branch ? ` · ${run.branch}` : ""}
            {showEvidence && run.worktree ? ` · in ${run.worktree}` : ""}
            {showEvidence && formatFilesTouched(run.filesTouched) ? ` · ${formatFilesTouched(run.filesTouched)}` : ""}
            {showEvidence && formatCost(run.costUsd) ? ` · ${formatCost(run.costUsd)}` : ""}
            {showEvidence && tokenSummary ? ` · ${tokenSummary}` : ""}
            {showEvidence && run.subagentCount
              ? ` · ${run.subagentCount} sub-agent${run.subagentCount > 1 ? "s" : ""}`
              : ""}
            {" · "}
            {relativeTime(run.updatedMs)}
            {hasMemory ? (
              <span
                title="A Project Memory note is saved for this run"
                style={{ color: "var(--accent)" }}
              >
                {" · "}memory
              </span>
            ) : null}
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
            ? "linear-gradient(135deg, color-mix(in srgb, var(--danger, #B42318) 24%, var(--bg-elevated)), color-mix(in srgb, var(--danger, #B42318) 14%, var(--bg)))"
            : "linear-gradient(135deg, color-mix(in srgb, var(--fg-subtle) 13%, var(--bg-elevated)), var(--bg-hover))",
          color: dismissAction.danger ? "var(--danger, #B42318)" : "var(--fg-muted)",
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

const ATTENTION_SEVERITY: Record<RunAttention["kind"], number> = {
  failed: 0,
  awaiting_input: 1,
  idle: 2,
  awaiting_review: 3,
};

const DISMISSED_ATTENTION_KEY = "klide-dismissed-attention";
const DISMISSED_BOARD_KEY = "klide-dismissed-board-runs";

function attentionDismissKey(run: Pick<Run, "source" | "id" | "status" | "updatedMs">): string {
  return `${run.source}:${run.id}:${run.status}:${run.updatedMs}`;
}

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

function readDismissedAttention(): Set<string> {
  return readStringSet(DISMISSED_ATTENTION_KEY);
}

function writeDismissedAttention(ids: Set<string>) {
  writeStringSet(DISMISSED_ATTENTION_KEY, ids);
}

function readDismissedBoardRuns(): Set<string> {
  return readStringSet(DISMISSED_BOARD_KEY);
}

function writeDismissedBoardRuns(ids: Set<string>) {
  writeStringSet(DISMISSED_BOARD_KEY, ids);
}

// Compact one-line summary for an attention reason, in the row's subtitle
// slot. The label alone ("Failed", "Needs you") is too generic on a board
// with many runs — append the agent so the user knows which tool to look at.
function attentionSubtitle(reason: RunAttention, source: RunSource): string {
  switch (reason.kind) {
    case "failed":
      return `${reason.agentLabel} failed`;
    case "awaiting_input":
      return `${SOURCE_LABEL[source]} is waiting for input`;
    case "idle": {
      const min = Math.floor(reason.idleMs / 60_000);
      return min < 60 ? `Idle ${min}m` : `Idle ${Math.floor(min / 60)}h`;
    }
    case "awaiting_review":
      return source === "klide"
        ? "Subagent finished — read its output"
        : `${SOURCE_LABEL[source]} finished — review the work`;
  }
}

// Theme-aware tone styling for the reason pill. Pulled out so the queue can
// stay compact while still differentiating severity at a glance.
function attentionPillStyle(kind: RunAttention["kind"]): React.CSSProperties {
  const tone = ATTENTION_TONE[kind];
  const fg = tone === "danger" ? "var(--danger, #B42318)" : "var(--fg-subtle)";
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    height: 16,
    padding: 0,
    borderRadius: 0,
    border: "none",
    background: "transparent",
    color: fg,
    fontSize: 9,
    fontWeight: 500,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    fontFamily: "var(--font-mono)",
    flexShrink: 0,
  };
}

function AttentionQueueItem({
  run,
  reason,
  isTask,
  onSelect,
  onDismiss,
  onResumeKlide,
  onOpenInAiPanel,
}: {
  run: Run;
  reason: RunAttention;
  /** True when the run was spawned by Mission Control's task composer — the
   *  "send an agent" affordance is the right action for queued/error tasks. */
  isTask: boolean;
  onSelect: () => void;
  onDismiss: () => void;
  onResumeKlide?: (runId: string) => void;
  onOpenInAiPanel?: (input: { provider: DelegateId; workspaceRoot: string | null; resumeSessionId: string }) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const subtitle = attentionSubtitle(reason, run.source);

  // The "jump back into this run" action — resume in Klide, or re-open the CLI
  // session in an AI panel. Shared across the reason kinds whose next step is
  // "get back in there": failed (retry), awaiting_input (answer it), and idle
  // (nudge / take over).
  const resumeAction: React.ReactNode | null =
    run.source === "klide" && onResumeKlide ? (
      <ResumeKlide runId={run.id} onResume={onResumeKlide} />
    ) : isDelegateId(run.source) && onOpenInAiPanel ? (
      <ResumeCli
        source={run.source}
        onResume={() =>
          onOpenInAiPanel({
            provider: run.source as DelegateId,
            workspaceRoot: run.cwd,
            resumeSessionId: run.id,
          })
        }
      />
    ) : null;

  // Pick the inline action. The hover-revealed slot mirrors RunRow's pattern
  // so the row stays quiet until the user reaches for it. Every reason kind now
  // surfaces its own next step, so the queue is actionable without first
  // drilling into the detail pane.
  let action: React.ReactNode | null = null;
  if (isTask && (run.status === "queued" || run.status === "error")) {
    action = <QuickSend taskId={run.id} onSent={onSelect} />;
  } else if (
    reason.kind === "failed" ||
    reason.kind === "awaiting_input" ||
    reason.kind === "idle"
  ) {
    action = resumeAction;
  } else if (reason.kind === "awaiting_review") {
    // The review surface is the detail pane; the action just selects the row.
    action = <ReviewAction onReview={onSelect} />;
  }

  return (
    <button
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        textAlign: "left",
        padding: "7px 9px",
        borderRadius: "var(--radius-sm)",
        background: hovered ? "var(--bg-hover)" : "transparent",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      <RunAvatar source={run.source} kind={run.kind} model={run.model} />
      <span style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: 12,
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
        </span>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
          }}
        >
          <span style={attentionPillStyle(reason.kind)}>{ATTENTION_LABEL[reason.kind]}</span>
          <span
            style={{
              fontSize: 10,
              color: "var(--fg-subtle)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {subtitle}
          </span>
        </span>
      </span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          flexShrink: 0,
        }}
      >
        {hovered && action ? action : null}
        <span
          style={{
            width: 22,
            height: 22,
            display: "grid",
            placeItems: "center",
          }}
        >
          {hovered ? (
            <DismissAttention
              label={isTask ? "Delete task" : "Dismiss from attention"}
              onDismiss={onDismiss}
            />
          ) : (
            <StatusDot status={run.status} size={7} />
          )}
        </span>
      </span>
    </button>
  );
}

function AttentionQueue({
  runs,
  tasks,
  onSelect,
  onResumeKlide,
  onOpenInAiPanel,
}: {
  runs: Run[];
  tasks: TaskSession[];
  onSelect: (run: Run) => void;
  onResumeKlide?: (runId: string) => void;
  onOpenInAiPanel?: (input: { provider: DelegateId; workspaceRoot: string | null; resumeSessionId: string }) => void;
}) {
  // Stable open/closed state — collapse the queue after the user dismisses
  // it once, and remember the choice across re-renders. The first render is
  // open when there's something to look at, so the user doesn't have to dig
  // for a 1-item queue.
  const [open, setOpen] = useState(true);
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissedAttention());

  const items = useMemo(() => {
    const taskIds = new Set(tasks.map((t) => t.id));
    return runs
      .map((run) => {
        const reason = runAttentionReason(run);
        if (reason && dismissed.has(attentionDismissKey(run))) return null;
        return reason ? { run, reason, isTask: taskIds.has(run.id) } : null;
      })
      .filter((x): x is { run: Run; reason: RunAttention; isTask: boolean } => x !== null)
      .sort((a, b) => {
        const sev = ATTENTION_SEVERITY[a.reason.kind] - ATTENTION_SEVERITY[b.reason.kind];
        if (sev !== 0) return sev;
        return b.run.updatedMs - a.run.updatedMs;
      });
  }, [runs, tasks, dismissed]);

  function dismiss(run: Run, isTask: boolean) {
    if (isTask && run.status !== "running") {
      removeTask(run.id);
      return;
    }
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(attentionDismissKey(run));
      writeDismissedAttention(next);
      return next;
    });
  }

  // The strip is hidden entirely when nothing needs attention — its presence
  // is the signal. Returning null keeps the layout compact and avoids a
  // permanent "0 items" empty state.
  if (items.length === 0) return null;

  return (
    <div
      style={{
        margin: "4px 8px 12px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        background: "var(--bg-elevated)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? "Collapse attention queue" : "Expand attention queue"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "8px 11px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          color: "var(--fg-strong)",
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          fontFamily: "var(--font-mono)",
        }}
      >
        <span
          style={{ color: "var(--fg-strong)" }}
        >
          Attention
        </span>
        <span style={{ opacity: 0.7 }}>{items.length}</span>
        <span style={{ marginLeft: "auto", color: "var(--fg-subtle)", fontSize: 12, lineHeight: 1 }}>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            padding: "2px 4px 4px",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {items.map(({ run, reason, isTask }) => (
            <AttentionQueueItem
              key={run.id}
              run={run}
              reason={reason}
              isTask={isTask}
              onSelect={() => onSelect(run)}
              onDismiss={() => dismiss(run, isTask)}
              onResumeKlide={onResumeKlide}
              onOpenInAiPanel={onOpenInAiPanel}
            />
          ))}
        </div>
      )}
    </div>
  );
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
function ReviewAction({ onReview }: { onReview: () => void }) {
  return (
    <span
      role="button"
      aria-label="Review output"
      title="Review output"
      onClick={(e) => {
        e.stopPropagation();
        onReview();
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
      <ReviewIcon />
    </span>
  );
}

function ReviewIcon() {
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
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function DismissAttention({
  label,
  onDismiss,
}: {
  label: string;
  onDismiss: () => void;
}) {
  return (
    <span
      role="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onDismiss();
      }}
      style={{
        width: 22,
        height: 22,
        flexShrink: 0,
        display: "grid",
        placeItems: "center",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        color: "var(--fg-subtle)",
        background: "var(--bg-hover)",
      }}
    >
      <DismissIcon />
    </span>
  );
}

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
        void dispatchTask(taskId, agent).catch(() => {
          // Failure flips the task to error in the store; the detail pane
          // (now selected) shows the message and re-send controls.
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
        borderRadius: 999,
        border: "1px solid var(--border)",
        color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
        background: active ? "var(--bg-selected)" : "transparent",
        transition: "background var(--motion-fast) var(--ease-out)",
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
            color: reason.tone === "danger" ? "var(--danger, #B42318)" : "var(--fg-subtle)",
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

function CopyButton({ value, label = "Copy" }: { value: string | null; label?: string }) {
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
      const role = m.role === "user" ? "**You**" : `**${SOURCE_LABEL[run.source]}**`;
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
        <button
          onClick={copyAsMarkdown}
          title="Copy conversation as Markdown"
          style={{
            background: "none",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--fg-subtle)",
            fontSize: 10,
            padding: "3px 8px",
            cursor: "pointer",
            letterSpacing: "0.04em",
          }}
        >
          Copy as MD
        </button>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 22,
          maxWidth: 1040,
        }}
      >
        {conversationItems.map((item, i) => {
          if (item.type === "process") {
            return showProcessNotes ? <ProcessNoteStack key={`process-${i}`} notes={item.notes} /> : null;
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
                <ConversationAvatar source={run.source} label={SOURCE_LABEL[run.source]} model={run.model} />
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
                    borderRadius: isUser ? "16px 16px 5px 16px" : "16px 16px 16px 5px",
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
                  <ToolStack tools={item.tools} />
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
        gap: 8,
        minWidth: 0,
        color: "var(--fg-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
      }}
    >
      <span style={{ color: "var(--fg-subtle)" }}>Review</span>
      <span>{turns} turns</span>
      {tools > 0 && (
        <ReviewToggle
          active={showTools}
          label={`${tools} tools`}
          title={showTools ? "Hide tool activity" : "Show tool activity"}
          onClick={onToggleTools}
        />
      )}
      {notes > 0 && (
        <ReviewToggle
          active={showNotes}
          label={`${notes} notes`}
          title={showNotes ? "Hide working notes" : "Show working notes"}
          onClick={onToggleNotes}
        />
      )}
    </div>
  );
}

function ReviewToggle({
  active,
  label,
  title,
  onClick,
}: {
  active: boolean;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        padding: "2px 7px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        background: active ? "var(--bg-selected)" : "transparent",
        color: active ? "var(--fg-strong)" : "var(--fg-dim)",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

type ConversationItem =
  | { type: "message"; message: RunMessage; text: string; tools: RunToolCall[] }
  | { type: "process"; notes: string[] };

function compactConversationMessages(messages: RunMessage[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  let notes: string[] = [];
  const flush = () => {
    if (notes.length === 0) return;
    items.push({ type: "process", notes });
    notes = [];
  };
  const appendToolsToPreviousAssistant = (tools: RunToolCall[]) => {
    if (tools.length === 0) return false;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type === "process") continue;
      if (item.message.role !== "assistant") return false;
      item.tools.push(...tools);
      return true;
    }
    return false;
  };
  for (const message of messages) {
    const parsed = splitToolCalls(message.text);
    const text = parsed.text.trim();
    const messageTools = [...(message.tools ?? []), ...parsed.tools];
    if (message.role === "assistant" && text && isProcessNote(text)) {
      if (messageTools.length > 0) appendToolsToPreviousAssistant(messageTools);
      notes.push(text);
      continue;
    }
    if (!text) {
      if (message.role === "assistant" && appendToolsToPreviousAssistant(messageTools)) {
        continue;
      }
      if (messageTools.length > 0) {
        flush();
        items.push({ type: "process", notes: [`Tool activity · ${messageTools.length}`] });
      }
      continue;
    }
    flush();
    items.push({ type: "message", message, text, tools: messageTools });
  }
  flush();
  return items;
}

function isProcessNote(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.length > 900) return false;
  return /^(I('|’)?m|I('|’)?ll|I will|I found|I caught|I noticed|I’m|I’ll|Fresh server|Build|TypeScript|Final compile|Final browser|Okay,|Interesting:|One more|That native|The browser|The auto-theme|Again there|A new|The type mismatch|The local-only|The Tauri|Diff shape|Whitespace|Frontend build|Server is up|Port `?\d+|Done\. I took)/i.test(t);
}

function ProcessNoteStack({ notes }: { notes: string[] }) {
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
  label,
  model,
  user,
}: {
  source: RunSource;
  label: string;
  model?: string | null;
  user?: boolean;
}) {
  const initials = user ? initialsOf(label || "Me") : null;
  const hue = user ? hueFromName(label || "Me") : 0;
  const modelLogoRule =
    source === "opencode" && model
      ? MODEL_LOGO_RULES.find((r) => r.pattern.test(model))
      : null;
  const ModelLogo = modelLogoRule?.Comp;
  const logo =
    source === "claude-code" ? (
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
        background: user
          ? `linear-gradient(140deg, oklch(0.78 0.10 ${hue}), oklch(0.62 0.12 ${(hue + 40) % 360}))`
          : "transparent",
        color: user ? "var(--bg-elevated)" : SOURCE_COLOR[source],
        display: "grid",
        placeItems: "center",
        fontSize: user ? 12 : undefined,
        fontFamily: user ? "var(--font-ui)" : undefined,
        fontWeight: user ? 650 : undefined,
        justifySelf: user ? "start" : "end",
        boxShadow: user ? "inset 0 1px 0 rgba(255,255,255,0.2)" : undefined,
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

function hueFromName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

function splitToolCalls(text: string): { text: string; tools: RunToolCall[] } {
  const tools: RunToolCall[] = [];
  const lines = text.split("\n");
  const kept = lines.filter((line) => {
    const tool = line.match(/^\[tool:\s*([^\]]+)\]\s*$/);
    if (!tool) return true;
    tools.push(toolFromMarker(tool[1]));
    return false;
  });
  return { text: kept.join("\n").trim(), tools };
}

function toolFromMarker(marker: string): RunToolCall {
  const raw = marker.trim();
  const match = raw.match(/^([^\s(:]+)(?:\s+(.+))?$/);
  return {
    name: match?.[1] ?? (raw || "tool"),
    summary: match?.[2]?.trim(),
    status: "unknown",
  };
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

// The todo box. Type a task and hit Enter — it lands in Queued. Sending an
// agent to it happens from the task's detail pane, so adding stays instant.
function TaskComposer({
  workspaceRoot,
  onAdded,
}: {
  workspaceRoot: string | null;
  onAdded: (id: string) => void;
}) {
  const [text, setText] = useState("");

  function add() {
    const title = text.trim();
    if (!title) return;
    const task = addTask(title, workspaceRoot);
    setText("");
    onAdded(task.id);
  }

  return (
    <div style={{ padding: "10px 16px 12px", borderBottom: "1px solid var(--border)" }}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        placeholder="Add a task…"
        style={{
          width: "100%",
          fontSize: 12.5,
          lineHeight: 1.5,
          fontFamily: "inherit",
          color: "var(--fg-strong)",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          padding: "7px 9px",
          outline: "none",
        }}
      />
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
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
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
                      color: "var(--fg-subtle)",
                      padding: "8px 12px 4px",
                      fontFamily: "var(--font-mono)",
                      background: "var(--bg)",
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
    invoke<string[]>("ai_provider_models", { provider: agent })
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
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--danger, #B42318)" }}>
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
  messages,
  firstUserMessage,
  hasMemory,
  onOpenInAiPanel,
  onResumeKlide,
  onReviewDiff,
  onSaveMemory,
  summarizingFromRunId,
}: {
  run: Run;
  messages?: RunMessage[];
  /** A durable Project Memory note exists for this run (matched by runId). */
  hasMemory?: boolean;
  /** First user message of a Klide run — used as the task prompt when
   *  handing the run off to an external CLI. */
  firstUserMessage: string | null;
  /** Land the user in a new AI panel pinned to the chosen delegate provider. */
  onOpenInAiPanel?: (opts: {
    provider: TaskSource;
    workspaceRoot: string | null;
    resumeSessionId?: string;
    initialTask?: string;
  }) => void;
  onResumeKlide?: (runId: string) => void;
  /** Review this run's file changes (CheckpointPanel for Klide, Git Review
   *  for CLI). These live here in the detail pane rather than on the row so
   *  the run list stays quiet. */
  onReviewDiff?: (run: { id: string; source: string; cwd: string | null }) => void;
  onSaveMemory?: (run: { id: string; source: string; provider?: string | null; model: string | null; cwd: string | null }) => void;
  summarizingFromRunId?: string | null;
}) {
  // All 3 external CLIs support resume flags today: `claude --resume <id>`,
  // `codex resume <id>`, and `opencode -s <id>`. The Rust seam builds the
  // right command for each, so the UI just needs to be honest about it.
  const resumable = isDelegateId(run.source);
  // The full set of CLI sources we can offer as "Open in {source}". Klide
  // runs hand off to one of these with the first user message as the task.
  const cliSources: DelegateId[] = [...DELEGATE_IDS];

  return (
    <div style={{ padding: "20px 24px", overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <RunAvatar source={run.source} size={30} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span
            style={{ fontSize: 12, color: "var(--fg-strong)", fontFamily: "var(--font-mono)" }}
          >
            {SOURCE_LABEL[run.source]}
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: STATUS_COLOR[run.status],
              fontFamily: "var(--font-mono)",
            }}
          >
            <StatusDot status={run.status} size={6} />
            {STATUS_LABEL[run.status]}
          </span>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 14px", flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--fg-strong)", margin: 0 }}>
          {run.title}
        </h2>
        <RoutineBadge run={run} />
      </div>

      <RunEvidenceStrip run={run} hasMemory={hasMemory} />

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <CopyButton value={run.path || null} label="Copy log path" />
        <CopyButton value={run.cwd} label="Copy cwd" />
        {resumable && onOpenInAiPanel && (
          <ActionButton
            label={`Resume in ${SOURCE_LABEL[run.source]}`}
            primary
            onClick={() =>
              onOpenInAiPanel({
                provider: run.source as TaskSource,
                workspaceRoot: run.cwd,
                resumeSessionId: run.id,
              })
            }
          />
        )}
        {run.source === "klide" && onResumeKlide && (
          <ActionButton
            label="Resume in Klide"
            primary
            onClick={() => onResumeKlide(run.id)}
          />
        )}
        {/* "Open in {other CLI}" — hands the run off to a fresh delegate
            TUI in a new AI panel. Klide runs pass the first user message
            as the task prompt so the new session starts with context. */}
        {onOpenInAiPanel &&
          cliSources
            .filter((s) => s !== run.source)
            .map((s) => (
              <ActionButton
                key={s}
                label={`Open in ${SOURCE_LABEL[s]}`}
                onClick={() =>
                  onOpenInAiPanel({
                    provider: s,
                    workspaceRoot: run.cwd,
                    initialTask:
                      run.source === "klide" && firstUserMessage
                        ? firstUserMessage
                        : undefined,
                  })
                }
              />
            ))}
        {onReviewDiff && (
          <ActionButton
            label={run.source === "klide" ? "Review diff" : "Open Git Review"}
            onClick={() => onReviewDiff({ id: run.id, source: run.source, cwd: run.cwd })}
          />
        )}
        {onSaveMemory && run.source === "klide" && (
          <ActionButton
            label={summarizingFromRunId === run.id ? "Saving…" : "Save memory"}
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
      </div>

      {!messages && (
        <div
          style={{
            marginBottom: 18,
            padding: "8px 10px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border)",
            color: "var(--fg-subtle)",
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          {resumable
            ? `Resume continues your last ${SOURCE_LABEL[run.source]} session in a new AI panel — prior context, model, and workspace intact. "Open in {CLI}" drops you into a fresh TUI in the same project.`
            : run.source === "klide"
            ? "Resume in Klide reopens the AI panel with this transcript. Open in {CLI} hands the first message off to a fresh delegate session."
            : "Read-only inspector for the local session log."}
        </div>
      )}

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "7px 18px",
          fontSize: 12,
          margin: "0 0 22px",
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
              {run.source === "klide"
                ? resolveModelLogo(run.model, 13) ?? <ProviderLogo id={run.source as any} size={13} />
                : <ProviderLogo id={run.source as any} size={13} />}
              {run.model}
            </>
          ) : null}
        </dd>
        <MetaRow label="Project" value={run.project ?? "—"} />
        <MetaRow label="Branch" value={run.branch ?? "—"} />
        <MetaRow label="Messages" value={String(run.messageCount)} />
        <MetaRow label="Updated" value={relativeTime(run.updatedMs)} />
        {run.path && <MetaRow label="Log" value={run.path} />}
        {run.cwd && <MetaRow label="Directory" value={run.cwd} />}
      </dl>

      {run.source === "klide" && (
        <>
          <DetailLabel id={`klide-checkpoints-${run.id}`}>Checkpoints</DetailLabel>
          <div style={{ marginBottom: 22 }}>
            <CheckpointPanel runId={run.id} />
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
        padding: "5px 12px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        color: disabled ? "var(--fg-subtle)" : primary ? "var(--fg-strong)" : "var(--fg)",
        background: primary && !disabled ? "var(--accent-soft)" : "transparent",
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

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

const PAGE = 20;

export function MissionControl({
  workspaceRoot,
  theme,
  onResumeKlideRun,
  onOpenInAiPanel,
  onReviewDiff,
  onSaveMemory,
  pendingCheckpointRunId,
  onPendingCheckpointConsumed,
  summarizingFromRunId,
  onBack,
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
  /** "Review Diff" — for Klide runs, scroll the detail pane's
   *  CheckpointPanel into view. For CLI runs, switch to the git-review
   *  view. Fires from the row's right rail. */
  onReviewDiff?: (run: { id: string; source: string; cwd: string | null }) => void;
  /** "Save Memory" — fetch the run's transcript, ask the model for a
   *  structured note, and open the memory modal. Klide-only in this
   *  slice; CLI rows get a "not supported" toast. */
  onSaveMemory?: (run: { id: string; source: string; provider?: string | null; model: string | null; cwd: string | null }) => void;
  /** When set, the detail pane focuses the CheckpointPanel for this runId
   *  (Klide runs) — used to make `onReviewDiff` from a Klide row feel
   *  instant. The MissionControl consumes it on mount. */
  pendingCheckpointRunId?: string | null;
  onPendingCheckpointConsumed?: () => void;
  /** runId currently being summarised by `onSaveMemory`. Used to show a
   *  subtle spinner on the row so the user knows the model call is in
   *  flight. */
  summarizingFromRunId?: string | null;
  onBack?: () => void;
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
  const [sourceFilter, setSourceFilter] = useState<RunSource | "all" | "subagent">("all");
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [expandedSubagentParents, setExpandedSubagentParents] = useState<Set<string>>(new Set());
  const [dismissedBoardRuns, setDismissedBoardRuns] = useState<Set<string>>(() => readDismissedBoardRuns());
  // First user message of the currently selected Klide run. Used as the
  // task prompt when handing the run off to a CLI via "Open in {CLI}".
  const [firstUserMessage, setFirstUserMessage] = useState<string | null>(null);
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
      const { runs: rows, hasMore } = await fetchAgentRuns(PAGE, 0);
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
      const { runs: rows, hasMore } = await fetchAgentRuns(PAGE, nextOffset);
      setRuns((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...rows.filter((r) => !seen.has(r.id))];
      });
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
  }, []);

  // Your todos lead the board, then Klide's own conversations, then runs
  // pulled off disk from the external CLIs. A Klide chat shares one id across
  // the live in-memory convo and its on-disk transcript (the AI panel keys the
  // harness run by the convo id), so drop the convo whenever its on-disk twin
  // is loaded — the on-disk run carries the full transcript and supports
  // resume, while the convo is a lossy snapshot. The convo survives only until
  // its transcript shows up in the runs list.
  const allRuns = useMemo(() => {
    const diskIds = new Set(runs.map((r) => r.id));
    return [
      ...tasks.map(taskToRun),
      ...convos.map(convoToRun).filter((c) => !diskIds.has(c.id)),
      ...runs,
    ].filter((r) => r.kind === "task" || !dismissedBoardRuns.has(boardDismissKey(r)));
  }, [tasks, convos, runs, dismissedBoardRuns]);

  // Parent links come exclusively from the Rust spawn mapping
  // (`by_delegate`/`by_external` in list_agent_runs), which records a real
  // parentId only when Klide actually spawned the delegate. We deliberately
  // do NOT infer parents from project + time proximity: a user's own Claude
  // Code / Codex sessions share the workspace and overlap in time with Klide
  // conversations, and a fuzzy heuristic wrongly adopted them as children of
  // unrelated Klide runs. Separate conversations stay separate.
  const linkedRuns = allRuns;

  // Which source chips to show — only sources actually present.
  const presentSources = useMemo(() => {
    const set = new Set<RunSource>();
    for (const r of allRuns) set.add(r.source);
    return Array.from(set);
  }, [allRuns]);

  const filtered = useMemo(() => {
    const base = sourceFilter === "all" ? linkedRuns : linkedRuns.filter((r) => {
      if (sourceFilter === "subagent") return r.source === "claude-code" || r.source === "codex" || r.source === "opencode";
      return r.source === sourceFilter;
    });
    return base;
  }, [linkedRuns, sourceFilter]);

  const grouped = useMemo(() => {
    const by: Record<RunBoardSection, Run[]> = {
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
    }
    return by;
  }, [filtered]);

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

  const selectedTask = tasks.find((t) => t.id === selectedId) ?? null;
  // Prefer the on-disk run over the in-memory convo for the same id: it has the
  // full transcript and a working resume. The convo only renders when no
  // on-disk twin exists yet (e.g. a brand-new chat before the runs list
  // refreshes).
  const selectedConvo =
    selectedTask || runs.some((r) => r.id === selectedId)
      ? null
      : convos.find((c) => c.id === selectedId) ?? null;
  const selected =
    selectedTask || selectedConvo
      ? null
      : allRuns.find((r) => r.id === selectedId) ?? null;

  // When a Klide run (kind=run) is selected, fetch its transcript once and
  // pull out the first user message — that's the prompt we'll hand off to
  // a fresh delegate session if the user opens this run in another CLI.
  useEffect(() => {
    if (!selected || selected.source !== "klide" || selected.kind !== "run") {
      setFirstUserMessage((current) => (current === null ? current : null));
      return;
    }
    let cancelled = false;
    setFirstUserMessage((current) => (current === null ? current : null));
    fetchRunMessages(selected)
      .then((msgs) => {
        if (cancelled) return;
        const first = msgs.find((m) => m.role === "user");
        setFirstUserMessage(first?.text?.trim() || null);
      })
      .catch(() => {
        if (!cancelled) setFirstUserMessage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.source, selected?.kind]);

  // "Review Diff" from the row: scroll the Klide CheckpointPanel into
  // view. The App's `reviewDiffFromRun` sets `pendingCheckpointRunId` and
  // also selects the run via the row's onSelect. We wait for the
  // CheckpointPanel to be in the DOM (the run is now selected) and then
  // scroll. The `scrollIntoView({ block: "start" })` is a no-op on
  // non-Klide runs (their detail pane has no checkpoint anchor).
  useEffect(() => {
    if (!pendingCheckpointRunId) return;
    if (!selected || selected.id !== pendingCheckpointRunId) return;
    // Defer to the next frame so the CheckpointPanel has time to mount
    // and the layout to settle.
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(`klide-checkpoints-${pendingCheckpointRunId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      onPendingCheckpointConsumed?.();
    });
    return () => cancelAnimationFrame(raf);
  }, [pendingCheckpointRunId, selected, onPendingCheckpointConsumed]);

  function selectRun(run: Run) {
    setSelectedId(run.id);
    if (run.source === "claude-code" || run.source === "codex" || run.source === "opencode") {
      setPinnedId(run.id);
    } else {
      setPinnedId(null);
    }
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

  const attentionCount = filtered.filter(runNeedsAttention).length;
  const runningCount = grouped.running.length;
  const blockedCount = grouped.blocked.length;

  return (
    <div style={{ flex: 1, display: "flex", minWidth: 0, background: "var(--bg)" }}>
      {/* Left: the board */}
      <div
        style={{
          width: 340,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <header style={{ padding: "16px 16px 10px", borderBottom: "1px solid var(--border)" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
            }}
          >
            {onBack && (
              <button
                onClick={onBack}
                title="Back to workbench"
                aria-label="Back to workbench"
                style={{
                  width: 24, height: 24, display: "grid", placeItems: "center",
                  borderRadius: "var(--radius-xs)", border: "none", background: "transparent",
                  color: "var(--fg-subtle)", cursor: "pointer", flexShrink: 0,
                  transition: "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--fg-strong)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--fg-subtle)"; }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </button>
            )}
            <h1 style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-strong)", margin: 0 }}>
              Mission Control
            </h1>
            <span
              style={{ marginLeft: "auto", fontSize: 11, color: "var(--fg-subtle)", fontFamily: "var(--font-mono)" }}
            >
              {loading
                ? "loading…"
                : `${attentionCount} attention · ${runningCount} running · ${blockedCount} blocked`}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value as typeof sourceFilter)}
              aria-label="Filter runs"
              style={{
                fontSize: 11, padding: "3px 20px 3px 9px", borderRadius: 999,
                border: "1px solid var(--border)", color: "var(--fg-strong)",
                background: "var(--bg)", minWidth: 0, flex: 1, cursor: "pointer",
                fontFamily: "inherit", appearance: "auto",
              }}
            >
              <option value="all">All runs</option>
              <option value="subagent">Subagent</option>
              {presentSources.map((s) => (
                <option key={s} value={s}>{SOURCE_LABEL[s]}</option>
              ))}
            </select>
            <button
              onClick={() => void load()}
              title="Refresh"
              aria-label="Refresh runs"
              style={{
                marginLeft: "auto",
                width: 26,
                height: 26,
                display: "grid",
                placeItems: "center",
                color: "var(--fg-subtle)",
                borderRadius: "var(--radius-sm)",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <RefreshIcon />
            </button>
          </div>
        </header>

        <TaskComposer
          workspaceRoot={workspaceRoot}
          onAdded={(id) => setSelectedId(id)}
        />

        <AttentionQueue
          runs={filtered}
          tasks={tasks}
          onSelect={selectRun}
          onResumeKlide={onResumeKlideRun}
          onOpenInAiPanel={onOpenInAiPanel}
        />

        <div style={{ overflowY: "auto", padding: "8px 8px 16px", minHeight: 0, flex: 1 }}>
          {!loading && filtered.length === 0 && (
            <div style={{ padding: "24px 12px", fontSize: 12, color: "var(--fg-subtle)", lineHeight: 1.55 }}>
              <div style={{ color: "var(--fg-strong)", marginBottom: 5 }}>
                No matching runs.
              </div>
              Mission Control reads Claude Code and Codex session logs from your
              local machine. Start or refresh an agent session, then come back here.
            </div>
          )}
          {(() => {
            // Build parent → children map from ALL linked runs (not filtered).
            // This ensures children know their parent exists even when the parent
            // is hidden by the source filter (e.g. showing only "subagent").
            const childrenByParent = new Map<string, Run[]>();
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
                    title={BOARD_SECTION_HINT[section]}
                  >
                    {BOARD_SECTION_LABEL[section]}
                    <span style={{ opacity: 0.7 }}>{visible.length}</span>
                  </div>
                  {visible.map((run) => {
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
                    return (
                      <div
                        key={run.id}
                        style={{
                          position: "relative",
                          margin: "0 8px 10px",
                        }}
                      >
                        {/* Main conversation card — top of the stack. */}
                        <div
                          style={{
                            position: "relative",
                            zIndex: children.length + 1,
                            border: "1px solid var(--border)",
                            borderRadius: "var(--radius-md)",
                            background: "var(--bg-elevated)",
                            overflow: "hidden",
                          }}
                        >
                          <RunRow
                            run={run}
                            selected={parentSelected}
                            hasMemory={memoryRunIds.has(run.id)}
                            onSelect={() => selectRun(run)}
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
                              ) : hasChildren(run.id) ? (
                                <SubagentStackToggle
                                  count={children.length}
                                  expanded={expanded}
                                  onToggle={() => toggleSubagentStack(run.id)}
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
      <div style={{ flex: 1, minWidth: 0 }}>
        {selectedTask ? (
          <TaskDetail task={selectedTask} theme={theme} />
        ) : selectedConvo ? (
          <RunDetail
            run={convoToRun(selectedConvo)}
            messages={selectedConvo.messages}
            firstUserMessage={
              selectedConvo.messages.find((m) => m.role === "user")?.text ?? null
            }
            hasMemory={memoryRunIds.has(selectedConvo.id)}
            onOpenInAiPanel={onOpenInAiPanel}
            onResumeKlide={onResumeKlideRun}
            onReviewDiff={onReviewDiff}
            onSaveMemory={onSaveMemory}
            summarizingFromRunId={summarizingFromRunId}
          />
        ) : selected ? (
          <RunDetail
            run={selected}
            firstUserMessage={firstUserMessage}
            hasMemory={memoryRunIds.has(selected.id)}
            onOpenInAiPanel={onOpenInAiPanel}
            onResumeKlide={onResumeKlideRun}
            onReviewDiff={onReviewDiff}
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
    </div>
  );
}

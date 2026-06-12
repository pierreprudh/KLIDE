// Premium model selector — replaces the cramped native <select> in the AI
// panel composer. Glass surface, provider logo, filter input, keyboard nav.
//
// Scope: shows models for the *active* provider only (matches the current UX
// where the user picks a provider first, then a model). The design is
// glassmorphism-flavoured and works equally well for local (Ollama, MLX) and
// hosted (Anthropic, OpenAI, …) providers. For long local lists (Ollama
// users typically have 5–30 installed models) the filter trims the list as
// you type; keyboard nav covers the no-mouse case.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MLX_MODEL_PRESETS, providerName } from "../../agent/providers";
import type { ProviderId } from "../../agent/types";
import { ProviderLogo } from "./icons";
import { modelBrand } from "../../modelBrand";

type Props = {
  provider: ProviderId;
  model: string;
  availableModels: string[];
  disabled?: boolean;
  onChange: (model: string) => void;
};

/** Merged list: available models first, the current model pinned at the top
 *  if not in the list (so a user-typed custom value stays visible), then
 *  MLX presets appended for the MLX provider. */
export function modelOptionsFor(
  provider: ProviderId,
  model: string,
  availableModels: string[]
): string[] {
  const options = [...availableModels];
  if (model && !options.includes(model)) options.unshift(model);
  if (provider === "mlx") {
    for (const preset of MLX_MODEL_PRESETS) {
      if (!options.includes(preset)) options.push(preset);
    }
  }
  return options;
}

/** The selector is narrow and we want the user to recognise the model at a
 *  glance. Strip the noisy repo prefix that Hugging Face / Ollama-style
 *  tags both use. Value stays the same; only the display is shortened. */
export function modelLabel(name: string): string {
  const slash = name.indexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

function providerCaption(id: ProviderId): string {
  switch (id) {
    case "mlx": return "MLX · Apple Silicon";
    case "ollama": return "Ollama";
    case "lmstudio": return "LM Studio";
    case "llamacpp": return "llama.cpp";
    case "vllm": return "vLLM";
    case "anthropic": return "Anthropic";
    case "openai": return "OpenAI";
    case "gemini": return "Google Gemini";
    case "mistral": return "Mistral";
    case "xai": return "xAI Grok";
    case "openrouter": return "OpenRouter";
    case "claude-code": return "Claude Code";
    case "codex": return "Codex";
    case "opencode": return "OpenCode";
    // Self-hosted (custom:*) ids — caption with the endpoint's label.
    default: return providerName(id);
  }
}

export function ModelPicker({ provider, model, availableModels, disabled, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [focusIdx, setFocusIdx] = useState(0);
  /** Computed from the trigger's bounding rect at open time. The dropdown
   *  is portalled to <body> so it can escape the AI panel's
   *  `overflow: hidden` + `transform: translateZ(0)` (which together trap
   *  any `position: absolute` / `position: fixed` child of the panel). */
  const [menuPos, setMenuPos] = useState<{ bottom: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const allOptions = useMemo(
    () => modelOptionsFor(provider, model, availableModels),
    [provider, model, availableModels]
  );

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allOptions;
    return allOptions.filter((m) => m.toLowerCase().includes(q));
  }, [allOptions, filter]);

  const installedSet = useMemo(() => new Set(availableModels), [availableModels]);

  // Open: measure the trigger and store viewport coordinates for the
  // portalled dropdown. Clamp the left edge so the menu never escapes the
  // viewport on the left either.
  function openMenu() {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = 300;
    const gap = 8;
    const idealLeft = rect.right - width; // right-align to the trigger
    const left = Math.max(8, Math.min(idealLeft, window.innerWidth - width - 8));
    setMenuPos({
      bottom: Math.round(window.innerHeight - rect.top + gap),
      left: Math.round(left),
      width,
    });
    setOpen(true);
  }

  function closeMenu() {
    setOpen(false);
    setMenuPos(null);
  }

  // Close on outside click. The trigger and menu are siblings in different
  // subtrees (the menu is portalled), so we test both containers
  // explicitly.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      closeMenu();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Close on window scroll / resize — the portalled dropdown can't follow
  // the trigger across these for free, and re-positioning every frame
  // would thrash.
  //
  // The scroll handler ignores scrolls that originate *inside* the menu
  // itself: hovering a row updates focusIdx → the focused-row effect calls
  // scrollIntoView → the list container scrolls → the event bubbles to
  // window. Without this guard the menu would tear down on the very first
  // hover, which is the bug this hook exists to prevent.
  useEffect(() => {
    if (!open) return;
    function onScrollOrResize(e: Event) {
      const target = e.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      closeMenu();
    }
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  // Open: focus the filter, park the keyboard cursor on the active model.
  // Close: clear the filter so the next open starts fresh.
  useEffect(() => {
    if (!open) {
      setFilter("");
      return;
    }
    const t = window.setTimeout(() => filterRef.current?.focus(), 60);
    const idx = allOptions.indexOf(model);
    setFocusIdx(idx >= 0 ? idx : 0);
    return () => window.clearTimeout(t);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard nav lives on document so the user can drive the list with
  // the textarea-focused state from the composer.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu();
        triggerRef.current?.focus();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIdx((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIdx((i) =>
          filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length
        );
        return;
      }
      if (e.key === "Enter") {
        if (e.target instanceof HTMLInputElement) return; // let the filter input handle Enter
        e.preventDefault();
        const m = filtered[focusIdx];
        if (m) {
          onChange(m);
          closeMenu();
          triggerRef.current?.focus();
        }
        return;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, filtered, focusIdx, onChange]);

  // Keep the focused row in view when arrow-keying through a long list.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${focusIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [focusIdx, open]);

  return (
    <div style={{ position: "relative", flex: "0 1 160px", minWidth: 100, maxWidth: 220 }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (disabled) return;
          if (open) closeMenu();
          else openMenu();
        }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={model || "Select a model"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          height: 28,
          padding: "0 7px 0 6px",
          borderRadius: 14,
          border: `1px solid ${
            open
              ? "color-mix(in srgb, var(--accent) 30%, var(--panel-border))"
              : "var(--panel-border)"
          }`,
          background: open
            ? "color-mix(in srgb, var(--accent-soft) 60%, var(--panel-glass))"
            : "var(--panel-glass)",
          boxShadow: open
            ? "inset 0 1px 0 var(--panel-highlight), 0 4px 14px color-mix(in srgb, var(--accent) 14%, transparent)"
            : "inset 0 1px 0 var(--panel-highlight)",
          color: "var(--fg-strong)",
          font: "inherit",
          fontSize: 11.5,
          fontWeight: 500,
          cursor: disabled ? "default" : "pointer",
          backdropFilter: "blur(22px) saturate(1.18)",
          WebkitBackdropFilter: "blur(22px) saturate(1.18)",
          transition:
            "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
        }}
        onMouseEnter={(e) => {
          if (disabled || open) return;
          e.currentTarget.style.background =
            "color-mix(in srgb, var(--bg-hover) 70%, var(--panel-glass))";
        }}
        onMouseLeave={(e) => {
          if (open) return;
          e.currentTarget.style.background = "var(--panel-glass)";
        }}
      >
        {/* The trigger represents the *selected model*, so it wears the
            model's maker mark (LiquidAI for lfm2.5, Qwen, …) instead of the
            generic runtime logo. Falls back to the provider logo when the
            model has no recognised maker. */}
        {(() => {
          const brand = modelBrand(model);
          if (brand) {
            const Logo = brand.Logo;
            return <Logo size={13} />;
          }
          return <ProviderLogo id={provider} size={13} />;
        })()}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            textAlign: "left",
          }}
        >
          {model ? (
            modelLabel(model)
          ) : (
            <span style={{ color: "var(--fg-dim)", fontWeight: 400 }}>Select a model</span>
          )}
        </span>
        <Chevron rotated={open} />
      </button>
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label="Available models"
          className="popover-enter"
          style={{
            // Portalled to <body> with viewport coordinates so the menu
            // escapes the AI panel's `overflow: hidden` and the
            // `transform: translateZ(0)` from `.floating-panel`, which
            // would otherwise trap `position: absolute` / `position: fixed`
            // children inside the panel.
            position: "fixed",
            bottom: menuPos.bottom,
            left: menuPos.left,
            width: menuPos.width,
            maxHeight: 360,
            display: "flex",
            flexDirection: "column",
            background: "var(--panel-glass)",
            border: "1px solid var(--panel-border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--panel-shadow)",
            backdropFilter: "blur(22px) saturate(1.18)",
            WebkitBackdropFilter: "blur(22px) saturate(1.18)",
            overflow: "hidden",
            // Sit above the AI panel header (z 40) and any other
            // in-app overlay. Status bar is at 110 in some flows; 200
            // is the "this is on top" tier.
            zIndex: 200,
          }}
        >
          {/* Provider header — the logo lives here, the model count
              under it, so the menu has a clear "this is what we're
              listing" frame. */}
          <div
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 9,
              padding: "10px 12px 9px",
              borderBottom: "1px solid var(--panel-border)",
              background:
                "color-mix(in srgb, var(--panel-highlight) 30%, transparent)",
            }}
          >
            <span
              style={{
                display: "grid",
                placeItems: "center",
                width: 26,
                height: 26,
                borderRadius: 8,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                flexShrink: 0,
              }}
            >
              <ProviderLogo id={provider} size={15} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--fg-strong)",
                  letterSpacing: "-0.005em",
                }}
              >
                {providerCaption(provider)}
              </div>
              <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 1 }}>
                {availableModels.length > 0
                  ? `${availableModels.length} ${availableModels.length === 1 ? "model" : "models"} installed`
                  : "No models detected"}
              </div>
            </div>
          </div>
          {/* Filter input — keeps the menu useful when Ollama lists run
              long. Quiet background, single accent border on focus. */}
          <div
            style={{
              flexShrink: 0,
              padding: "6px 8px",
              borderBottom: "1px solid var(--panel-border)",
            }}
          >
            <input
              ref={filterRef}
              type="text"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setFocusIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filtered[focusIdx]) {
                  e.preventDefault();
                  onChange(filtered[focusIdx]);
                  closeMenu();
                  triggerRef.current?.focus();
                }
              }}
              placeholder="Filter models…"
              aria-label="Filter models"
              style={{
                width: "100%",
                height: 26,
                padding: "0 8px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                background: "var(--bg)",
                color: "var(--fg-strong)",
                font: "inherit",
                fontSize: 11.5,
                outline: "none",
                transition:
                  "border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor =
                  "color-mix(in srgb, var(--accent) 50%, var(--border))";
                e.currentTarget.style.background = "var(--bg-elevated)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = "var(--border)";
                e.currentTarget.style.background = "var(--bg)";
              }}
            />
          </div>
          {/* Model list — two-line rows for clarity. The active row
              uses the soft accent tint, hover uses bg-hover, and the
              keyboard cursor parks on the focused row regardless of
              hover. */}
          <div ref={listRef} style={{ flex: 1, overflow: "auto", padding: 4 }}>
            {filtered.length === 0 ? (
              <div
                style={{
                  padding: "24px 14px",
                  textAlign: "center",
                  color: "var(--fg-dim)",
                  fontSize: 11.5,
                }}
              >
                {filter.trim()
                  ? "No models match your filter"
                  : "No models available"}
              </div>
            ) : (
              filtered.map((m, idx) => {
                const active = m === model;
                const focused = idx === focusIdx;
                const isStored = !installedSet.has(m);
                const showSecondary = m !== modelLabel(m);
                return (
                  <button
                    key={m}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-idx={idx}
                    onClick={() => {
                      onChange(m);
                      closeMenu();
                      triggerRef.current?.focus();
                    }}
                    onMouseEnter={() => setFocusIdx(idx)}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "7px 9px",
                      border: "none",
                      borderRadius: "var(--radius-sm)",
                      background: active
                        ? "color-mix(in srgb, var(--accent-soft) 80%, transparent)"
                        : focused
                          ? "var(--bg-hover)"
                          : "transparent",
                      color: "var(--fg-strong)",
                      textAlign: "left",
                      cursor: "pointer",
                      transition:
                        "background var(--motion-fast) var(--ease-out)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      {/* Per-row maker mark, so a long mixed list reads at a
                          glance. Falls back to the runtime/provider logo when
                          the model has no recognised maker. Selection is shown
                          by the row highlight, so no check icon is needed. */}
                      <span style={{ width: 20, height: 20, flexShrink: 0, display: "grid", placeItems: "center" }}>
                        {(() => {
                          const brand = modelBrand(m);
                          if (brand) {
                            const Logo = brand.Logo;
                            return <Logo size={18} />;
                          }
                          return <ProviderLogo id={provider} size={17} />;
                        })()}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 12,
                          fontWeight: active ? 550 : 500,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {modelLabel(m)}
                      </span>
                      {isStored && (
                        <span
                          title="Saved locally but not currently reported by the provider"
                          style={{
                            fontSize: 9,
                            color: "var(--warning)",
                            fontWeight: 600,
                            letterSpacing: 0.04,
                            textTransform: "uppercase",
                            flexShrink: 0,
                          }}
                        >
                          Stored
                        </span>
                      )}
                    </div>
                    {showSecondary && (
                      <div
                        style={{
                          marginLeft: 26,
                          marginTop: 1,
                          fontSize: 10,
                          fontFamily: "var(--font-mono)",
                          color: "var(--fg-dim)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {m}
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function Chevron({ rotated }: { rotated: boolean }) {
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
      style={{
        flexShrink: 0,
        color: "var(--fg-dim)",
        transform: rotated ? "rotate(180deg)" : "none",
        transition: "transform var(--motion-fast) var(--ease-out)",
      }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}


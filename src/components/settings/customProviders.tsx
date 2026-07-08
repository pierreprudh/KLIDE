// Custom providers — self-hosted OpenAI-wire endpoints and custom CLI
// agents: row lists, add/edit dialogs, and the two settings blocks that
// host them. Extracted from SettingsPanel.tsx.

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Z } from "../../zLayers";
import { ChevronDown, ProviderLogo } from "../ai/icons";
import type { ProviderId } from "../../agent/types";
import {
  customIdFromLabel,
  refreshCustomProviders,
  removeCustomProvider,
  upsertCustomProvider,
  type CustomProvider,
} from "../../customProviders";
import {
  customCliIdFromLabel,
  refreshCustomCli,
  removeCustomCli,
  upsertCustomCli,
  type CustomCli,
} from "../../customCli";
import { GhostButton, IconButton, LinkButton, Panel, PencilIcon, Row, StatusText, TrashIcon } from "./controls";
import type { KeyStatus } from "./apiKeys";

// Self-hosted (custom) OpenAI-compatible endpoints. Config (label, base URL,
// default model) persists to the Rust store; the bearer token rides the same
// keychain path as the built-in keys. Adding one here makes it appear in the
// AI panel's provider dropdown under "Self-hosted".
// One self-hosted endpoint: a click-to-expand row. Expanding fetches the
// live model list (which doubles as a connection + auth test) and the key
// status. Clicking a model pins it as the endpoint's default.
export function CustomEndpointRow({
  endpoint,
  busy,
  onEdit,
  onRemove,
  onSetDefault,
}: {
  endpoint: CustomProvider;
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onSetDefault: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<KeyStatus>({ hasKey: false, source: "none" });
  const [hoveredModel, setHoveredModel] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const ks = await invoke<KeyStatus>("ai_provider_key_status", {
        provider: endpoint.id,
      }).catch(() => ({ hasKey: false, source: "none" }) as KeyStatus);
      setKeyStatus(ks);
      const m = await invoke<string[]>("ai_provider_models", { provider: endpoint.id });
      setModels(m);
    } catch (e) {
      setError(String(e));
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, [endpoint.id]);

  function toggle() {
    const next = !open;
    setOpen(next);
    // Lazy-load the detail the first time it opens.
    if (next && models === null && !loading) void loadDetail();
  }

  // Show just the host in the collapsed subtitle; full URL in the detail.
  let host = endpoint.baseUrl;
  try {
    host = new URL(endpoint.baseUrl).host;
  } catch {
    /* keep raw */
  }
  const count = models?.length ?? 0;

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        className="klide-settings-row"
        style={{ cursor: "pointer" }}
      >
        <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              display: "grid",
              placeItems: "center",
              color: "var(--fg-dim)",
              transform: open ? "rotate(0deg)" : "rotate(-90deg)",
              transition: "transform 120ms ease",
              flexShrink: 0,
            }}
          >
            <ChevronDown />
          </span>
          <span style={{ display: "grid", placeItems: "center", color: "var(--fg-subtle)", flexShrink: 0 }}>
            <ProviderLogo id={endpoint.id as ProviderId} size={15} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="klide-row-title">{endpoint.label}</div>
            <div className="klide-row-description">
              {host}
              {endpoint.defaultModel ? ` · ${endpoint.defaultModel}` : ""}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <IconButton title="Edit endpoint" onClick={onEdit}>
            <PencilIcon />
          </IconButton>
          <IconButton title="Remove endpoint" danger onClick={onRemove}>
            <TrashIcon />
          </IconButton>
        </div>
      </div>

      {open && (
        <div style={{ padding: "0 18px 14px 40px", display: "grid", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {loading ? (
              <StatusText tone="idle">Checking…</StatusText>
            ) : error ? (
              <StatusText tone="warn">Unreachable</StatusText>
            ) : (
              <StatusText tone="ok">{`${count} ${count === 1 ? "model" : "models"}`}</StatusText>
            )}
            {keyStatus.source === "keychain" ? (
              <StatusText tone="ok">Token saved</StatusText>
            ) : keyStatus.source === "env" ? (
              <StatusText tone="ok">Token from env</StatusText>
            ) : keyStatus.source === "reference" ? (
              keyStatus.hasKey ? (
                <StatusText tone="ok">Token from .env</StatusText>
              ) : (
                <StatusText tone="warn">Reference unresolved</StatusText>
              )
            ) : (
              <StatusText tone="idle">No token</StatusText>
            )}
          </div>
          <div style={{ fontSize: 12, color: "var(--fg-subtle)", wordBreak: "break-all" }}>
            {endpoint.baseUrl}
          </div>
          {error && (
            <div style={{ fontSize: 12, color: "var(--danger)", wordBreak: "break-word" }}>
              {error}
            </div>
          )}
          {models && models.length > 0 && (
            <div style={{ display: "grid", gap: 7 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--fg-dim)", letterSpacing: "0.02em" }}>
                  Models{" "}
                  <span style={{ fontWeight: 400, color: "var(--fg-subtle)" }}>{count}</span>
                </span>
                <span style={{ fontSize: 10.5, color: "var(--fg-subtle)" }}>click to set default</span>
              </div>
              <div style={{ display: "grid", gap: 2 }}>
                {models.map((m) => {
                  const isDefault = m === endpoint.defaultModel;
                  const hovered = hoveredModel === m;
                  const colon = m.indexOf(":");
                  const name = colon >= 0 ? m.slice(0, colon) : m;
                  const tag = colon >= 0 ? m.slice(colon + 1) : null;
                  return (
                    <button
                      key={m}
                      disabled={busy}
                      onClick={() => onSetDefault(m)}
                      onMouseEnter={() => setHoveredModel(m)}
                      onMouseLeave={() => setHoveredModel((cur) => (cur === m ? null : cur))}
                      title={isDefault ? "Default model" : "Set as default"}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        width: "100%",
                        textAlign: "left",
                        padding: "7px 10px",
                        borderRadius: "var(--radius-sm)",
                        cursor: busy ? "default" : "pointer",
                        border: `1px solid ${isDefault ? "color-mix(in srgb, var(--accent) 38%, var(--border))" : "transparent"}`,
                        background: isDefault ? "var(--accent-soft)" : hovered ? "var(--bg-hover)" : "transparent",
                        transition: "background 0.12s ease, border-color 0.12s ease",
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 15,
                          height: 15,
                          flexShrink: 0,
                          borderRadius: "50%",
                          display: "grid",
                          placeItems: "center",
                          border: `1px solid ${isDefault ? "var(--accent)" : "var(--border)"}`,
                          background: isDefault ? "var(--accent)" : "transparent",
                        }}
                      >
                        {isDefault && (
                          <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                            <path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                      <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 7, flex: 1 }}>
                        <span
                          style={{
                            fontFamily: "var(--font-mono, monospace)",
                            fontSize: 12,
                            color: isDefault ? "var(--accent)" : "var(--fg-strong)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {name}
                        </span>
                        {tag && (
                          <span
                            style={{
                              flexShrink: 0,
                              fontSize: 10.5,
                              color: "var(--fg-subtle)",
                              fontFamily: "var(--font-mono, monospace)",
                            }}
                          >
                            {tag}
                          </span>
                        )}
                      </span>
                      {isDefault ? (
                        <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 600, color: "var(--accent)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                          Default
                        </span>
                      ) : hovered ? (
                        <span style={{ flexShrink: 0, fontSize: 10.5, color: "var(--fg-subtle)" }}>
                          Set default
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div>
            <LinkButton onClick={() => void loadDetail()}>Refresh</LinkButton>
          </div>
        </div>
      )}
    </div>
  );
}

export function CustomEndpointsBlock({
  onProviderKeyChange,
}: {
  onProviderKeyChange?: (id: string) => void;
}) {
  const [endpoints, setEndpoints] = useState<CustomProvider[]>([]);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEndpoints(await refreshCustomProviders());
    } catch {
      /* store unreadable → treat as empty */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function resetForm() {
    setAdding(false);
    setEditingId(null);
    setLabel("");
    setBaseUrl("");
    setDefaultModel("");
    setToken("");
    setError(null);
  }

  const formOpen = adding || editingId !== null;

  // Escape closes the add/edit modal, matching the app's other dialogs.
  useEffect(() => {
    if (!formOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") resetForm();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [formOpen]);

  async function save() {
    if (busy || !label.trim() || !baseUrl.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Keep an existing id stable on edit; mint one from the label on add.
      const id = editingId ?? customIdFromLabel(label);
      const trimmedToken = token.trim();
      // Self-hosted endpoints don't use the keychain: the token field holds a
      // `${VAR}` reference resolved from the project's .env (or env var). A
      // raw token has nowhere to go, so reject it with a hint. Blank means
      // "leave whatever's saved alone" — preserve the existing reference.
      if (trimmedToken && !trimmedToken.startsWith("$")) {
        setError("Use a ${VAR} reference (e.g. ${DEV_TOKEN}) and put the value in your .env.");
        setBusy(false);
        return;
      }
      const existing = editingId ? endpoints.find((e) => e.id === editingId) : undefined;
      const tokenRef = trimmedToken || existing?.tokenRef;
      await upsertCustomProvider({
        id,
        label: label.trim(),
        baseUrl: baseUrl.trim(),
        defaultModel: defaultModel.trim(),
        tokenRef,
      });
      onProviderKeyChange?.(id);
      resetForm();
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await removeCustomProvider(id);
      if (editingId === id) resetForm();
      await load();
      onProviderKeyChange?.(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Pin a model from the live list as this endpoint's default (used when
  // the provider is first selected in the AI panel).
  async function setDefault(ep: CustomProvider, model: string) {
    if (busy || ep.defaultModel === model) return;
    setBusy(true);
    try {
      await upsertCustomProvider({ ...ep, defaultModel: model });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(ep: CustomProvider) {
    resetForm();
    setEditingId(ep.id);
    setLabel(ep.label);
    setBaseUrl(ep.baseUrl);
    setDefaultModel(ep.defaultModel);
    // A `${VAR}` reference is safe to show; a keychain token is not, so it
    // stays blank ("leave alone"). This lets the user see/edit the reference.
    setToken(ep.tokenRef ?? "");
  }

  return (
    <>
      {endpoints.length > 0 && (
        <Panel>
          {endpoints.map((ep) => (
            <CustomEndpointRow
              key={ep.id}
              endpoint={ep}
              busy={busy}
              onEdit={() => startEdit(ep)}
              onRemove={() => void remove(ep.id)}
              onSetDefault={(model) => void setDefault(ep, model)}
            />
          ))}
        </Panel>
      )}

      {/* Add lives below the container as its own button, not nested in the
          endpoint list — the list is the container, adding is a separate act. */}
      <button
        onClick={() => { resetForm(); setAdding(true); }}
        className="klide-button"
        style={{
          width: "100%",
          marginTop: endpoints.length > 0 ? 10 : 0,
          justifyContent: "center",
          minHeight: 40,
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
          background: "var(--bg-hover)",
          color: "var(--fg-strong)",
          fontSize: 12.5,
        }}
      >
        + Add self-hosted endpoint
      </button>

      {/* The add/edit form is a centered modal, not an inline panel row —
          a focused surface for entering URL + token, dimming the list. */}
      {formOpen &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={editingId ? "Edit endpoint" : "Add self-hosted endpoint"}
            onClick={resetForm}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: Z.modalRaised,
              display: "grid",
              placeItems: "center",
              background: "rgba(0,0,0,0.30)",
              backdropFilter: "blur(3px)",
            }}
          >
            <div
              className="floating-panel"
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(440px, calc(100vw - 80px))",
                borderRadius: "var(--radius-lg)",
                display: "grid",
                gap: 10,
                padding: "20px 22px",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)" }}>
                {editingId ? "Edit endpoint" : "Add self-hosted endpoint"}
              </div>
              <input
                value={label}
                placeholder="Name (e.g. My Gateway)"
                onChange={(e) => setLabel(e.target.value)}
                aria-label="Endpoint name"
                className="klide-field"
                disabled={editingId !== null}
                autoFocus
                style={{ height: 34, padding: "0 12px" }}
              />
              <input
                value={baseUrl}
                placeholder="Base URL (https://llm.example.com/v1)"
                onChange={(e) => setBaseUrl(e.target.value)}
                aria-label="Base URL"
                className="klide-field"
                autoComplete="off"
                style={{ height: 34, padding: "0 12px" }}
              />
              <input
                value={defaultModel}
                placeholder="Default model (optional, e.g. devstral-small-2:24b)"
                onChange={(e) => setDefaultModel(e.target.value)}
                aria-label="Default model"
                className="klide-field"
                autoComplete="off"
                style={{ height: 34, padding: "0 12px" }}
              />
              <input
                // A `${VAR}` reference is non-secret config, so it's shown
                // plainly — there's no token to mask (self-hosted endpoints
                // never store a literal token in the app).
                type="text"
                value={token}
                placeholder={editingId ? "Token reference ${VAR} (blank = keep current)" : "Token reference, e.g. ${DEV_TOKEN} (optional)"}
                onChange={(e) => setToken(e.target.value)}
                aria-label="Bearer token reference"
                className="klide-field"
                autoComplete="off"
                spellCheck={false}
                style={{ height: 34, padding: "0 12px" }}
              />
              <div style={{ fontSize: 11, lineHeight: 1.5, color: "var(--fg-subtle)" }}>
                The bearer token is a reference like <code>{"${DEV_TOKEN}"}</code> —
                put the value in your project's <code>.env</code>{" "}
                (<code>DEV_TOKEN=…</code>), or in <code>~/.klide/.env</code> as a global
                fallback. Klide stores only the reference, never the token, so there's
                no keychain prompt; keep the <code>.env</code> gitignored.
                <br />
                Requests use the OpenAI wire format. The per-model context window in
                Inference settings does not apply here — for a self-hosted Ollama
                endpoint, set the context length server-side (e.g. <code>num_ctx</code>{" "}
                in a Modelfile), or the model's default is used.
              </div>
              {error && (
                <div style={{ fontSize: 12, color: "var(--danger)" }}>{error}</div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <GhostButton onClick={resetForm}>Cancel</GhostButton>
                <LinkButton onClick={() => void save()}>
                  {busy ? "…" : editingId ? "Update" : "Add endpoint"}
                </LinkButton>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

export function parseModelList(value: string): string[] {
  return value
    .split(/[\n,]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

export const cliControlBaseStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
};

export function CliDialogHeader({ editing }: { editing: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
      <span style={{ display: "grid", placeItems: "center", width: 28, height: 28, borderRadius: "var(--radius-md)", color: "var(--accent)", background: "var(--accent-soft)", flexShrink: 0 }}>
        <ProviderLogo id={"cli:custom" as ProviderId} size={15} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg-strong)" }}>
          {editing ? "Edit CLI agent" : "Add CLI agent"}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--fg-subtle)", marginTop: 1 }}>
          Run any terminal agent inside Klide.
        </div>
      </div>
    </div>
  );
}

export function CliField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: 5, minWidth: 0 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: "var(--fg-subtle)" }}>{label}</span>
      {children}
    </label>
  );
}

export function CliTextInput({
  label,
  value,
  placeholder,
  onChange,
  disabled,
  autoFocus,
  mono,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  mono?: boolean;
}) {
  return (
    <CliField label={label}>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="klide-field"
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        style={{
          ...cliControlBaseStyle,
          height: 34,
          padding: "0 11px",
          fontFamily: mono ? "var(--font-mono)" : undefined,
          fontSize: mono ? 12.5 : undefined,
        }}
      />
    </CliField>
  );
}

export function CliTextarea({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <CliField label={label}>
      <textarea
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="klide-field"
        spellCheck={false}
        rows={2}
        style={{
          ...cliControlBaseStyle,
          minHeight: 58,
          padding: "8px 10px",
          resize: "vertical",
          fontFamily: "var(--font-mono)",
          fontSize: 12.5,
          lineHeight: 1.45,
        }}
      />
    </CliField>
  );
}

export function CliPlaceholderChips() {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", color: "var(--fg-dim)", fontSize: 10.5 }}>
      <code>{"{task}"}</code>
      <code>{"{model}"}</code>
      <code>{"{resume}"}</code>
    </div>
  );
}

export function CliOptionsSection({
  defaultModel,
  models,
  loginCommand,
  onDefaultModelChange,
  onModelsChange,
  onLoginCommandChange,
}: {
  defaultModel: string;
  models: string;
  loginCommand: string;
  onDefaultModelChange: (value: string) => void;
  onModelsChange: (value: string) => void;
  onLoginCommandChange: (value: string) => void;
}) {
  return (
    <div style={{ display: "grid", gap: 10, minWidth: 0, padding: "10px 0 0", borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, minWidth: 0 }}>
        <CliTextInput
          label="Default model"
          value={defaultModel}
          placeholder="optional"
          onChange={onDefaultModelChange}
        />
        <CliTextInput
          label="Login command"
          value={loginCommand}
          placeholder="optional"
          onChange={onLoginCommandChange}
          mono
        />
      </div>
      <CliTextarea
        label="Model choices"
        value={models}
        placeholder="one per line or comma-separated"
        onChange={onModelsChange}
      />
      <CliPlaceholderChips />
    </div>
  );
}

export function CliAgentDialog({
  editing,
  label,
  commandTemplate,
  defaultModel,
  models,
  loginCommand,
  showOptions,
  busy,
  error,
  onLabelChange,
  onCommandTemplateChange,
  onDefaultModelChange,
  onModelsChange,
  onLoginCommandChange,
  onToggleOptions,
  onCancel,
  onSave,
}: {
  editing: boolean;
  label: string;
  commandTemplate: string;
  defaultModel: string;
  models: string;
  loginCommand: string;
  showOptions: boolean;
  busy: boolean;
  error: string | null;
  onLabelChange: (value: string) => void;
  onCommandTemplateChange: (value: string) => void;
  onDefaultModelChange: (value: string) => void;
  onModelsChange: (value: string) => void;
  onLoginCommandChange: (value: string) => void;
  onToggleOptions: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const canSave = Boolean(label.trim() && commandTemplate.trim());

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={editing ? "Edit CLI agent" : "Add CLI agent"}
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: Z.modalRaised,
        display: "grid",
        placeItems: "center",
        padding: 16,
        background: "rgba(0,0,0,0.30)",
        backdropFilter: "blur(3px)",
        overflowY: "auto",
      }}
    >
      <div
        className="floating-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(460px, calc(100vw - 32px))",
          maxWidth: "100%",
          maxHeight: "calc(100vh - 32px)",
          overflowY: "auto",
          overflowX: "hidden",
          boxSizing: "border-box",
          borderRadius: "var(--radius-lg)",
          display: "grid",
          gap: 14,
          padding: "18px",
        }}
      >
        <CliDialogHeader editing={editing} />

        <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
          <CliTextInput
            label="Name"
            value={label}
            placeholder="Cursor Agent"
            onChange={onLabelChange}
            disabled={editing}
            autoFocus
          />
          <CliTextInput
            label="Command"
            value={commandTemplate}
            placeholder="cursor-agent {task}"
            onChange={onCommandTemplateChange}
            mono
          />
        </div>

        <button
          type="button"
          aria-expanded={showOptions}
          onClick={onToggleOptions}
          style={{
            width: "100%",
            minWidth: 0,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            height: 30,
            padding: "0 2px",
            border: "none",
            background: "transparent",
            color: "var(--fg-subtle)",
            cursor: "pointer",
            font: "inherit",
            fontSize: 12,
          }}
        >
          <span>Options</span>
          <span style={{ display: "grid", placeItems: "center", transform: showOptions ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 120ms ease" }}>
            <ChevronDown />
          </span>
        </button>

        {showOptions && (
          <CliOptionsSection
            defaultModel={defaultModel}
            models={models}
            loginCommand={loginCommand}
            onDefaultModelChange={onDefaultModelChange}
            onModelsChange={onModelsChange}
            onLoginCommandChange={onLoginCommandChange}
          />
        )}

        {error && <div style={{ fontSize: 12, color: "var(--danger)" }}>{error}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap", paddingTop: 2 }}>
          <GhostButton onClick={onCancel}>Cancel</GhostButton>
          <LinkButton onClick={onSave} disabled={busy || !canSave}>
            {busy ? "Saving" : editing ? "Save" : "Add"}
          </LinkButton>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function CustomCliAgentsBlock({
  onChange,
}: {
  onChange?: (agents: CustomCli[]) => void;
}) {
  const [agents, setAgents] = useState<CustomCli[]>([]);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [commandTemplate, setCommandTemplate] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [models, setModels] = useState("");
  const [loginCommand, setLoginCommand] = useState("");
  const [showOptions, setShowOptions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await refreshCustomCli();
      setAgents(next);
      onChange?.(next);
    } catch {
      setAgents([]);
      onChange?.([]);
    }
  }, [onChange]);

  useEffect(() => {
    void load();
  }, [load]);

  function resetForm() {
    setAdding(false);
    setEditingId(null);
    setLabel("");
    setCommandTemplate("");
    setDefaultModel("");
    setModels("");
    setLoginCommand("");
    setShowOptions(false);
    setError(null);
  }

  const formOpen = adding || editingId !== null;

  useEffect(() => {
    if (!formOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") resetForm();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [formOpen]);

  function startAdd() {
    resetForm();
    setAdding(true);
  }

  function startEdit(agent: CustomCli) {
    resetForm();
    setEditingId(agent.id);
    setLabel(agent.label);
    setCommandTemplate(agent.commandTemplate);
    setDefaultModel(agent.defaultModel);
    setModels((agent.models ?? []).join("\n"));
    setLoginCommand(agent.loginCommand ?? "");
    setShowOptions(Boolean(agent.defaultModel || agent.models?.length || agent.loginCommand));
  }

  async function save() {
    if (busy || !label.trim() || !commandTemplate.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const id = editingId ?? customCliIdFromLabel(label);
      await upsertCustomCli({
        id,
        label: label.trim(),
        commandTemplate: commandTemplate.trim(),
        defaultModel: defaultModel.trim(),
        models: parseModelList(models),
        loginCommand: loginCommand.trim() || undefined,
      });
      resetForm();
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await removeCustomCli(id);
      if (editingId === id) resetForm();
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {agents.length > 0 && (
        <Panel>
          {agents.map((agent) => (
            <div key={agent.id} className="klide-settings-row">
              <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ color: "var(--fg-subtle)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <ProviderLogo id={agent.id as ProviderId} size={15} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="klide-row-title">{agent.label}</div>
                  <div className="klide-row-description" style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {agent.commandTemplate}
                    {agent.defaultModel ? ` · ${agent.defaultModel}` : ""}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <IconButton title="Edit CLI agent" onClick={() => startEdit(agent)}>
                  <PencilIcon />
                </IconButton>
                <IconButton title="Remove CLI agent" danger onClick={() => void remove(agent.id)}>
                  <TrashIcon />
                </IconButton>
              </div>
            </div>
          ))}
        </Panel>
      )}
      <Panel>
        <Row
          title="Custom CLI agent"
          description="Add any terminal coding agent with a command template. Use {task}, {model}, and {resume} placeholders."
          control={<LinkButton onClick={startAdd}>Add agent</LinkButton>}
          leading={<ProviderLogo id={"cli:custom" as ProviderId} />}
        />
      </Panel>
      {error && <div style={{ fontSize: 12, color: "var(--danger)" }}>{error}</div>}

      {formOpen && (
        <CliAgentDialog
          editing={editingId !== null}
          label={label}
          commandTemplate={commandTemplate}
          defaultModel={defaultModel}
          models={models}
          loginCommand={loginCommand}
          showOptions={showOptions}
          busy={busy}
          error={error}
          onLabelChange={setLabel}
          onCommandTemplateChange={setCommandTemplate}
          onDefaultModelChange={setDefaultModel}
          onModelsChange={setModels}
          onLoginCommandChange={setLoginCommand}
          onToggleOptions={() => setShowOptions((v) => !v)}
          onCancel={resetForm}
          onSave={() => void save()}
        />
      )}
    </>
  );
}


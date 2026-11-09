// Design mode — throwaway prototype. The live UI on a canvas: point at an
// element and change it directly, or pin a comment on it, then send the whole
// review to Kit as one turn. Nothing here writes files; "Send to Kit" shows
// the task a real Work turn would receive.
//
// Built from Klide's own vocabulary: `.menu-glass` islands, the soft-fill
// recipe for active controls, hairlines over shadows, tokens only.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { Icon } from "../src/icons";
import { Cursor } from "@phosphor-icons/react/dist/csr/Cursor";
import { HandPointing } from "@phosphor-icons/react/dist/csr/HandPointing";
import { ChatTeardrop } from "@phosphor-icons/react/dist/csr/ChatTeardrop";
import { ArrowCounterClockwise } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { Sun } from "@phosphor-icons/react/dist/csr/Sun";
import { Moon } from "@phosphor-icons/react/dist/csr/Moon";
import { ArrowUp } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import catalog from "./design-feedback/catalog.json";

type Theme = "klide-light" | "sage-garden-dark";
type Tool = "select" | "comment" | "use";
type Target = { el: Element; component: string; where: string };
type Edit = Target & { kind: "edit"; id: number; prop: string; label: string; from: string; to: string };
type Comment = Target & { kind: "comment"; id: number; n: number; text: string; resolved: boolean };
type Item = Edit | Comment;
type Picked = Target & { style: Record<string, string>; text: string | null };

const SCENARIOS = (catalog as { scenarios: { id: string; label: string }[] }).scenarios;
const SIZES = [{ w: 1440, h: 900, label: "Wide" }, { w: 900, h: 700, label: "Compact" }];
const FG = ["--fg-strong", "--fg", "--fg-muted", "--fg-dim", "--accent", "--danger"];
const BG = ["--bg", "--bg-panel", "--bg-elevated", "--bg-hover", "--bg-selected", "--accent-soft"];
const FS = ["--fs-xs", "--fs-base", "--fs-md", "--fs-lg", "--fs-xl"];
const RADII = ["--radius-xs", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl"];
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const GLIDE = 420; // ms — layout moves (canvas, inspector, review list)
const INSPECTOR = 294; // island width + its gap

// ── element facts ────────────────────────────────────────────────────────────
function componentOf(el: Element): string {
  const key = Object.keys(el).find(k => k.startsWith("__reactFiber$"));
  let fiber = key ? (el as unknown as Record<string, any>)[key] : null;
  const names: string[] = [];
  while (fiber && names.length < 2) {
    const t = fiber.type;
    const name = typeof t === "function" ? t.displayName || t.name : t && typeof t === "object" ? t.displayName || t.render?.name : null;
    if (name && /^[A-Z]/.test(name) && names[0] !== name) names.push(name);
    fiber = fiber.return;
  }
  return names.reverse().join(" › ") || "Element";
}
function describe(el: Element): string {
  const aria = el.getAttribute("aria-label");
  const text = (el.textContent ?? "").trim().replace(/\s+/g, " ");
  const hint = aria ?? (text ? `“${text.slice(0, 32)}${text.length > 32 ? "…" : ""}”` : "");
  return `${el.tagName.toLowerCase()}${hint ? " " + hint : ""}`;
}
const leafText = (el: Element) => (el.children.length === 0 && (el.textContent ?? "").trim() ? el.textContent : null);
function readStyle(el: Element): Record<string, string> {
  const s = getComputedStyle(el);
  return { paddingTop: s.paddingTop, paddingRight: s.paddingRight, gap: s.gap === "normal" ? "0px" : s.gap, fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color, backgroundColor: s.backgroundColor, borderRadius: s.borderTopLeftRadius };
}
const target = (el: Element): Target => ({ el, component: componentOf(el), where: describe(el) });
const px = (v: string) => Math.round(parseFloat(v) || 0);
const kebab = (p: string) => p.replace(/[A-Z]/g, m => "-" + m.toLowerCase());

function App() {
  const [scenario, setScenario] = useState("tools-and-review");
  const [theme, setTheme] = useState<Theme>("klide-light");
  const [size, setSize] = useState(SIZES[1]);
  const [tool, setTool] = useState<Tool>("select");
  const [hover, setHover] = useState<DOMRect | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [draft, setDraft] = useState<Target | null>(null); // a comment being written
  const [items, setItems] = useState<Item[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [, setTick] = useState(0); // re-measure rects on scroll
  const [shown, setShown] = useState(false); // the framed page fades in once it is ready
  const [instant, setInstant] = useState(false); // rings follow scroll without easing
  const scrollTimer = useRef(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const toolRef = useRef(tool); toolRef.current = tool;
  const inspecting = picked !== null;
  const nextId = useRef(1);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useLayoutEffect(() => {
    const fit = () => { const r = stage.current?.getBoundingClientRect(); if (r) setScale(Math.min(1, (r.width - 96 - (inspecting ? INSPECTOR : 0)) / size.w, (r.height - 200) / size.h)); };
    fit(); const ro = new ResizeObserver(fit); if (stage.current) ro.observe(stage.current); return () => ro.disconnect();
  }, [size, inspecting]);

  const onLoad = useCallback(() => {
    const doc = frame.current?.contentDocument, win = frame.current?.contentWindow;
    if (!doc || !win) return;
    const FrameElement = (win as unknown as { Element: typeof Element }).Element;
    const at = (e: Event): Element | null => (e.target instanceof FrameElement ? e.target : null);
    doc.addEventListener("mousemove", e => { const el = at(e); setHover(toolRef.current !== "use" && el ? el.getBoundingClientRect() : null); }, true);
    doc.addEventListener("mouseleave", () => setHover(null));
    for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"]) {
      doc.addEventListener(type, e => {
        if (toolRef.current === "use") return;
        e.preventDefault(); e.stopPropagation();
        const el = at(e); if (type !== "click" || !el) return;
        if (toolRef.current === "comment") { setDraft(target(el)); setPicked(null); }
        else { setPicked({ ...target(el), style: readStyle(el), text: leafText(el) }); setDraft(null); }
      }, true);
    }
    doc.addEventListener("scroll", () => {
      setInstant(true); setTick(t => t + 1);
      clearTimeout(scrollTimer.current); scrollTimer.current = window.setTimeout(() => setInstant(false), 140);
    }, true);
    const api = (win as unknown as { __designFeedback?: { ready?: Promise<void> } }).__designFeedback;
    const reveal = () => requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    (api?.ready ?? Promise.resolve()).then(reveal, reveal);
    doc.addEventListener("keydown", e => keys(e as KeyboardEvent), true);
  }, []);

  function keys(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]")) return;
    if (e.key === "Escape") { setPicked(null); setDraft(null); }
    if (e.key === "v") setTool("select");
    if (e.key === "c") setTool("comment");
    if (e.key === "u") setTool("use");
  }
  useEffect(() => { const k = (e: KeyboardEvent) => keys(e); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, []);
  useEffect(() => { if (tool === "use") { setHover(null); setPicked(null); setDraft(null); } if (tool === "comment") setPicked(null); }, [tool]);
  useEffect(() => { setPicked(null); setDraft(null); setHover(null); setShown(false); }, [scenario, theme]);

  function apply(prop: string, value: string, label: string) {
    const p = picked; if (!p) return;
    const el = p.el as HTMLElement;
    const prior = items.find((i): i is Edit => i.kind === "edit" && i.el === el && i.prop === prop);
    const from = prior?.from ?? (prop === "text" ? el.textContent ?? "" : el.style.getPropertyValue(kebab(prop)) || p.style[prop] || "");
    if (prop === "text") el.textContent = value; else el.style.setProperty(kebab(prop), value);
    setItems(is => [...is.filter(i => i !== prior), { kind: "edit", id: nextId.current++, el, component: p.component, where: p.where, prop, label, from, to: value }]);
    setPicked({ ...p, style: readStyle(el), text: prop === "text" ? value : p.text });
  }
  function undo(i: Item) {
    if (i.kind === "edit") {
      const el = i.el as HTMLElement;
      if (i.prop === "text") el.textContent = i.from; else el.style.removeProperty(kebab(i.prop));
      if (picked?.el === el) setPicked({ ...picked, style: readStyle(el), text: leafText(el) });
    }
    setItems(is => is.filter(x => x.id !== i.id));
  }
  function addComment(text: string) {
    if (!draft || !text.trim()) return;
    const n = items.filter(i => i.kind === "comment").length + 1;
    setItems(is => [...is, { ...draft, kind: "comment", id: nextId.current++, n, text: text.trim(), resolved: false }]);
    setDraft(null);
  }
  function send(extra: string) {
    setSent(taskFor(items.filter(i => i.kind === "edit" || !i.resolved), extra));
  }

  const src = `/preview/design-feedback.html?${new URLSearchParams({ desktop: "1", scenario, theme })}`;
  const edits = items.filter(i => i.kind === "edit").length;
  const comments = items.filter((i): i is Comment => i.kind === "comment");
  // An element from a page the frame has since reloaded stays "connected" to its dead document.
  const live = (el: Element | undefined | null) => (el && el.isConnected && el.ownerDocument === frame.current?.contentDocument ? el.getBoundingClientRect() : null);
  const pickedBox = live(picked?.el), draftBox = live(draft?.el);
  const showHover = hover && !(pickedBox && hover.x === pickedBox.x && hover.y === pickedBox.y && hover.width === pickedBox.width);

  return (
    <div ref={stage} style={{ position: "relative", height: "100%", overflow: "hidden", background: "var(--bg-panel)" }}>
      {/* toolbar */}
      <div className="menu-glass" style={{ position: "absolute", top: 14, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 4, padding: 4, borderRadius: 12, zIndex: 3 }}>
        <ScenarioMenu value={scenario} onChange={setScenario} />
        <Divider />
        <Soft label="Select · V" on={tool === "select"} onClick={() => setTool("select")}><Icon as={Cursor} size={16} /></Soft>
        <Soft label="Comment · C" on={tool === "comment"} onClick={() => setTool("comment")}><Icon as={ChatTeardrop} size={16} /></Soft>
        <Soft label="Use the UI · U" on={tool === "use"} onClick={() => setTool("use")}><Icon as={HandPointing} size={16} /></Soft>
        <Divider />
        {SIZES.map(s => <Soft key={s.w} label={`${s.w} × ${s.h}`} on={size === s} onClick={() => setSize(s)} wide>{s.label}</Soft>)}
        <Soft label="Theme" onClick={() => setTheme(t => (t === "klide-light" ? "sage-garden-dark" : "klide-light"))}><Icon as={theme === "klide-light" ? Moon : Sun} size={16} /></Soft>
      </div>

      {/* canvas */}
      <div style={{ position: "absolute", top: 64, bottom: 120, left: 0, right: inspecting ? INSPECTOR : 0, display: "grid", placeItems: "center", transition: `right ${GLIDE}ms ${EASE}` }}>
        <div style={{ width: size.w * scale, height: size.h * scale, transition: `width ${GLIDE}ms ${EASE}, height ${GLIDE}ms ${EASE}` }}>
          <div style={{ position: "relative", width: size.w, height: size.h, transform: `scale(${scale})`, transformOrigin: "0 0", transition: `transform ${GLIDE}ms ${EASE}`, border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden", background: "var(--bg)" }}>
            <iframe key={src} ref={frame} src={src} onLoad={onLoad} title="Live surface" style={{ width: "100%", height: "100%", border: 0, display: "block", cursor: tool === "comment" ? "crosshair" : undefined, opacity: shown ? 1 : 0, transition: `opacity 260ms ${EASE}` }} />
            <Ring r={tool !== "use" && showHover ? hover : null} dashed instant={instant} />
            <Ring r={pickedBox ?? draftBox} instant={instant} />
            {comments.filter(c => !c.resolved).map(c => { const r = live(c.el); return r && <Pin key={c.id} n={c.n} r={r} scale={scale} onClick={() => setReviewOpen(true)} />; })}
          </div>
        </div>
      </div>

      {/* comment composer, anchored to the element */}
      {draft && draftBox && frame.current && (
        <Anchored frame={frame.current} r={draftBox} scale={scale}>
          <CommentBox where={draft} onCancel={() => setDraft(null)} onSave={addComment} />
        </Anchored>
      )}

      {/* inspector island */}
      <div className="menu-glass" style={{ position: "absolute", top: 14, right: 14, bottom: 14, width: 280, borderRadius: 14, overflow: "hidden auto", zIndex: 2,
        opacity: picked ? 1 : 0, transform: picked ? "none" : "translateX(16px)", pointerEvents: picked ? "auto" : "none", transition: `opacity 260ms ${EASE}, transform ${GLIDE}ms ${EASE}` }}>
        <Held value={picked}>{p => <Inspector picked={p} apply={apply} close={() => setPicked(null)} />}</Held>
      </div>

      {/* review bar — the composer family */}
      <ReviewBar items={items} edits={edits} comments={comments} open={reviewOpen} setOpen={setReviewOpen} undo={undo}
        resolve={c => setItems(is => is.map(i => (i.id === c.id ? { ...c, resolved: !c.resolved } : i)))}
        focus={i => { if (i.kind === "edit") setPicked({ ...i, style: readStyle(i.el), text: leafText(i.el) }); (i.el as HTMLElement).scrollIntoView?.({ block: "center", behavior: "smooth" }); }}
        send={send} hint={tool === "use" ? "Using the UI — V to select, C to comment" : tool === "comment" ? "Click anything to leave a comment" : "Click anything to change it"} />

      {sent && <SentSheet task={sent} close={() => setSent(null)} />}
    </div>
  );
}

function taskFor(items: Item[], extra: string) {
  const groups = new Map<string, string[]>();
  for (const i of items) {
    const line = i.kind === "edit" ? `- ${i.where}: ${i.label.toLowerCase()} ${i.from || "(unset)"} → ${i.to}` : `- ${i.where}: ${i.text}`;
    groups.set(i.component, [...(groups.get(i.component) ?? []), line]);
  }
  return [
    "Apply this design review to the source. Direct edits are exact; comments are requests. Prefer tokens from src/styles/tokens.css over raw values, keep Klide's inline-style convention, and touch only what is listed.",
    ...[...groups].map(([k, v]) => `${k}\n${v.join("\n")}`),
    extra.trim() && `Also: ${extra.trim()}`,
  ].filter(Boolean).join("\n\n");
}

// ── surfaces ────────────────────────────────────────────────────────────────
function Inspector({ picked, apply, close }: { picked: Picked; apply: (prop: string, value: string, label: string) => void; close: () => void }) {
  const s = picked.style;
  return (
    <div style={{ fontSize: "var(--fs-base)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "14px 14px 12px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "var(--fg-strong)", fontWeight: 700 }}>{picked.component}</div>
          <div style={{ color: "var(--fg-dim)", fontSize: "var(--fs-xs)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{picked.where}</div>
        </div>
        <Soft label="Close · Esc" onClick={close}><Icon as={X} size={14} /></Soft>
      </div>
      {picked.text !== null && (
        <Group title="Text">
          <textarea key={picked.where} defaultValue={picked.text} rows={2} onBlur={e => e.target.value !== picked.text && apply("text", e.target.value, "Text")} style={{ ...field, width: "100%", resize: "vertical" }} />
        </Group>
      )}
      <Group title="Spacing">
        <Pair>
          <Num label="Vertical" value={px(s.paddingTop)} onChange={v => { apply("paddingTop", `${v}px`, "Padding top"); apply("paddingBottom", `${v}px`, "Padding bottom"); }} />
          <Num label="Horizontal" value={px(s.paddingRight)} onChange={v => { apply("paddingLeft", `${v}px`, "Padding left"); apply("paddingRight", `${v}px`, "Padding right"); }} />
          <Num label="Gap" value={px(s.gap)} onChange={v => apply("gap", `${v}px`, "Gap")} />
          <Num label="Radius" value={px(s.borderRadius)} onChange={v => apply("borderRadius", `${v}px`, "Radius")} />
        </Pair>
        <Steps tokens={RADII} current={s.borderRadius} prop="radius" onPick={t => apply("borderRadius", `var(${t})`, "Radius")} />
      </Group>
      <Group title="Type">
        <Steps tokens={FS} current={s.fontSize} prop="fs" onPick={t => apply("fontSize", `var(${t})`, "Font size")} />
        <div style={{ display: "flex", gap: 2, marginTop: 6 }}>
          {[["400", "Regular"], ["700", "Bold"]].map(([w, l]) => <Soft key={w} wide on={(Number(s.fontWeight) >= 600 ? "700" : "400") === w} onClick={() => apply("fontWeight", w, "Weight")}>{l}</Soft>)}
        </div>
      </Group>
      <Group title="Colour">
        <Swatches tokens={FG} current={s.color} onPick={t => apply("color", `var(${t})`, "Text colour")} />
        <div style={{ height: 8 }} />
        <Swatches tokens={BG} current={s.backgroundColor} onPick={t => apply("backgroundColor", `var(${t})`, "Background")} />
      </Group>
    </div>
  );
}

function ReviewBar({ items, edits, comments, open, setOpen, undo, resolve, focus, send, hint }: {
  items: Item[]; edits: number; comments: Comment[]; open: boolean; setOpen: (o: boolean) => void; undo: (i: Item) => void;
  resolve: (c: Comment) => void; focus: (i: Item) => void; send: (extra: string) => void; hint: string;
}) {
  const [extra, setExtra] = useState("");
  const openComments = comments.filter(c => !c.resolved).length;
  const summary = [edits && `${edits} edit${edits > 1 ? "s" : ""}`, openComments && `${openComments} comment${openComments > 1 ? "s" : ""}`].filter(Boolean).join(" · ");
  const canSend = edits + openComments > 0 || extra.trim().length > 0;
  return (
    <div style={{ position: "absolute", left: "50%", bottom: 16, transform: "translateX(-50%)", width: "min(640px, calc(100% - 340px))", zIndex: 3 }}>
      <div className="menu-glass" style={{ borderRadius: 16, overflow: "hidden" }}>
        <div style={{ maxHeight: open && items.length ? 260 : 0, opacity: open && items.length ? 1 : 0, overflowY: "auto", transition: `max-height ${GLIDE}ms ${EASE}, opacity 260ms ${EASE}` }}>
          <div style={{ padding: "8px 8px 0" }}>
            {items.map(i => (
              <div key={i.id} onClick={() => focus(i)} className="dm-row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 8px", borderRadius: 10, cursor: "pointer", opacity: i.kind === "comment" && i.resolved ? 0.5 : 1 }}>
                <span style={{ width: 18, textAlign: "center", color: i.kind === "comment" ? "var(--accent)" : "var(--fg-dim)", fontSize: "var(--fs-xs)", fontWeight: 700 }}>{i.kind === "comment" ? i.n : "–"}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: i.kind === "comment" && i.resolved ? "line-through" : undefined }}>
                    {i.kind === "edit" ? `${i.label} ${i.from || "—"} → ${i.to}` : i.text}
                  </div>
                  <div style={{ color: "var(--fg-dim)", fontSize: "var(--fs-xs)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.component} · {i.where}</div>
                </div>
                {i.kind === "comment" && <Soft label={i.resolved ? "Reopen" : "Resolve"} onClick={e => { e?.stopPropagation(); resolve(i); }}><Icon as={Check} size={14} /></Soft>}
                <Soft label={i.kind === "edit" ? "Undo" : "Delete"} onClick={e => { e?.stopPropagation(); undo(i); }}><Icon as={i.kind === "edit" ? ArrowCounterClockwise : X} size={14} /></Soft>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8, padding: 10, borderTop: open && items.length ? "1px solid var(--panel-border)" : "1px solid transparent", transition: `border-color 260ms ${EASE}` }}>
          <textarea value={extra} onChange={e => setExtra(e.target.value)} rows={1} placeholder={summary ? "Anything else for Kit…" : hint}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && canSend) { e.preventDefault(); send(extra); } }}
            style={{ flex: 1, resize: "none", border: 0, outline: "none", background: "transparent", color: "var(--fg)", font: "inherit", fontSize: "var(--fs-md)", padding: "6px 4px", lineHeight: 1.4 }} />
          {items.length > 0 && (
            <button onClick={() => setOpen(!open)} className="dm-soft" style={{ ...plain, display: "inline-flex", alignItems: "center", gap: 4, padding: "6px 8px", borderRadius: 10, color: "var(--fg-muted)", fontSize: "var(--fs-base)" }}>
              {summary || "Review"} <Icon as={CaretDown} size={12} style={{ transform: open ? "rotate(180deg)" : "none", transition: `transform 220ms ${EASE}` }} />
            </button>
          )}
          <button disabled={!canSend} onClick={() => send(extra)} aria-label="Send to Kit" title="Send to Kit"
            style={{ ...plain, width: 32, height: 32, borderRadius: 999, display: "grid", placeItems: "center", background: "var(--control-primary-bg)", color: "var(--control-primary-fg)", opacity: canSend ? 1 : 0.35, cursor: canSend ? "pointer" : "default" }}>
            <Icon as={ArrowUp} size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function CommentBox({ where, onCancel, onSave }: { where: Target; onCancel: () => void; onSave: (t: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="menu-glass" style={{ width: 280, borderRadius: 12, padding: 10 }}>
      <div style={{ color: "var(--fg-dim)", fontSize: "var(--fs-xs)", marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{where.component} · {where.where}</div>
      <textarea autoFocus value={text} onChange={e => setText(e.target.value)} rows={3} placeholder="What should change here?"
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSave(text); } if (e.key === "Escape") onCancel(); }}
        style={{ ...field, width: "100%", resize: "none", background: "transparent", border: 0, padding: 2, fontSize: "var(--fs-md)" }} />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 4 }}>
        <Soft wide onClick={onCancel}>Cancel</Soft>
        <button disabled={!text.trim()} onClick={() => onSave(text)} style={{ ...plain, padding: "5px 12px", borderRadius: 10, background: "var(--control-primary-bg)", color: "var(--control-primary-fg)", opacity: text.trim() ? 1 : 0.4 }}>Comment</button>
      </div>
    </div>
  );
}

function SentSheet({ task, close }: { task: string; close: () => void }) {
  return (
    <div onClick={close} style={{ position: "fixed", inset: 0, background: "var(--modal-scrim, rgba(0,0,0,.2))", display: "grid", placeItems: "center", zIndex: 10, animation: `dm-fade 200ms ${EASE}` }}>
      <div onClick={e => e.stopPropagation()} className="menu-glass" style={{ width: 560, maxWidth: "calc(100vw - 32px)", borderRadius: 16, padding: 20 }}>
        <div style={{ fontWeight: 700, color: "var(--fg-strong)", fontSize: "var(--fs-md)" }}>Sent to Kit</div>
        <p style={{ color: "var(--fg-muted)", margin: "6px 0 12px", lineHeight: 1.5 }}>In Klide this starts a Work turn in the conversation beside the canvas. Kit's edits arrive as normal diff cards; accept them and the canvas reloads on the real code, your review cleared.</p>
        <pre style={{ margin: 0, padding: 12, border: "1px solid var(--panel-border)", borderRadius: 10, whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)", color: "var(--fg-muted)", maxHeight: 300, overflow: "auto" }}>{task}</pre>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}><Soft wide onClick={close}>Close</Soft></div>
      </div>
    </div>
  );
}

// ── parts ────────────────────────────────────────────────────────────────────
/** Keeps rendering the last value while a surface fades out, so it never empties mid-animation. */
function Held<T>({ value, children }: { value: T | null; children: (v: T) => ReactNode }) {
  const last = useRef<T | null>(null);
  if (value !== null) last.current = value;
  return last.current === null ? null : <>{children(last.current)}</>;
}
const plain: CSSProperties = { border: 0, background: "transparent", cursor: "pointer", font: "inherit" };
const field: CSSProperties = { boxSizing: "border-box", minWidth: 0, background: "transparent", color: "var(--fg)", border: "1px solid var(--panel-border)", borderRadius: 8, padding: "5px 8px", font: "inherit", fontSize: "var(--fs-base)", outline: "none" };

function Soft({ label, on, wide, onClick, children }: { label?: string; on?: boolean; wide?: boolean; onClick: (e?: React.MouseEvent) => void; children: ReactNode }) {
  return <button title={label} aria-label={label} aria-pressed={on} onClick={e => onClick(e)} className={on ? "dm-soft on" : "dm-soft"}
    style={{ ...plain, height: 28, minWidth: 28, padding: wide ? "0 10px" : 0, display: "inline-grid", placeItems: "center", borderRadius: 10, color: on ? "var(--fg-strong)" : "var(--fg-muted)", fontSize: "var(--fs-base)" }}>{children}</button>;
}
const Divider = () => <span style={{ width: 1, height: 16, background: "var(--panel-border)", margin: "0 4px" }} />;
function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section style={{ padding: "10px 14px 14px", borderTop: "1px solid var(--panel-border)" }}><div style={{ color: "var(--fg-dim)", fontSize: "var(--fs-xs)", marginBottom: 8 }}>{title}</div>{children}</section>;
}
const Pair = ({ children }: { children: ReactNode }) => <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 8 }}>{children}</div>;
function Num({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return <label style={{ display: "flex", alignItems: "center", gap: 6, ...field, padding: "4px 8px" }}>
    <span style={{ color: "var(--fg-dim)", fontSize: "var(--fs-xs)", flex: 1 }}>{label}</span>
    <input key={value} type="number" min={0} defaultValue={value} onChange={e => e.target.value !== "" && onChange(Number(e.target.value))}
      style={{ width: 40, border: 0, outline: "none", background: "transparent", color: "var(--fg)", font: "inherit", textAlign: "right" }} />
  </label>;
}
function Steps({ tokens, current, prop, onPick }: { tokens: string[]; current: string; prop: string; onPick: (t: string) => void }) {
  const root = getComputedStyle(document.documentElement);
  return <div style={{ display: "flex", gap: 2, marginTop: 8, padding: 2, borderRadius: 10, border: "1px solid var(--panel-border)" }}>
    {tokens.map(t => <button key={t} title={t} onClick={() => onPick(t)} className={root.getPropertyValue(t).trim() === current ? "dm-soft on" : "dm-soft"}
      style={{ ...plain, flex: 1, height: 24, borderRadius: 8, color: "var(--fg-muted)", fontSize: "var(--fs-xs)" }}>{t.replace(`--${prop}-`, "")}</button>)}
  </div>;
}
function Swatches({ tokens, current, onPick }: { tokens: string[]; current: string; onPick: (t: string) => void }) {
  return <div style={{ display: "flex", gap: 6 }}>
    {tokens.map(t => <button key={t} title={t} aria-label={t} onClick={() => onPick(t)}
      style={{ width: 24, height: 24, borderRadius: 999, background: `var(${t})`, border: "1px solid var(--panel-border)", boxShadow: same(t, current) ? "0 0 0 2px var(--bg-elevated), 0 0 0 3.5px var(--accent)" : "none", cursor: "pointer", padding: 0, transition: `box-shadow 160ms ${EASE}` }} />)}
  </div>;
}
function same(token: string, rgb: string) {
  const probe = document.createElement("span"); probe.style.color = `var(${token})`; document.body.appendChild(probe);
  const c = getComputedStyle(probe).color; probe.remove(); return c === rgb;
}
/** One ring that glides from element to element and fades when it has none. */
function Ring({ r, dashed, instant }: { r: DOMRect | null; dashed?: boolean; instant?: boolean }) {
  const last = useRef<DOMRect | null>(null);
  if (r) last.current = r;
  const box = r ?? last.current;
  if (!box) return null;
  const move = instant ? "none" : `transform ${dashed ? 160 : 260}ms ${EASE}, width ${dashed ? 160 : 260}ms ${EASE}, height ${dashed ? 160 : 260}ms ${EASE}`;
  return <div style={{ position: "absolute", left: 0, top: 0, transform: `translate(${box.left - 2}px, ${box.top - 2}px)`, width: box.width + 4, height: box.height + 4, pointerEvents: "none", borderRadius: 6,
    border: `1.5px ${dashed ? "dashed" : "solid"} var(--accent)`, background: dashed ? "color-mix(in srgb, var(--accent) 5%, transparent)" : "transparent",
    opacity: r ? 1 : 0, transition: `${move === "none" ? "" : move + ", "}opacity 180ms ${EASE}`, willChange: "transform" }} />;
}
function Pin({ n, r, scale, onClick }: { n: number; r: DOMRect; scale: number; onClick: () => void }) {
  const s = 22 / scale;
  return <button onClick={onClick} aria-label={`Comment ${n}`} style={{ ...plain, position: "absolute", left: r.right - s / 2, top: r.top - s / 2, width: s, height: s, borderRadius: "999px 999px 999px 2px",
    background: "var(--accent)", color: "var(--control-primary-fg)", fontSize: 11 / scale, fontWeight: 700, display: "grid", placeItems: "center", boxShadow: `0 0 0 ${2 / scale}px var(--bg)`, animation: `dm-pop 320ms ${EASE}` }}>{n}</button>;
}
function Anchored({ frame, r, scale, children }: { frame: HTMLIFrameElement; r: DOMRect; scale: number; children: ReactNode }) {
  const f = frame.getBoundingClientRect();
  const left = Math.min(window.innerWidth - 300, f.left + r.right * scale + 12);
  const top = Math.max(70, Math.min(window.innerHeight - 220, f.top + r.top * scale));
  return <div style={{ position: "fixed", left, top, zIndex: 5, animation: `dm-in 220ms ${EASE}` }}>{children}</div>;
}
function ScenarioMenu({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <label className="dm-soft" style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 6, height: 28, padding: "0 10px", borderRadius: 10, color: "var(--fg)", fontSize: "var(--fs-base)", cursor: "pointer" }}>
    <span style={{ color: "var(--fg-dim)" }}>AiPanel</span> {SCENARIOS.find(s => s.id === value)?.label}
    <Icon as={CaretDown} size={12} />
    <select value={value} onChange={e => onChange(e.target.value)} aria-label="State" style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}>
      {SCENARIOS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
    </select>
  </label>;
}

const css = document.createElement("style"); // eslint-disable-line
css.textContent = `
  .dm-soft, .dm-row { transition: background-color 160ms ${EASE}, color 160ms ${EASE}, opacity 200ms ${EASE}; }
  .dm-row { animation: dm-in 260ms ${EASE} both; }
  .dm-soft:hover, .dm-row:hover { background: var(--menu-row-hover); }
  .dm-soft.on { background: var(--menu-row-active); }
  @keyframes dm-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  @keyframes dm-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes dm-pop { from { opacity: 0; transform: scale(.6); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;
document.head.appendChild(css);

createRoot(document.getElementById("root")!).render(<App />);

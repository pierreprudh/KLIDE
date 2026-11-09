// Design mode — your running UI on a canvas. Select an element and change it
// directly, or pin a comment on it; the review bar collects both and sends
// them to Kit as one Work turn in the conversation that opened this mode.
//
// The page is the project's own dev server, framed through the loopback proxy
// in design_canvas.rs, which injects the picker (design_agent.js). Everything
// about the page arrives as messages from that picker — rects, picked
// elements, the page's own tokens — so this works for any local web app, not
// only Klide. Live edits are inline styles in the framed page: nothing touches
// a file until Kit applies the review through the normal diff cards.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SelectToolIcon, CommentToolIcon, UseToolIcon, CloseIcon, SendIcon, CheckIcon, UndoIcon, ChevronIcon } from "../../icons";
import { Z } from "../../zLayers";
import { closeDesignCanvas, designCanvasCandidates, devServerStatus, openDesignCanvas, runDevServer, stopDevServer, type DesignCanvas } from "../../ipc/design";
import { listWorkspaceDir, readWorkspaceTextFile } from "../../workspaceFs";
import { errMessage } from "../../errors";
import { designDockWidth, designTask, devCommand, sortTokens, type Rect, type ReviewItem, type Facts, type PageTokens } from "./designReview";

type Tool = "select" | "comment" | "use";
type Size = { id: string; label: string; w: number | null; h: number | null };
const SIZES: Size[] = [
  { id: "fit", label: "Fit", w: null, h: null },
  { id: "wide", label: "1440", w: 1440, h: 900 },
  { id: "compact", label: "900", w: 900, h: 700 },
  { id: "phone", label: "390", w: 390, h: 844 },
];
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const GLIDE = 420;
const INSPECTOR = 294;
const urlKey = (root: string) => `klide.design.url:${root}`;
const readUrl = (root: string) => { try { return localStorage.getItem(urlKey(root)) ?? ""; } catch { return ""; } };
const saveUrl = (root: string, url: string) => { try { localStorage.setItem(urlKey(root), url); } catch { /* best effort */ } };

type Props = {
  workspaceRoot: string;
  /** Hidden but kept mounted, so an unsent review survives closing. */
  open: boolean;
  onClose: () => void;
  /** Send the review into the conversation that opened Design mode. */
  onSend: (task: string) => void;
  /** Distance from the window's right edge — the conversation decides, so the
   *  dock opens beside it rather than over it. */
  right?: number;
};

export function DesignMode({ workspaceRoot, open, onClose, onSend, right = 8 }: Props) {
  const [address, setAddress] = useState(() => readUrl(workspaceRoot));
  const [canvas, setCanvas] = useState<DesignCanvas | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // The project's own dev command, and the server Design mode started with it.
  const [runCommand, setRunCommand] = useState<string | null>(null);
  const [server, setServer] = useState<"idle" | "starting" | "running">("idle");
  const [serverLog, setServerLog] = useState("");
  const [tool, setTool] = useState<Tool>("select");
  const [size, setSize] = useState<Size>(SIZES[0]);
  const [hover, setHover] = useState<Rect | null>(null);
  const [picked, setPicked] = useState<Facts | null>(null);
  const [draft, setDraft] = useState<Facts | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [rects, setRects] = useState<Record<number, Rect | null>>({});
  const [epoch, setEpoch] = useState(0); // one per page load; element ids are per load
  const [tokens, setTokens] = useState<PageTokens>({});
  const [shown, setShown] = useState(false);
  const [instant, setInstant] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [stageBox, setStageBox] = useState({ w: 0, h: 0 });
  const [dockWidth, setDockWidth] = useState(() => designDockWidth(window.innerWidth));
  useEffect(() => { const r = () => setDockWidth(designDockWidth(window.innerWidth)); window.addEventListener("resize", r); return () => window.removeEventListener("resize", r); }, []);
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const scrollTimer = useRef(0);
  const nextId = useRef(1);
  const inspecting = picked !== null;

  const post = useCallback((msg: Record<string, unknown>) => {
    if (canvas) frame.current?.contentWindow?.postMessage({ klideDesign: canvas.token, ...msg }, canvas.origin);
  }, [canvas]);

  const connect = useCallback(async (url: string) => {
    const target = url.trim();
    if (!target) return;
    setConnecting(true); setProblem(null);
    try {
      const next = await openDesignCanvas(target.includes("://") ? target : `http://${target}`);
      setShown(false); setCanvas(next); saveUrl(workspaceRoot, target); setAddress(target);
    } catch (e) {
      setProblem(errMessage(e));
    } finally { setConnecting(false); }
  }, [workspaceRoot]);

  // First open: reconnect to the remembered server, or look for one.
  const tried = useRef(false);
  useEffect(() => {
    if (!open || tried.current) return;
    tried.current = true;
    void (async () => {
      const [found, command] = await Promise.all([
        designCanvasCandidates().catch(() => [] as string[]),
        Promise.all([readWorkspaceTextFile(workspaceRoot, "package.json"), listWorkspaceDir(workspaceRoot, workspaceRoot)])
          .then(([pkg, entries]) => devCommand(pkg, entries.map(e => e.name)))
          .catch(() => null),
      ]);
      setCandidates(found); setRunCommand(command);
      const remembered = readUrl(workspaceRoot);
      if (remembered) void connect(remembered);
      else if (found.length === 1) void connect(found[0]);
    })();
  }, [open, connect, workspaceRoot]);
  const ownsServer = useRef(false);
  useEffect(() => () => {
    void closeDesignCanvas().catch(() => {});
    if (ownsServer.current) void stopDevServer().catch(() => {});
  }, []);

  // Run the project: start its dev script, wait for the address it prints, open it.
  const runApp = useCallback(async () => {
    if (!runCommand) return;
    setProblem(null); setServer("starting"); setServerLog("");
    try { await runDevServer(workspaceRoot, runCommand); ownsServer.current = true; }
    catch (e) { setServer("idle"); setProblem(errMessage(e)); return; }
    const started = Date.now();
    const poll = async (): Promise<void> => {
      const status = await devServerStatus().catch(() => null);
      if (!status) return;
      setServerLog(status.tail.trim().split("\n").slice(-1)[0] ?? "");
      if (!status.running) {
        setServer("idle"); ownsServer.current = false;
        setProblem(`${runCommand} stopped${status.exitCode !== null ? ` (exit ${status.exitCode})` : ""}: ${status.tail.trim().split("\n").slice(-3).join(" · ")}`);
        return;
      }
      if (status.url) { setServer("running"); await connect(status.url); return; }
      if (Date.now() - started > 90_000) { setServer("running"); setProblem("The server is running but hasn't printed an address — type it above."); return; }
      setTimeout(() => void poll(), 600);
    };
    void poll();
  }, [runCommand, workspaceRoot, connect]);
  const stopApp = useCallback(async () => {
    await stopDevServer().catch(() => {});
    ownsServer.current = false; setServer("idle"); setCanvas(null); setShown(false);
  }, []);

  // Messages from the picker inside the page.
  useEffect(() => {
    if (!canvas) return;
    const onMessage = (e: MessageEvent) => {
      const m = e.data;
      if (e.origin !== canvas.origin || e.source !== frame.current?.contentWindow || !m || m.klideDesign !== canvas.token) return;
      switch (m.type) {
        case "ready":
          setEpoch(n => n + 1); setPicked(null); setDraft(null); setHover(null); setRects({});
          setTokens(m.tokens ?? {}); setShown(true);
          break;
        case "tokens": setTokens(m.tokens ?? {}); break;
        case "hover": setHover(m.rect); break;
        case "scrolling":
          setInstant(true); clearTimeout(scrollTimer.current);
          scrollTimer.current = window.setTimeout(() => setInstant(false), 140);
          break;
        case "rects": setHover(null); setRects(Object.fromEntries((m.rects as { id: number; rect: Rect | null }[]).map(r => [r.id, r.rect]))); break;
        case "pick":
          if (m.tool === "comment") { setDraft(m.element); setPicked(null); }
          else { setPicked(m.element); setDraft(null); }
          break;
        case "facts": setPicked(p => (p && p.id === m.element.id ? m.element : p)); break;
        case "key":
          if (m.key === "Escape") escape();
          else setTool(({ v: "select", c: "comment", u: "use" } as const)[m.key as "v" | "c" | "u"]);
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  useEffect(() => { post({ type: "tool", tool }); if (tool !== "select") setPicked(null); if (tool === "use") { setDraft(null); setHover(null); } }, [tool, post, epoch]);
  const watched = useMemo(() => [...new Set([picked?.id, draft?.id, ...items.filter(i => i.kind === "comment" && !i.resolved && i.epoch === epoch).map(i => i.elementId)].filter((x): x is number => typeof x === "number"))], [picked, draft, items, epoch]);
  useEffect(() => { post({ type: "watch", ids: watched }); }, [watched, post]);

  function escape() {
    setPicked(p => { if (p) return null; setDraft(d => { if (!d) onClose(); return null; }); return null; });
  }
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      if (e.key === "Escape" && !(e.target as HTMLElement)?.closest?.("[role=dialog]")) { e.preventDefault(); escape(); }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "v") setTool("select");
      if (e.key === "c") setTool("comment");
      if (e.key === "u") setTool("use");
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  useLayoutEffect(() => {
    const measure = () => { const r = stage.current?.getBoundingClientRect(); if (r) setStageBox({ w: r.width, h: r.height }); };
    measure(); const ro = new ResizeObserver(measure); if (stage.current) ro.observe(stage.current); return () => ro.disconnect();
  }, [open]);
  const availW = Math.max(200, stageBox.w - 32 - (inspecting ? INSPECTOR : 0));
  const availH = Math.max(200, stageBox.h - 60 - 112 - 16);
  const pageW = size.w ?? availW, pageH = size.h ?? availH;
  const scale = size.w ? Math.min(1, availW / pageW, availH / pageH) : 1;

  function apply(prop: string, value: string, label: string) {
    const p = picked; if (!p) return;
    const prior = items.find((i): i is Extract<ReviewItem, { kind: "edit" }> => i.kind === "edit" && i.epoch === epoch && i.elementId === p.id && i.prop === prop);
    const from = prior?.from ?? (prop === "text" ? p.text ?? "" : (p.style as Record<string, string>)[camel(prop)] ?? "");
    post({ type: "set", id: p.id, prop, value });
    setItems(is => [...is.filter(i => i !== prior), { kind: "edit", id: nextId.current++, epoch, elementId: p.id, component: p.component, where: p.where, prop, label, from, to: value }]);
  }
  function undo(i: ReviewItem) {
    if (i.kind === "edit" && i.epoch === epoch) post({ type: "unset", id: i.elementId, prop: i.prop, from: i.from });
    setItems(is => is.filter(x => x.id !== i.id));
  }
  function addComment(text: string) {
    if (!draft || !text.trim()) return;
    const n = items.filter(i => i.kind === "comment").length + 1;
    setItems(is => [...is, { kind: "comment", id: nextId.current++, epoch, elementId: draft.id, component: draft.component, where: draft.where, n, text: text.trim(), resolved: false }]);
    setDraft(null);
  }
  function send(extra: string) {
    onSend(designTask(items, extra, canvas ? address : null));
    for (const i of items) if (i.kind === "edit" && i.epoch === epoch) post({ type: "unset", id: i.elementId, prop: i.prop, from: i.from });
    setItems([]); setReviewOpen(false); setPicked(null); onClose();
  }

  const sorted = useMemo(() => sortTokens(tokens), [tokens]);
  const box = (id: number | undefined) => (id === undefined ? null : rects[id] ?? null);
  const pickedBox = box(picked?.id) ?? picked?.rect ?? null;
  const draftBox = box(draft?.id) ?? draft?.rect ?? null;
  const sameBox = hover && pickedBox && hover.x === pickedBox.x && hover.y === pickedBox.y && hover.w === pickedBox.w;

  return createPortal(
    <aside aria-label="Design mode" aria-hidden={!open} style={{ position: "fixed", top: 8, bottom: 8, right, width: Math.min(dockWidth, window.innerWidth - right - 8), zIndex: Z.dock,
      background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", overflow: "hidden", fontFamily: "var(--font-ui)", color: "var(--fg)",
      transform: open ? "none" : "translateX(calc(100% + 24px))", opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none",
      transition: `transform ${GLIDE}ms ${EASE}, opacity 260ms ${EASE}, right ${GLIDE}ms ${EASE}`, willChange: "transform" }}>
      <div ref={stage} style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        {/* toolbar */}
        <div className="menu-glass" style={{ position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 4, padding: 4, borderRadius: 12, zIndex: 3, maxWidth: "calc(100% - 28px)" }}>
          <form onSubmit={e => { e.preventDefault(); void connect(address); }} style={{ display: "flex" }}>
            <input value={address} onChange={e => setAddress(e.target.value)} list="klide-design-candidates" spellCheck={false} aria-label="Dev server address" placeholder="localhost:5173"
              style={{ width: "clamp(110px, 16vw, 220px)", height: 28, padding: "0 10px", border: 0, borderRadius: 10, background: "var(--menu-row-hover)", color: "var(--fg)", font: "inherit", fontSize: "var(--fs-base)", outline: "none" }} />
            <datalist id="klide-design-candidates">{candidates.map(c => <option key={c} value={c} />)}</datalist>
          </form>
          <Divider />
          <Soft label="Select · V" on={tool === "select"} onClick={() => setTool("select")}><SelectToolIcon size={16} /></Soft>
          <Soft label="Comment · C" on={tool === "comment"} onClick={() => setTool("comment")}><CommentToolIcon size={16} /></Soft>
          <Soft label="Use the page · U" on={tool === "use"} onClick={() => setTool("use")}><UseToolIcon size={16} /></Soft>
          <Divider />
          {SIZES.map(s => <Soft key={s.id} label={s.w ? `${s.w} × ${s.h}` : "Fill the canvas"} on={size.id === s.id} onClick={() => setSize(s)} wide>{s.label}</Soft>)}
          {server !== "idle" && <><Divider /><Soft wide label={`Stop ${runCommand ?? "the dev server"}`} onClick={() => void stopApp()}>Stop</Soft></>}
          <Divider />
          <Soft label="Close · Esc" onClick={onClose}><CloseIcon size={15} /></Soft>
        </div>

        {/* canvas */}
        <div style={{ position: "absolute", top: 60, bottom: 112, left: 0, right: inspecting ? INSPECTOR : 0, display: "grid", placeItems: "center", transition: `right ${GLIDE}ms ${EASE}` }}>
          {canvas ? (
            <div style={{ width: pageW * scale, height: pageH * scale, transition: `width ${GLIDE}ms ${EASE}, height ${GLIDE}ms ${EASE}` }}>
              <div style={{ position: "relative", width: pageW, height: pageH, transform: `scale(${scale})`, transformOrigin: "0 0", transition: `transform ${GLIDE}ms ${EASE}, width ${GLIDE}ms ${EASE}, height ${GLIDE}ms ${EASE}`, border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden", background: "var(--bg)" }}>
                <iframe ref={frame} src={canvas.url} title="Your running app" style={{ width: "100%", height: "100%", border: 0, display: "block", opacity: shown ? 1 : 0, transition: `opacity 260ms ${EASE}` }} />
                <Ring r={tool !== "use" && hover && !sameBox ? hover : null} dashed instant={instant} />
                <Ring r={pickedBox ?? draftBox} instant={instant} />
                {items.map(i => {
                  if (i.kind !== "comment" || i.resolved || i.epoch !== epoch) return null;
                  const r = rects[i.elementId];
                  return r ? <Pin key={i.id} n={i.n} r={r} scale={scale} onClick={() => setReviewOpen(true)} /> : null;
                })}
              </div>
            </div>
          ) : (
            <Empty connecting={connecting} problem={problem} candidates={candidates} onPick={c => void connect(c)}
              runCommand={runCommand} server={server} serverLog={serverLog} onRun={() => void runApp()} />
          )}
        </div>

        {draft && draftBox && frame.current && (
          <Anchored frame={frame.current} r={draftBox} scale={scale}>
            <CommentBox target={draft} onCancel={() => setDraft(null)} onSave={addComment} />
          </Anchored>
        )}

        {/* inspector island */}
        <div className="menu-glass" style={{ position: "absolute", top: 60, right: 10, bottom: 10, width: INSPECTOR - 14, borderRadius: 14, overflow: "hidden auto", zIndex: 2,
          opacity: picked ? 1 : 0, transform: picked ? "none" : "translateX(16px)", pointerEvents: picked ? "auto" : "none", transition: `opacity 260ms ${EASE}, transform ${GLIDE}ms ${EASE}` }}>
          <Held value={picked}>{p => <Inspector picked={p} tokens={sorted} apply={apply} close={() => setPicked(null)} />}</Held>
        </div>

        <ReviewBar items={items} epoch={epoch} open={reviewOpen} setOpen={setReviewOpen} undo={undo}
          resolve={c => setItems(is => is.map(i => (i.id === c.id && i.kind === "comment" ? { ...i, resolved: !i.resolved } : i)))}
          send={send} inspector={inspecting}
          hint={!canvas ? "Open your dev server to start" : tool === "use" ? "Using the page — V to select, C to comment" : tool === "comment" ? "Click anything to leave a comment" : "Click anything to change it"} />
      </div>
    </aside>,
    document.body,
  );
}

const camel = (p: string) => p.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

// ── surfaces ────────────────────────────────────────────────────────────────
function Inspector({ picked, tokens, apply, close }: { picked: Facts; tokens: ReturnType<typeof sortTokens>; apply: (prop: string, value: string, label: string) => void; close: () => void }) {
  const s = picked.style;
  const px = (v: string) => Math.round(parseFloat(v) || 0);
  return (
    <div style={{ fontSize: "var(--fs-base)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "14px 14px 12px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "var(--fg-strong)", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{picked.component || picked.where}</div>
          {picked.component && <div style={{ color: "var(--fg-dim)", fontSize: "var(--fs-xs)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{picked.where}</div>}
        </div>
        <Soft label="Deselect · Esc" onClick={close}><CloseIcon size={14} /></Soft>
      </div>
      {picked.text !== null && (
        <Group title="Text">
          <textarea key={`${picked.id}`} defaultValue={picked.text} rows={2} onBlur={e => e.target.value !== picked.text && apply("text", e.target.value, "Text")} style={{ ...field, width: "100%", resize: "vertical" }} />
        </Group>
      )}
      <Group title="Spacing">
        <Pair>
          <Num label="Vertical" value={px(s.paddingTop)} onChange={v => { apply("padding-top", `${v}px`, "Padding top"); apply("padding-bottom", `${v}px`, "Padding bottom"); }} />
          <Num label="Horizontal" value={px(s.paddingRight)} onChange={v => { apply("padding-left", `${v}px`, "Padding left"); apply("padding-right", `${v}px`, "Padding right"); }} />
          <Num label="Gap" value={px(s.gap)} onChange={v => apply("gap", `${v}px`, "Gap")} />
          <Num label="Radius" value={px(s.borderRadius)} onChange={v => apply("border-radius", `${v}px`, "Radius")} />
        </Pair>
        {tokens.radii.length > 0 && <Steps tokens={tokens.radii} current={s.borderRadius} onPick={t => apply("border-radius", `var(${t})`, "Radius")} />}
      </Group>
      <Group title="Type">
        {tokens.sizes.length > 0
          ? <Steps tokens={tokens.sizes} current={s.fontSize} onPick={t => apply("font-size", `var(${t})`, "Font size")} />
          : <Pair><Num label="Size" value={px(s.fontSize)} onChange={v => apply("font-size", `${v}px`, "Font size")} /></Pair>}
        <div style={{ display: "flex", gap: 2, marginTop: 6 }}>
          {[["400", "Regular"], ["700", "Bold"]].map(([w, l]) => <Soft key={w} wide on={(Number(s.fontWeight) >= 600 ? "700" : "400") === w} onClick={() => apply("font-weight", w, "Weight")}>{l}</Soft>)}
        </div>
      </Group>
      {(tokens.text.length > 0 || tokens.surface.length > 0) && (
        <Group title="Colour">
          {tokens.text.length > 0 && <Swatches tokens={tokens.text} current={s.color} onPick={t => apply("color", `var(${t.name})`, "Text colour")} />}
          {tokens.text.length > 0 && tokens.surface.length > 0 && <div style={{ height: 8 }} />}
          {tokens.surface.length > 0 && <Swatches tokens={tokens.surface} current={s.backgroundColor} onPick={t => apply("background-color", `var(${t.name})`, "Background")} />}
        </Group>
      )}
    </div>
  );
}

function ReviewBar({ items, epoch, open, setOpen, undo, resolve, send, hint, inspector }: {
  items: ReviewItem[]; epoch: number; open: boolean; setOpen: (o: boolean) => void; undo: (i: ReviewItem) => void;
  resolve: (c: ReviewItem) => void; send: (extra: string) => void; hint: string; inspector: boolean;
}) {
  const [extra, setExtra] = useState("");
  const edits = items.filter(i => i.kind === "edit").length;
  const comments = items.filter(i => i.kind === "comment" && !i.resolved).length;
  const summary = [edits && `${edits} edit${edits > 1 ? "s" : ""}`, comments && `${comments} comment${comments > 1 ? "s" : ""}`].filter(Boolean).join(" · ");
  const canSend = edits + comments > 0 || extra.trim().length > 0;
  const go = () => { if (!canSend) return; send(extra); setExtra(""); };
  return (
    <div style={{ position: "absolute", left: 0, right: inspector ? INSPECTOR : 0, bottom: 16, display: "flex", justifyContent: "center", pointerEvents: "none", zIndex: 3, transition: `right ${GLIDE}ms ${EASE}` }}>
      <div className="menu-glass" style={{ width: "min(640px, calc(100% - 32px))", borderRadius: 16, overflow: "hidden", pointerEvents: "auto" }}>
        <div style={{ maxHeight: open && items.length ? 260 : 0, opacity: open && items.length ? 1 : 0, overflowY: "auto", transition: `max-height ${GLIDE}ms ${EASE}, opacity 260ms ${EASE}` }}>
          <div style={{ padding: "8px 8px 0" }}>
            {items.map(i => {
              const done = i.kind === "comment" && i.resolved;
              const stale = i.epoch !== epoch;
              return (
                <div key={i.id} className="klide-design-row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 8px", borderRadius: 10, opacity: done ? 0.5 : 1 }}>
                  <span style={{ width: 18, textAlign: "center", color: i.kind === "comment" ? "var(--accent)" : "var(--fg-dim)", fontSize: "var(--fs-xs)", fontWeight: 700 }}>{i.kind === "comment" ? i.n : "–"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: done ? "line-through" : undefined }}>
                      {i.kind === "edit" ? `${i.label} ${i.from || "—"} → ${i.to}` : i.text}
                    </div>
                    <div style={{ color: "var(--fg-dim)", fontSize: "var(--fs-xs)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {[i.component, i.where].filter(Boolean).join(" · ")}{stale ? " · from before the page reloaded" : ""}
                    </div>
                  </div>
                  {i.kind === "comment" && <Soft label={i.resolved ? "Reopen" : "Resolve"} onClick={() => resolve(i)}><CheckIcon size={14} /></Soft>}
                  <Soft label={i.kind === "edit" ? "Undo" : "Delete"} onClick={() => undo(i)}>{i.kind === "edit" ? <UndoIcon size={14} /> : <CloseIcon size={14} />}</Soft>
                </div>
              );
            })}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8, padding: 10, borderTop: `1px solid ${open && items.length ? "var(--panel-border)" : "transparent"}`, transition: `border-color 260ms ${EASE}` }}>
          <textarea value={extra} onChange={e => setExtra(e.target.value)} rows={1} placeholder={summary ? "Anything else for Kit…" : hint} aria-label="Message for Kit"
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } }}
            style={{ flex: 1, resize: "none", border: 0, outline: "none", boxShadow: "none", background: "transparent", color: "var(--fg)", font: "inherit", fontSize: "var(--fs-md)", padding: "6px 4px", lineHeight: 1.4 }} />
          {items.length > 0 && (
            <button onClick={() => setOpen(!open)} className="klide-design-soft" style={{ ...plain, display: "inline-flex", alignItems: "center", gap: 4, padding: "6px 8px", borderRadius: 10, color: "var(--fg-muted)", fontSize: "var(--fs-base)" }}>
              {summary || "Review"} <ChevronIcon open={open} size={12} />
            </button>
          )}
          <button disabled={!canSend} onClick={go} aria-label="Send to Kit" title="Send to Kit"
            style={{ ...plain, width: 32, height: 32, borderRadius: 999, display: "grid", placeItems: "center", background: "var(--control-primary-bg)", color: "var(--control-primary-fg)", opacity: canSend ? 1 : 0.35, cursor: canSend ? "pointer" : "default", transition: `opacity 200ms ${EASE}` }}>
            <SendIcon size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function Empty({ connecting, problem, candidates, onPick, runCommand, server, serverLog, onRun }: {
  connecting: boolean; problem: string | null; candidates: string[]; onPick: (url: string) => void;
  runCommand: string | null; server: "idle" | "starting" | "running"; serverLog: string; onRun: () => void;
}) {
  const starting = server === "starting";
  return (
    <div style={{ maxWidth: 400, textAlign: "center", color: "var(--fg-muted)", lineHeight: 1.5, animation: `klide-design-in 260ms ${EASE}` }}>
      <div style={{ color: "var(--fg-strong)", fontSize: "var(--fs-md)", fontWeight: 700, marginBottom: 6 }}>{connecting ? "Opening…" : starting ? "Starting your app…" : "Open your running app"}</div>
      {problem ? <div style={{ color: "var(--danger)", overflowWrap: "anywhere" }}>{problem}</div>
        : starting ? <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)", minHeight: 18, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{serverLog || runCommand}</div>
        : <div>{runCommand ? "Run it from here, or type the address of a server that's already running." : "Start the project's dev server, then type its address above."}</div>}
      {runCommand && server === "idle" && !connecting && (
        <button onClick={onRun} style={{ ...plain, marginTop: 14, display: "inline-flex", alignItems: "center", gap: 8, padding: "7px 14px", borderRadius: 10, background: "var(--control-primary-bg)", color: "var(--control-primary-fg)" }}>
          Run <code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)", opacity: 0.85 }}>{runCommand}</code>
        </button>
      )}
      {candidates.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 4, marginTop: 12 }}>
          {candidates.map(c => <Soft key={c} wide onClick={() => onPick(c)}>{c.replace(/^http:\/\//, "").replace(/\/$/, "")}</Soft>)}
        </div>
      )}
    </div>
  );
}

function CommentBox({ target, onCancel, onSave }: { target: Facts; onCancel: () => void; onSave: (t: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="menu-glass" style={{ width: 280, borderRadius: 12, padding: 10 }}>
      <div style={{ color: "var(--fg-dim)", fontSize: "var(--fs-xs)", marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{[target.component, target.where].filter(Boolean).join(" · ")}</div>
      <textarea autoFocus value={text} onChange={e => setText(e.target.value)} rows={3} placeholder="What should change here?" aria-label="Comment"
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSave(text); } if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}
        style={{ ...field, width: "100%", resize: "none", border: 0, boxShadow: "none", padding: 2, fontSize: "var(--fs-md)" }} />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 4 }}>
        <Soft wide onClick={onCancel}>Cancel</Soft>
        <button disabled={!text.trim()} onClick={() => onSave(text)} style={{ ...plain, padding: "5px 12px", borderRadius: 10, background: "var(--control-primary-bg)", color: "var(--control-primary-fg)", opacity: text.trim() ? 1 : 0.4 }}>Comment</button>
      </div>
    </div>
  );
}

// ── parts ────────────────────────────────────────────────────────────────────
const plain: CSSProperties = { border: 0, background: "transparent", cursor: "pointer", font: "inherit" };
const field: CSSProperties = { boxSizing: "border-box", minWidth: 0, background: "transparent", color: "var(--fg)", border: "1px solid var(--panel-border)", borderRadius: 8, padding: "5px 8px", font: "inherit", fontSize: "var(--fs-base)", outline: "none" };

/** Keeps rendering the last value while a surface fades out. */
function Held<T>({ value, children }: { value: T | null; children: (v: T) => ReactNode }) {
  const last = useRef<T | null>(null);
  if (value !== null) last.current = value;
  return last.current === null ? null : <>{children(last.current)}</>;
}
function Soft({ label, on, wide, onClick, children }: { label?: string; on?: boolean; wide?: boolean; onClick: () => void; children: ReactNode }) {
  return <button title={label} aria-label={label} aria-pressed={on} onClick={onClick} className={on ? "klide-design-soft on" : "klide-design-soft"}
    style={{ ...plain, height: 28, minWidth: 28, padding: wide ? "0 10px" : 0, display: "inline-grid", placeItems: "center", borderRadius: 10, color: on ? "var(--fg-strong)" : "var(--fg-muted)", fontSize: "var(--fs-base)", whiteSpace: "nowrap" }}>{children}</button>;
}
const Divider = () => <span style={{ width: 1, height: 16, background: "var(--panel-border)", margin: "0 4px", flex: "none" }} />;
function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section style={{ padding: "10px 14px 14px", borderTop: "1px solid var(--panel-border)" }}><div style={{ color: "var(--fg-dim)", fontSize: "var(--fs-xs)", marginBottom: 8 }}>{title}</div>{children}</section>;
}
const Pair = ({ children }: { children: ReactNode }) => <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 8 }}>{children}</div>;
function Num({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return <label style={{ display: "flex", alignItems: "center", gap: 6, ...field, padding: "4px 8px" }}>
    <span style={{ color: "var(--fg-dim)", fontSize: "var(--fs-xs)", flex: 1 }}>{label}</span>
    <input key={value} type="number" min={0} defaultValue={value} onChange={e => e.target.value !== "" && onChange(Number(e.target.value))}
      style={{ width: 40, border: 0, outline: "none", boxShadow: "none", background: "transparent", color: "var(--fg)", font: "inherit", textAlign: "right" }} />
  </label>;
}
function Steps({ tokens, current, onPick }: { tokens: { name: string; value: string; short: string }[]; current: string; onPick: (t: string) => void }) {
  return <div style={{ display: "flex", gap: 2, marginTop: 8, padding: 2, borderRadius: 10, border: "1px solid var(--panel-border)" }}>
    {tokens.map(t => <button key={t.name} title={`${t.name} · ${t.value}`} onClick={() => onPick(t.name)} className={t.value === current ? "klide-design-soft on" : "klide-design-soft"}
      style={{ ...plain, flex: 1, minWidth: 0, height: 24, borderRadius: 8, color: "var(--fg-muted)", fontSize: "var(--fs-xs)", overflow: "hidden", textOverflow: "ellipsis" }}>{t.short}</button>)}
  </div>;
}
function Swatches({ tokens, current, onPick }: { tokens: { name: string; value: string; rgb: string }[]; current: string; onPick: (t: { name: string }) => void }) {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
    {tokens.map(t => <button key={t.name} title={t.name} aria-label={t.name} onClick={() => onPick(t)}
      style={{ width: 24, height: 24, borderRadius: 999, background: t.value, border: "1px solid var(--panel-border)", boxShadow: t.rgb === current ? "0 0 0 2px var(--bg-elevated), 0 0 0 3.5px var(--accent)" : "none", cursor: "pointer", padding: 0, transition: `box-shadow 160ms ${EASE}` }} />)}
  </div>;
}
/** One ring that glides from element to element and fades when it has none. */
function Ring({ r, dashed, instant }: { r: Rect | null; dashed?: boolean; instant?: boolean }) {
  const last = useRef<Rect | null>(null);
  if (r) last.current = r;
  const b = r ?? last.current;
  if (!b) return null;
  const ms = dashed ? 160 : 260;
  const move = instant ? "" : `transform ${ms}ms ${EASE}, width ${ms}ms ${EASE}, height ${ms}ms ${EASE}, `;
  return <div style={{ position: "absolute", left: 0, top: 0, transform: `translate(${b.x - 2}px, ${b.y - 2}px)`, width: b.w + 4, height: b.h + 4, pointerEvents: "none", borderRadius: 6,
    border: `1.5px ${dashed ? "dashed" : "solid"} var(--accent)`, background: dashed ? "color-mix(in srgb, var(--accent) 5%, transparent)" : "transparent",
    opacity: r ? 1 : 0, transition: `${move}opacity 180ms ${EASE}`, willChange: "transform" }} />;
}
function Pin({ n, r, scale, onClick }: { n: number; r: Rect; scale: number; onClick: () => void }) {
  const s = 22 / scale;
  return <button onClick={onClick} aria-label={`Comment ${n}`} style={{ ...plain, position: "absolute", left: r.x + r.w - s / 2, top: r.y - s / 2, width: s, height: s, borderRadius: "999px 999px 999px 2px",
    background: "var(--accent)", color: "var(--control-primary-fg)", fontSize: 11 / scale, fontWeight: 700, display: "grid", placeItems: "center", boxShadow: `0 0 0 ${2 / scale}px var(--bg)`, animation: `klide-design-pop 320ms ${EASE}` }}>{n}</button>;
}
function Anchored({ frame, r, scale, children }: { frame: HTMLIFrameElement; r: Rect; scale: number; children: ReactNode }) {
  const f = frame.getBoundingClientRect();
  const left = Math.min(window.innerWidth - 300, f.left + (r.x + r.w) * scale + 12);
  const top = Math.max(70, Math.min(window.innerHeight - 220, f.top + r.y * scale));
  return <div style={{ position: "fixed", left, top, zIndex: 5, animation: `klide-design-in 220ms ${EASE}` }}>{children}</div>;
}

const css = document.createElement("style");
css.textContent = `
  .klide-design-soft, .klide-design-row { transition: background-color 160ms ${EASE}, color 160ms ${EASE}, opacity 200ms ${EASE}; }
  .klide-design-row { animation: klide-design-in 260ms ${EASE} both; }
  .klide-design-soft:hover, .klide-design-row:hover { background: var(--menu-row-hover); }
  .klide-design-soft.on { background: var(--menu-row-active); }
  @keyframes klide-design-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  @keyframes klide-design-pop { from { opacity: 0; transform: scale(.6); } to { opacity: 1; transform: none; } }
`;
document.head.appendChild(css);

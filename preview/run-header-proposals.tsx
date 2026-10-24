// Throwaway: three directions for the top of Mission Control's RunDetail —
// identity, title, evidence strip, action bar, metadata, checkpoints — with
// the run from Pierre's 2026-10-24 screenshot. ?h=1|2|3 · ?all · ?theme=light
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProviderLogo } from "../src/components/ai/icons";
import { SourceLogo, ForkGlyph, WorktreeGlyph, DiffGlyph, MemoryGlyph, ExportGlyph, EvidenceGlyph, PencilGlyph, ArchiveGlyph, CopyGlyph, FolderGlyph } from "../src/components/missionControl/glyphs";
import { DELEGATES } from "../src/delegates";
import { makerMark } from "../src/modelIdentity";
import { ChevronIcon, FocusLayoutIcon, MoreIcon } from "../src/icons";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "dark";

const RUN = {
  title: "what this file about ?", model: "deepseek-v4.1-flash-1017", provider: "openrouter" as const,
  status: "Done", project: "KIDE", branch: "main", took: "7s", cost: "<$0.01", tokens: "27.7k",
  messages: 3, seen: "29m ago", started: "Oct 24, 20:01", validation: "Skipped", memory: false, checkpoints: 0,
};
const modelMark = (size: number) => makerMark(RUN.model, RUN.provider, size) ?? <ProviderLogo id={RUN.provider} size={size} />;

// ── Menus: the 13 hand-off logos and 11 utility icons become two labelled lists
type Item = { icon?: React.ReactNode; label: string; hint?: string } | "sep" | { group: string };
const CONTINUE: Item[] = [
  { icon: <SourceLogo source="klide" size={14} />, label: "Resume in Klide", hint: "↵" },
  { icon: <FocusLayoutIcon size={14} />, label: "Continue in Focus" },
  "sep", { group: "Hand off to" },
  ...DELEGATES.slice(0, 6).map(d => ({ icon: <SourceLogo source={d.id} size={14} />, label: d.label })),
  { label: `${DELEGATES.length - 6} more…` },
];
const FORK: Item[] = [{ icon: ForkGlyph, label: "Fork here" }, { icon: WorktreeGlyph, label: "Fork in a worktree" }];
const MORE: Item[] = [
  { icon: PencilGlyph, label: "Rename", hint: "F2" }, { icon: MemoryGlyph, label: "Save to memory" },
  "sep", { icon: ExportGlyph, label: "Copy transcript" }, { icon: EvidenceGlyph, label: "Export evidence" },
  { icon: CopyGlyph, label: "Copy log path" }, { icon: FolderGlyph, label: "Copy directory" },
  "sep", { icon: ArchiveGlyph, label: "Archive" },
];
function Menu({ items, align = "left" }: { items: Item[]; align?: "left" | "right" }) {
  return <div className={`menu ${align}`} role="menu">{items.map((it, i) => it === "sep" ? <hr key={i} />
    : "group" in it ? <span key={i} className="menu-group">{it.group}</span>
    : <button key={i} role="menuitem"><span className="menu-ic">{it.icon}</span>{it.label}{it.hint && <kbd>{it.hint}</kbd>}</button>)}</div>;
}
function MenuButton({ id, open, setOpen, children, items, className = "btn", align }: { id: string; open: string | null; setOpen: (v: string | null) => void; children: React.ReactNode; items: Item[]; className?: string; align?: "left" | "right" }) {
  return <span className="menu-anchor"><button className={className} aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>{children}</button>{open === id && <Menu items={items} align={align} />}</span>;
}
const Sep = () => <i className="sep">·</i>;

/** Actions shared by 1 and 2: one primary, the rest named, everything rare in ···. */
function ActionRow({ open, setOpen, compact, resume }: { open: string | null; setOpen: (v: string | null) => void; compact?: boolean; resume?: React.ReactNode }) {
  return <div className="actions">
    {resume ?? <span className="split">
      <button className="btn primary">Resume</button>
      <MenuButton id="continue" open={open} setOpen={setOpen} items={CONTINUE} className="btn primary caret"><ChevronIcon size={10} /></MenuButton>
    </span>}
    {!compact && <button className="btn">{DiffGlyph}Review changes</button>}
    {!compact && <MenuButton id="fork" open={open} setOpen={setOpen} items={FORK}>{ForkGlyph}Fork<ChevronIcon size={9} /></MenuButton>}
    <MenuButton id="more" open={open} setOpen={setOpen} items={compact ? [{ icon: DiffGlyph, label: "Review changes" }, ...FORK, "sep", ...MORE] : MORE} className="btn icon" align="right"><MoreIcon size={15} /></MenuButton>
  </div>;
}
function Tabs({ extra }: { extra?: string }) {
  return <div className="tabs">{["Conversation", "Timeline", "Context", "Tokens & cost", ...(extra ? [extra] : [])].map((t, i) => <button key={t} aria-selected={i === 0}>{t}</button>)}</div>;
}
const ActivityStub = () => <div className="stub"><span className="dim">You</span><p>what this file about ?</p><span className="dim">Kit · deepseek-v4.1-flash</span><p>It's the Mission Control run board — the list of runs on the left and the detail of the selected one…</p></div>;

// ── 1 · Sentence header ─────────────────────────────────────────────────────
function H1({ menu }: { menu: string | null }) {
  const [open, setOpen] = useState<string | null>(menu);
  return <div className="pane">
    <header className="h1">
      <span className="avatar">{modelMark(22)}</span>
      <div className="h1-body">
        <h2 title="Double-click to rename">{RUN.title}</h2>
        <p className="line"><span className="ok">{RUN.status}</span><Sep /><span>{RUN.model}</span><span className="dim">via OpenRouter</span><Sep /><span>{RUN.took}</span><Sep /><span>{RUN.cost}</span><Sep /><span>{RUN.tokens} tokens</span></p>
        <p className="line dim"><span>{RUN.project}</span><span>/</span><span className="mono">{RUN.branch}</span><Sep /><span>{RUN.messages} messages</span><Sep /><span>{RUN.seen}</span></p>
      </div>
    </header>
    <ActionRow open={open} setOpen={setOpen} />
    <Tabs extra="Details" />
    <ActivityStub />
  </div>;
}

// ── Continue: three designs for "Resume + every other way to carry on" ─────
// What exists today: Resume (same agent, same session), Continue in Focus
// (transcript replayed onto the canvas), Open in <CLI> (fresh session, Klide
// runs pass a compact summary), Fork / Fork in worktree.
const AGENTS = DELEGATES.map((d, i) => ({ ...d, installed: i < DELEGATES.length - 2 }));
function useOpen(initial: boolean) { const [o, set] = useState(initial); return [o, () => set(v => !v)] as const; }

/** R1 · Described menu — each way to continue says what it carries; agents as a named grid. */
function ResumeR1({ initial }: { initial: boolean }) {
  const [open, toggle] = useOpen(initial);
  return <span className="menu-anchor">
    <span className="split"><button className="btn primary">Resume</button><button className="btn primary caret" aria-expanded={open} onClick={toggle}><ChevronIcon size={10} /></button></span>
    {open && <div className="menu left cont">
      <button className="cont-row"><span className="menu-ic"><SourceLogo source="klide" size={15} /></span><span><strong>Resume in Klide</strong><small>Same agent, same session — picks up where it stopped</small></span><kbd>↵</kbd></button>
      <button className="cont-row"><span className="menu-ic"><FocusLayoutIcon size={15} /></span><span><strong>Continue in Focus</strong><small>The whole conversation, carried onto the Focus canvas</small></span></button>
      <hr />
      <span className="menu-group">Hand off to another agent<small>New session, starts from a summary of this run</small></span>
      <div className="agent-grid">{AGENTS.map(a => <button key={a.id} className={a.installed ? "" : "off"} title={a.installed ? `Open in ${a.label}` : `${a.label} isn't installed`}><SourceLogo source={a.id} size={15} /><span>{a.label}</span>{!a.installed && <small>Install</small>}</button>)}</div>
    </div>}
  </span>;
}

/** R2 · Continue palette — searchable, keyboard-first, and the "where" is a choice, not a separate Fork button. */
function ResumeR2({ initial }: { initial: boolean }) {
  const [open, toggle] = useOpen(initial);
  const [where, setWhere] = useState<"here" | "worktree">("here");
  const [q, setQ] = useState("");
  const rows = [
    { id: "klide", icon: <SourceLogo source="klide" size={15} />, label: "Klide", note: "Resume this session", key: "↵" },
    { id: "focus", icon: <FocusLayoutIcon size={15} />, label: "Focus", note: "Same conversation, on the canvas", key: "F" },
    ...AGENTS.map((a, i) => ({ id: a.id, icon: <SourceLogo source={a.id} size={15} />, label: a.label, note: a.installed ? "New session from a summary" : "Not installed", key: String(i + 1), off: !a.installed })),
  ].filter(r => r.label.toLowerCase().includes(q.toLowerCase()));
  return <span className="menu-anchor">
    <button className="btn primary solo" aria-expanded={open} onClick={toggle}>Continue<kbd className="inv">⌘↵</kbd></button>
    {open && <div className="menu left pal">
      <input autoFocus placeholder="Continue with…" value={q} onChange={e => setQ(e.target.value)} />
      <div className="pal-list">{rows.map((r, i) => <button key={r.id} className={`pal-row${i === 0 ? " is-active" : ""}${"off" in r && r.off ? " off" : ""}`}>
        <span className="menu-ic">{r.icon}</span><strong>{r.label}</strong><small>{r.note}</small><kbd>{r.key}</kbd>
        {i === 1 && <span className="pal-split" />}
      </button>)}</div>
      <footer className="pal-foot"><span className="dim">Where</span>
        <span className="seg">{(["here", "worktree"] as const).map(w => <button key={w} aria-pressed={where === w} onClick={() => setWhere(w)}>{w === "here" ? "This checkout" : "New worktree"}</button>)}</span>
        <span className="dim pal-hint">↑↓ choose · ↵ go</span></footer>
    </div>}
  </span>;
}

/** R3 · Sentence — the choice is visible before you open anything: who, where, go. */
function ResumeR3({ initial }: { initial: boolean }) {
  const [agentOpen, toggle] = useOpen(initial);
  const [agent, setAgent] = useState<{ id: string; label: string }>({ id: "klide", label: "Klide" });
  const [surface, setSurface] = useState("its session");
  const same = agent.id === "klide";
  return <span className="sentence">
    <span className="dim">Continue with</span>
    <span className="menu-anchor"><button className="pick" aria-expanded={agentOpen} onClick={toggle}><SourceLogo source={agent.id as "klide"} size={13} />{agent.label}<ChevronIcon size={9} /></button>
      {agentOpen && <div className="menu left">
        <span className="menu-group">This run's agent</span>
        <button onClick={() => { setAgent({ id: "klide", label: "Klide" }); toggle(); }}><span className="menu-ic"><SourceLogo source="klide" size={14} /></span>Klide<kbd>current</kbd></button>
        <hr /><span className="menu-group">Hand off — new session from a summary</span>
        {AGENTS.map(a => <button key={a.id} className={a.installed ? "" : "off"} onClick={() => { setAgent(a); toggle(); }}><span className="menu-ic"><SourceLogo source={a.id} size={14} /></span>{a.label}{!a.installed && <kbd>Install</kbd>}</button>)}
      </div>}
    </span>
    <span className="dim">in</span>
    <span className="menu-anchor"><button className="pick" onClick={() => setSurface(s => s === "its session" ? "Focus" : s === "Focus" ? "a new worktree" : "its session")}>{same ? surface : surface === "its session" ? "a new panel" : surface}<ChevronIcon size={9} /></button></span>
    <button className="btn primary solo">Go</button>
  </span>;
}

// ── 2 · Facts grid, no box ──────────────────────────────────────────────────
function H2({ menu, resume }: { menu: string | null; resume?: 1 | 2 | 3 }) {
  const [open, setOpen] = useState<string | null>(menu);
  const facts: [string, React.ReactNode][] = [
    ["Status", <span className="ok">{RUN.status}</span>], ["Model", <span className="with-mark">{modelMark(13)}{RUN.model}</span>],
    ["Where", <span>{RUN.project} / <span className="mono">{RUN.branch}</span></span>], ["Took", RUN.took],
    ["Cost", RUN.cost], ["Tokens", RUN.tokens], ["Validation", <span className="dim">{RUN.validation}</span>],
    ["Memory", <button className="link">Save</button>],
  ];
  return <div className="pane">
    <header className="h2">
      <p className="eyebrow"><SourceLogo source="klide" size={13} />Klide run<Sep /><span>{RUN.started}</span><Sep /><span>{RUN.messages} messages</span></p>
      <h2>{RUN.title}</h2>
    </header>
    <dl className="facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    <ActionRow open={open} setOpen={setOpen} resume={resume === 1 ? <ResumeR1 initial={menu === "resume"} /> : resume === 2 ? <ResumeR2 initial={menu === "resume"} /> : resume === 3 ? <ResumeR3 initial={menu === "resume"} /> : undefined} />
    <p className="checkpoints dim">No checkpoints — this run changed no files.</p>
    <Tabs />
    <ActivityStub />
  </div>;
}

// ── 3 · Compact bar ─────────────────────────────────────────────────────────
function H3({ menu }: { menu: string | null }) {
  const [open, setOpen] = useState<string | null>(menu);
  const [facts, setFacts] = useState(false);
  return <div className="pane">
    <header className="h3">
      <span className="avatar sm">{modelMark(16)}</span>
      <h2>{RUN.title}</h2>
      <span className="ok h3-status">{RUN.status}</span>
      <ActionRow open={open} setOpen={setOpen} compact />
    </header>
    <button className="h3-facts" aria-expanded={facts} onClick={() => setFacts(!facts)}>
      <span>{RUN.model}</span><Sep /><span>{RUN.took}</span><Sep /><span>{RUN.cost}</span><Sep /><span>{RUN.tokens} tokens</span><Sep /><span>{RUN.seen}</span>
      <ChevronIcon size={9} style={{ transform: facts ? "none" : "rotate(-90deg)" }} />
    </button>
    {facts && <dl className="facts tight">{([["Provider", "OpenRouter"], ["Project", RUN.project], ["Branch", RUN.branch], ["Started", RUN.started], ["Messages", String(RUN.messages)], ["Validation", RUN.validation], ["Memory", "Not saved"], ["Checkpoints", "None"]] as const).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
    <Tabs />
    <ActivityStub />
  </div>;
}

const H = {
  1: { name: "1 · Sentence header", C: H1, why: "Identity, status and numbers read as two lines of text under the title. One primary action (Resume, with every other way to continue and all 9 hand-offs in its menu), two named secondaries, the rest in ···. Model, project, dates and checkpoints move to a Details tab. The conversation starts ~200px higher." },
  2: { name: "2 · Facts grid", C: H2, why: "Keeps the facts visible at a glance, but as a quiet 4-column grid with sentence-case labels — no box, no mono capitals, each fact said once (today: status ×4, branch ×2, seen/updated ×2). ‘Memory: Save’ is the fact and the action in one place." },
  3: { name: "3 · Compact bar", C: H3, why: "One line: mark, title, status, Resume, ···. The numbers sit on a single quiet line that unfolds into the full facts. Best when Mission Control is a working surface and you live in the tabs." },
} as const;

function Page() {
  const all = params.has("all");
  if (params.has("resume")) {
    const R = { 1: "R1 · Described menu", 2: "R2 · Continue palette", 3: "R3 · Sentence" } as const;
    return <main className="all tall">{([1, 2, 3] as const).map(id => <section key={id}><h3>{R[id]}</h3><H2 menu={params.get("menu") ?? "resume"} resume={id} /></section>)}</main>;
  }
  const [h, setH] = useState<keyof typeof H>(Number(params.get("h") ?? 1) as keyof typeof H);
  const menu = params.get("menu");
  if (all) return <main className="all">{([1, 2, 3] as const).map(id => { const C = H[id].C; return <section key={id}><h3>{H[id].name}</h3><C menu={id === 1 ? menu : null} /></section>; })}</main>;
  const C = H[h].C;
  return <main className="one">
    <nav className="switch">{([1, 2, 3] as const).map(id => <button key={id} aria-pressed={id === h} onClick={() => setH(id)}>{H[id].name}</button>)}</nav>
    <p className="why">{H[h].why}</p>
    <C key={h} menu={menu} />
  </main>;
}

const css = `
.tall .pane { min-height: 760px; overflow: visible; }
.btn, .sentence, .pick { white-space: nowrap; }
.actions { flex-wrap: wrap; row-gap: 10px; }
.sentence { flex-basis: 100%; }
.pal input:focus-visible { outline: none; box-shadow: none; }
.cont { width: 380px; padding: 6px; }
.cont-row { display: grid !important; grid-template-columns: 20px 1fr auto; align-items: start !important; gap: 10px !important; height: auto !important; padding: 8px !important; }
.cont-row .menu-ic { margin-top: 2px; }
.cont-row strong, .pal-row strong { font-weight: 400; color: var(--fg-strong); display: block; }
.cont-row small, .menu-group small { display: block; color: var(--fg-subtle); font-size: 11.5px; margin-top: 1px; }
.menu-group small { font-size: 11px; margin-top: 2px; }
.agent-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; padding: 4px 2px 2px; }
.agent-grid button { flex-direction: column; justify-content: center; gap: 6px !important; height: 62px !important; text-align: center; font-size: 12px !important; }
.agent-grid small { font-size: 10.5px; color: var(--accent); margin-top: -4px; }
.menu .off, .agent-grid .off { color: var(--fg-subtle); } .off svg, .off img { opacity: .45; filter: grayscale(1); }
.pal { width: 360px; padding: 0; overflow: hidden; }
.pal input { width: 100%; box-sizing: border-box; border: 0; border-bottom: 1px solid var(--border); background: none; padding: 11px 12px; font: inherit; font-size: 13px; color: var(--fg-strong); outline: none; }
.pal-list { padding: 5px; max-height: 330px; overflow: auto; }
.pal-row { display: grid !important; grid-template-columns: 20px auto 1fr auto; gap: 10px !important; position: relative; }
.pal-row small { color: var(--fg-subtle); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pal-row.is-active { background: var(--menu-row-active, var(--bg-selected)); }
.pal-split { position: absolute; left: 6px; right: 6px; bottom: -3px; border-top: 1px solid var(--border); }
.pal-row:nth-child(2) { margin-bottom: 6px; }
.pal-foot { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-top: 1px solid var(--border); font-size: 12px; }
.pal-hint { margin-left: auto; font-size: 11px; white-space: nowrap; }
.seg button { white-space: nowrap; }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-md, 6px); overflow: hidden; }
.seg button { padding: 3px 8px; font-size: 11.5px; color: var(--fg-subtle); } .seg button[aria-pressed="true"] { background: var(--bg-selected); color: var(--fg-strong); }
.btn.primary.solo { border-radius: var(--radius-md, 6px); }
.inv { font: 10.5px var(--font-ui); opacity: .6; margin-left: 2px; }
.sentence { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; }
.pick { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; border-radius: var(--radius-md, 6px); color: var(--fg-strong); border-bottom: 1px dashed var(--border-strong); border-radius: 0; transition: background var(--motion-fast, 120ms) ease; }
.pick:hover, .pick[aria-expanded="true"] { background: var(--bg-hover); border-radius: var(--radius-md, 6px); }

body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.45 var(--font-ui); }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
.dim { color: var(--fg-subtle); } .ok { color: var(--success); } .mono { font-family: var(--font-mono); font-size: .92em; }
.sep { font-style: normal; color: var(--fg-dim); }
.one { max-width: 760px; margin: 28px auto; padding: 0 24px; }
.all { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; padding: 24px; }
.all h3 { font-size: 12px; color: var(--fg-subtle); font-weight: 400; margin: 0 0 8px; }
.switch { display: flex; gap: 18px; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
.switch button { color: var(--fg-subtle); } .switch button[aria-pressed="true"] { color: var(--fg-strong); font-weight: 700; }
.why { color: var(--fg-muted); font-size: 12px; line-height: 1.65; margin: 12px 0 20px; }
.pane { border: 1px solid var(--border); border-radius: var(--radius-lg, 10px); padding: 22px 24px 0; min-height: 520px; overflow: hidden; }
h2 { margin: 0; font-size: 18px; font-weight: 700; color: var(--fg-strong); letter-spacing: -.01em; }
.avatar { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 8px; background: var(--bg-hover); flex: 0 0 auto; }
.avatar.sm { width: 24px; height: 24px; border-radius: 6px; }
.line { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 0; font-variant-numeric: tabular-nums; }
.line.dim { margin-top: 3px; font-size: 12.5px; }
.h1 { display: flex; gap: 12px; align-items: flex-start; }
.h1 .avatar { margin-top: -3px; }
.h1-body { min-width: 0; }
.actions { display: flex; align-items: center; gap: 8px; margin: 16px 0 18px; }
.h1 + .actions { margin-left: 44px; }
.btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: var(--radius-md, 6px); border: 1px solid var(--border); color: var(--fg); font-size: 12.5px; transition: background var(--motion-fast, 120ms) ease, color var(--motion-fast, 120ms) ease; }
.btn:hover, .btn[aria-expanded="true"] { background: var(--bg-hover); color: var(--fg-strong); }
.btn svg { flex: 0 0 auto; }
.btn.icon { width: 28px; padding: 0; justify-content: center; border-color: transparent; color: var(--fg-muted); }
.actions > .menu-anchor:last-child { margin-left: auto; }
.split { display: inline-flex; }
.btn.primary { background: var(--control-primary-bg, var(--fg-strong)); color: var(--control-primary-fg, var(--bg)); border-color: transparent; border-radius: var(--radius-md, 6px) 0 0 var(--radius-md, 6px); }
.btn.primary:hover { opacity: .9; background: var(--control-primary-bg, var(--fg-strong)); color: var(--control-primary-fg, var(--bg)); }
.btn.primary.caret { border-radius: 0 var(--radius-md, 6px) var(--radius-md, 6px) 0; padding: 0 7px; margin-left: 1px; }
.menu-anchor { position: relative; display: inline-flex; }
.menu { position: absolute; top: calc(100% + 6px); z-index: 5; min-width: 210px; padding: 5px; border: 1px solid var(--border); border-radius: var(--radius-lg, 10px); background: var(--bg-elevated); box-shadow: var(--shadow-raised, 0 8px 24px #0003); animation: fade var(--motion-med, 160ms) var(--ease-out, ease-out); }
.menu.left { left: 0; } .menu.right { right: 0; }
.menu button { display: flex; align-items: center; gap: 9px; width: 100%; height: 28px; padding: 0 8px; border-radius: var(--radius-sm, 4px); color: var(--fg); font-size: 12.5px; }
.menu button:hover { background: var(--menu-row-hover, var(--bg-hover)); color: var(--fg-strong); }
.menu-ic { width: 16px; display: inline-flex; justify-content: center; color: var(--fg-subtle); }
.menu kbd { margin-left: auto; font: 10.5px var(--font-ui); color: var(--fg-subtle); }
.menu hr { border: 0; border-top: 1px solid var(--border); margin: 5px 2px; }
.menu-group { display: block; font-size: 11px; color: var(--fg-subtle); padding: 6px 8px 3px; }
@keyframes fade { from { opacity: 0; transform: translateY(-2px); } }
.tabs { display: flex; gap: 20px; border-bottom: 1px solid var(--border); }
.tabs button { padding: 8px 0 9px; color: var(--fg-subtle); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tabs button[aria-selected="true"] { color: var(--fg-strong); border-bottom-color: var(--fg-strong); }
.stub { padding: 16px 0; font-size: 12.5px; } .stub p { margin: 3px 0 14px; color: var(--fg-strong); }
.h2 .eyebrow { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; color: var(--fg-subtle); font-size: 12px; }
.facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px 16px; margin: 16px 0 0; padding: 14px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.facts dt { font-size: 11.5px; color: var(--fg-subtle); } .facts dd { margin: 2px 0 0; color: var(--fg-strong); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.with-mark { display: inline-flex; align-items: center; gap: 6px; }
.link { color: var(--accent); } .link:hover { text-decoration: underline; text-underline-offset: 3px; }
.checkpoints { font-size: 12px; margin: -6px 0 14px; }
.h3 { display: flex; align-items: center; gap: 10px; }
.h3 h2 { font-size: 15px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.h3-status { font-size: 12.5px; }
.h3 .actions { margin: 0 0 0 auto; }
.h3-facts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 6px 0 14px 34px; color: var(--fg-subtle); font-size: 12px; font-variant-numeric: tabular-nums; }
.h3-facts:hover { color: var(--fg); }
.facts.tight { margin: -4px 0 14px 34px; padding: 10px 0; border-bottom: 0; }
`;
document.head.append(Object.assign(document.createElement("style"), { textContent: css }));
createRoot(document.getElementById("root")!).render(<Page />);

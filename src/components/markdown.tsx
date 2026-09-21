import { memo, useLayoutEffect, useRef, useId, useMemo, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { prepareVisual, type VisualHtml } from "./visualHtml";
import { typesetVisual } from "./visualTypeset";

import { createPortal } from "react-dom";
import { VisualExpandIcon, DownloadIcon, CodeIcon, CopyIcon, CheckIcon } from "../icons";
import { fitVisualCanvases, fitViewerCanvas } from "./visualLayout";
import { saveVisualPng } from "./visualExport";
import { BARE_URL_RE, openExternal, safeLinkHref, splitUrlTail } from "../externalLink";
import { linkIdentity, type LinkSite } from "../linkIdentity";
import { pathFromCodeSpan, pathLabel } from "../filePaths";
import { revealPath } from "../revealPath";
import { LinkMark } from "./linkMark";

type MdNode = string | ReactElement;

export type MarkdownOptions = {
  // Hook for the Mission Control wire-format tool markers
  // (`[tool: <name> <summary>]` on its own line). The renderer owns
  // the marker parsing; the caller decides how to render a tool
  // card. The AI panel never sees these markers and never passes
  // this hook.
  renderTool?: (name: string, summary?: string) => ReactNode;
  // The text is still arriving. The trailing words of the last block are
  // wrapped one span per word (keyed by position, so a word already on
  // screen keeps its DOM node) and each new span resolves in through
  // `.ai-word-in`. Off by default: a finished message is plain text.
  streaming?: boolean;
};

/** One visual a message holds: a closed `html` / `svg` (…) fence whose markup
 *  survived the sanitizer. `key` is stable across re-renders of the same text
 *  — the fence's index in the message — so a surface can key a preview on it.
 *  The Focus canvas reads this to show the same drawings again in its island
 *  column, beside the prose that holds them. */
export type VisualBlockRef = { key: string; code: string; lang: string; kind: VisualHtml["kind"] };

/** The visuals in a message, in order. Pure: the same split as the renderer
 *  (bare markup fenced first, `\`\`\`` segments, odd ones are code), closed
 *  fences only — a fence still arriving is source until it closes — and only
 *  where something renderable is left once the allowlist has done its work. */
export function visualBlocksOf(text: string): VisualBlockRef[] {
  const segments = fenceBareMarkup(text).split("```");
  const out: VisualBlockRef[] = [];
  segments.forEach((seg, idx) => {
    if (idx % 2 !== 1 || idx === segments.length - 1) return;
    const nl = seg.indexOf("\n");
    let lang = "";
    let code = seg;
    if (nl >= 0) {
      const first = seg.slice(0, nl).trim();
      if (/^[\w+#-]*$/.test(first)) { lang = first; code = seg.slice(nl + 1); }
    }
    if (!VISUAL_LANGS.has(lang.toLowerCase())) return;
    code = code.replace(/\n$/, "");
    const visual = prepareVisual(code, "kvprobe");
    if (!/<[A-Za-z]/.test(visual.html)) return;
    out.push({ key: `visual-${idx}`, code, lang, kind: visual.kind });
  });
  return out;
}

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
      out.push(<span key={key++} style={{ color: "var(--code-comment)", fontStyle: "italic" }}>{full}</span>);
    } else if (str) {
      out.push(<span key={key++} style={{ color: "var(--code-string)" }}>{full}</span>);
    } else if (num) {
      out.push(<span key={key++} style={{ color: "var(--code-number)" }}>{full}</span>);
    } else if (word && CODE_KEYWORDS.has(word)) {
      out.push(<span key={key++} style={{ color: "var(--code-keyword)", fontWeight: 500 }}>{full}</span>);
    } else {
      out.push(full);
    }
    last = m.index + full.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

// The shell every fenced block shares: hairline frame, a lowercase language
// mark on the left, actions on the right.
function BlockShell({ lang, actions, children }: { lang: string; actions: ReactNode; children: ReactNode }) {
  return (
    <div
      style={{
        margin: "8px 0",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        maxWidth: "100%",
        minWidth: 0,
        background: "color-mix(in srgb, var(--bg-elevated) 60%, var(--bg))",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "4px 6px 4px 10px",
          borderBottom: "1px solid var(--border)",
          background: "color-mix(in srgb, var(--bg-elevated) 90%, var(--bg))",
        }}
      >
        <span
          style={{
            fontSize: 9,
            fontWeight: 600,
            textTransform: "lowercase",
            color: "var(--fg-dim)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {lang || "code"}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>{actions}</div>
      </div>
      {children}
    </div>
  );
}

// One header action. Text, not a chip — the row reads as a line of small
// labels and only the hovered one comes forward.
function BlockAction({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        fontFamily: "var(--font-mono)",
        color: active ? "var(--accent)" : "var(--fg-dim)",
        padding: "2px 7px",
        borderRadius: "var(--radius-xs)",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        transition: "color var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.color = "var(--fg-strong)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = active ? "var(--accent)" : "var(--fg-dim)";
      }}
    >
      {label}
    </button>
  );
}

function useCopy(code: string): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  return [
    copied,
    () => {
      void navigator.clipboard
        .writeText(code)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        })
        .catch(() => {});
    },
  ];
}

// The monospace body with our token highlighter.
function CodeBody({ code }: { code: string }) {
  return (
    <pre
        style={{
          margin: 0,
          padding: "10px 12px",
          overflowX: "auto",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.55,
          color: "var(--fg)",
          whiteSpace: "pre",
          tabSize: 2,
        }}
      >
        <code style={{ fontFamily: "inherit" }}>{highlightCode(code)}</code>
      </pre>
  );
}

// Premium code block: language mark in the header, a Copy button on the right,
// a subtle bg-elevated tint, monospace body.
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, copy] = useCopy(code);
  return (
    <BlockShell
      lang={lang}
      actions={<BlockAction label={copied ? "Copied" : "Copy"} title="Copy code" active={copied} onClick={copy} />}
    >
      <CodeBody code={code} />
    </BlockShell>
  );
}

// Fences a model writes to *show* something rather than to quote source. The
// markup is rendered in place; the source stays one click away.
const VISUAL_LANGS = new Set(["html", "svg", "visual", "visualizer", "viz", "preview"]);

// The visual itself. Sanitized markup joins the app's own document — which is
// what earns the block its theme, its fonts and its tokens for free — and the
// stylesheet the model wrote is re-anchored to this one block so it cannot
// reach the app around it. See `visualHtml.ts` for the rules.
export const VisualSurface = memo(function VisualSurface({ visual, scope }: { visual: VisualHtml; scope: string }) {
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    let active = true;
    // Two passes that both need the drawing measured rather than described:
    // canvases sized to their box, and labels — placed by a model that could
    // not know how wide they would render — nudged off each other.
    const fit = () => {
      if (!active || !content.current) return;
      fitVisualCanvases(content.current);
      typesetVisual(content.current);
    };
    fit();
    void document.fonts.ready.then(fit);
    // The drawing is fluid: what fits at 720px can collide at 380px.
    const ro = new ResizeObserver(() => fit());
    if (content.current) ro.observe(content.current);
    return () => { active = false; ro.disconnect(); };
  }, [visual]);
  return (
    // `klide-viz` carries the visual palette (tokens.css): the neutrals follow
    // the theme, the chroma is fixed and readable on either ground, and
    // `visualHtml.ts` has already mapped everything the model wrote onto it.
    <div
      className={`${scope} klide-viz${visual.kind === "page" ? " klide-viz-page" : ""}`}
      style={{
        // Only what a visual must never be able to restyle stays inline. The
        // ground, the gutters and the type live on `.klide-viz` in tokens.css,
        // one class deep and declared before any visual's own stylesheet — so a
        // model that wrote `body { padding: 72px }` still gets 72px, which an
        // inline default would have silently outranked.
        overflowX: "auto",
        // Traps paint and layout — including anything that asked to be fixed —
        // inside the block, and makes the block the unit a width query asks
        // about (the drawing's @media size queries are rewritten to @container).
        contain: "layout paint",
        containerType: "inline-size",
        // Models reach for `--font-sans`; Klide's UI face answers to it here.
        ["--font-sans" as string]: "var(--font-ui)",
      } as CSSProperties}
    >
      {visual.css ? <style>{visual.css}</style> : null}
      {/* A drawing is injected into the app's own webview, so a link inside it
          must not be followed in place either. One delegated handler covers
          every anchor the sanitizer let through, however deep. */}
      <div
        ref={content}
        data-visual-content
        onClick={(e) => {
          const anchor = (e.target as Element | null)?.closest?.("a[href]");
          if (!(anchor instanceof HTMLAnchorElement)) return;
          e.preventDefault();
          void openExternal(anchor.getAttribute("href") ?? "");
        }}
        dangerouslySetInnerHTML={{ __html: visual.html }}
      />
      {visual.dropped.length > 0 ? (
        <div
          style={{
            marginTop: 10,
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            letterSpacing: "0.04em",
            color: "var(--fg-dim)",
          }}
        >
          {visual.dropped.join(", ")} not rendered
        </div>
      ) : null}
    </div>
  );
});

// One motion for a drawing leaving its card and coming back: long enough to
// be seen as travel from *there*, short enough not to be waited for.
const VISUAL_MOTION = { duration: 360, easing: "cubic-bezier(.2,.8,.2,1)" };

function VisualControl({ label, children, onClick, disabled = false, className = "" }: {
  label: string; children: ReactNode; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean; className?: string;
}) {
  return <button type="button" className={`visual-icon-button ${className}`.trim()} aria-label={label} data-tooltip={label} disabled={disabled} onClick={onClick}>{children}</button>;
}

/** `origin` is the element the drawing visibly grows out of and returns to —
 *  the figure inline, the card in the canvas column. */
export function VisualViewer({ code, origin, onClose }: { code: string; origin: { current: HTMLElement | null }; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const scope = `kv${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const visual = useMemo(() => prepareVisual(code, scope), [code, scope]);
  const content = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const motion = useRef<Animation[]>([]);
  const [opened, setOpened] = useState(false);
  const [copied, copy] = useCopy(code);
  useLayoutEffect(() => {
    const element = dialog.current!;
    const opener = document.activeElement;
    element.showModal();
    element.querySelector<HTMLButtonElement>('[aria-label="Close fullscreen"]')?.focus({ preventScroll: true });
    let active = true;
    const fit = () => { if (active && viewport.current && content.current) fitViewerCanvas(viewport.current, content.current); };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(viewport.current!);
    void document.fonts.ready.then(fit);
    const frame = requestAnimationFrame(() => {
      if (!active) return;
      fit();
      setOpened(true);
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches && origin.current) {
        const from = origin.current.getBoundingClientRect();
        const to = content.current!.getBoundingClientRect();
        if (from.width && from.height && to.width && to.height) {
          motion.current.push(content.current!.animate([
            { transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${from.width / to.width}, ${from.height / to.height})`, opacity: 0.6 },
            { transform: "none", opacity: 1 },
          ], VISUAL_MOTION));
        }
      }
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      motion.current.forEach(animation => animation.cancel());
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  async function close() {
    if (closing.current) return;
    closing.current = true;
    setOpened(false);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches && content.current && origin.current) {
      const from = content.current.getBoundingClientRect();
      const to = origin.current.getBoundingClientRect();
      const animation = content.current.animate([
        { transform: "none", opacity: 1 },
        { transform: `translate(${to.x - from.x}px, ${to.y - from.y}px) scale(${to.width / from.width}, ${to.height / from.height})`, opacity: 0 },
      ], { ...VISUAL_MOTION, fill: "forwards" });
      motion.current.push(animation);
      await animation.finished.catch(() => {});
    }
    onClose();
  }
  return createPortal(
    <dialog ref={dialog} className="visual-viewer" data-opened={opened} aria-label="Visual fullscreen" onCancel={event => { event.preventDefault(); void close(); }}>
      <div ref={viewport} className="visual-viewer-body"><div ref={content} className="visual-viewer-content"><VisualSurface visual={visual} scope={scope} /></div></div>
      <div className="visual-viewer-toolbar" role="group" aria-label="Visual controls">
        <VisualControl label={copied ? "Copied" : "Copy code"} onClick={copy}>{copied ? <CheckIcon size={18} /> : <CopyIcon size={18} />}</VisualControl>
        <VisualSaveButton content={content} />
        <span className="visual-toolbar-divider" aria-hidden="true" />
        <VisualControl label="Close fullscreen" onClick={() => void close()}><VisualExpandIcon expanded={opened} /></VisualControl>
      </div>
    </dialog>, document.body,
  );
}

function VisualSaveButton({ content }: { content: { current: HTMLDivElement | null } }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    const node = content.current?.querySelector<HTMLElement>(".klide-viz");
    if (!node || saving) return;
    setSaving(true);
    setError("");
    try { await saveVisualPng(node); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save PNG. Please try again."); }
    finally { setSaving(false); }
  }
  return <>
    <VisualControl label={saving ? "Saving PNG…" : "Save as PNG"} disabled={saving} onClick={() => void save()}><DownloadIcon size={15} /></VisualControl>
    {error ? <span role="alert" className="visual-export-error">{error}</span> : null}
  </>;
}

function VisualBlock({ code, lang, closed }: { code: string; lang: string; closed: boolean }) {
  const content = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [copied, copy] = useCopy(code);
  // No choice yet: source while the fence is still arriving, the visual once
  // it closes. A choice, once made, outlives the stream.
  const [chosen, setChosen] = useState<"visual" | "code" | null>(null);
  // `useId` is per-instance and stable across re-renders; the punctuation it
  // carries is not valid in a class name or an id.
  const scope = `kv${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const visual = useMemo(() => prepareVisual(code, scope), [code, scope]);
  // Nothing survived the allowlist (or the fence held prose, not markup):
  // there is no visual to offer and the block is an ordinary code block.
  const renderable = /<[A-Za-z]/.test(visual.html);
  const showVisual = renderable && (chosen ?? (closed ? "visual" : "code")) === "visual";
  const actions = (
    <>
      {renderable ? (
        <BlockAction
          label={showVisual ? "Code" : "Preview"}
          title={showVisual ? "Show the source" : "Render it"}
          onClick={() => setChosen(showVisual ? "code" : "visual")}
        />
      ) : null}
      <BlockAction label={copied ? "Copied" : "Copy"} title="Copy code" active={copied} onClick={copy} />
    </>
  );
  return showVisual ? (
    // A page leaves the reading column (`.inline-visual-page`, tokens.css);
    // a drawing stays in it, sized to itself by `fitVisualCanvases`.
    <figure className={`inline-visual${visual.kind === "page" ? " inline-visual-page" : ""}`} style={{ minWidth: 0 }}>
      <div ref={content}><VisualSurface visual={visual} scope={scope} /></div>
      <div className="inline-visual-actions" role="group" aria-label="Visual controls">
        <VisualControl className="visual-control-more" label="Show code" onClick={() => setChosen("code")}><CodeIcon size={15} /><span className="visual-sr-only">Code</span></VisualControl>
        <VisualControl className="visual-control-more" label={copied ? "Copied" : "Copy code"} onClick={copy}>{copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}</VisualControl>
        <VisualSaveButton content={content} />
        <span className="visual-toolbar-divider visual-control-more" aria-hidden="true" />
        <VisualControl label="Open fullscreen" onClick={event => { event.currentTarget.focus(); setExpanded(true); }}><VisualExpandIcon expanded={expanded} size={15} /></VisualControl>
      </div>
      {expanded ? <VisualViewer code={code} origin={content} onClose={() => setExpanded(false)} /> : null}
    </figure>
  ) : (
    <BlockShell lang={lang} actions={actions}>
      <CodeBody code={code} />
    </BlockShell>
  );
}

// One inline node at a time. Match the earliest of all supported patterns;
// anything else flows through as plain text (HTML-safe by construction).
// The bare-URL alternative comes last so a markdown link still wins: the
// engine scans left to right, and `[text](url)` starts at its `[`, before the
// URL it contains. Its shape is `BARE_URL_RE`'s alone — one source, so prose
// and the opener agree on where a URL ends.
const INLINE_RE = new RegExp(
  /\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|`([^`]+)`|\*(.+?)\*|~~([^~]+)~~|\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/
    .source + `|(${BARE_URL_RE.source})`,
  "g"
);

// `safeLinkHref` and the opening itself belong to `externalLink.ts` — the one
// door out of the app webview. Re-exported here because this renderer was its
// only caller when it was written.
export { safeLinkHref };

// A link in a model's answer. It never navigates the app webview: the click is
// handed to `openExternal`, which sends it to the system browser. The href is
// still set so the URL shows in a hover, and copy-link keeps working.
//
// `mark` is drawn only where there is a brand to draw. A glyph in front of
// words the author chose ("see the docs") would be decoration; a mark in front
// of a name Klide supplied for a naked URL is what makes the name legible.
function ExternalLink({
  href,
  title,
  mark,
  children,
}: {
  href: string;
  title?: string;
  mark?: LinkSite | null;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      title={title ?? href}
      onClick={(e) => {
        e.preventDefault();
        void openExternal(href);
      }}
      style={{
        color: "var(--accent)",
        textDecoration: "underline",
        textDecorationColor: "color-mix(in srgb, var(--accent) 35%, transparent)",
        textUnderlineOffset: 2,
        cursor: "pointer",
        // The mark rides with the name: inline-flex keeps them one unit, so a
        // wrap never leaves a lone glyph at the end of a line.
        ...(mark !== undefined
          ? {
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              // Keeps the line's rhythm — an inline-flex box would otherwise
              // sit on its own box's baseline and ride low against the prose.
              verticalAlign: "baseline",
              whiteSpace: "nowrap" as const,
            }
          : null),
      }}
    >
      {mark !== undefined ? <LinkMark site={mark} /> : null}
      {children}
    </a>
  );
}

const INLINE_CODE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.9em",
  background: "color-mix(in srgb, var(--bg-elevated) 80%, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "1px 5px",
  color: "var(--fg)",
};

// A place on disk, written in backticks. It reads like every other openable
// thing in an answer — accent, underlined, the full address on hover — because
// that is what it is: `openExternal` hands a URL to the browser, `revealPath`
// hands this to Finder. A rooted path reads as its last word (`Onetraak`), the
// same reduction a bare URL gets; a project-relative one is already short and
// stands as written.
function PathLink({ text }: { text: string }) {
  const place = pathFromCodeSpan(text);
  if (!place) return <code style={INLINE_CODE_STYLE}>{text}</code>;
  const title = place.line
    ? `Show ${place.path} in Finder (line ${place.line})`
    : `Show ${place.path} in Finder`;
  return (
    <a
      className="klide-path-link"
      role="button"
      tabIndex={0}
      title={title}
      onClick={(e) => {
        e.preventDefault();
        void revealPath(place);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        void revealPath(place);
      }}
    >
      {pathLabel(place.path)}
    </a>
  );
}

function renderInline(text: string, keyBase: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  // Emphasis renders its contents through this same function — a model writes
  // **`src/App.tsx`** and means both — so the scan cannot share `lastIndex`
  // with the nested call. One matcher per invocation; `INLINE_RE` stays the
  // single definition of the shapes.
  const re = new RegExp(INLINE_RE.source, "g");
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const nested = (inner: string) => renderInline(inner, `${keyBase}-${key}n`);
    if (m[1] !== undefined) {
      out.push(
        <strong key={`${keyBase}-${key++}`} style={{ fontWeight: 700, color: "var(--fg-strong)" }}>
          <em style={{ fontStyle: "italic", fontWeight: 600 }}>{nested(m[1])}</em>
        </strong>
      );
    } else if (m[2] !== undefined) {
      out.push(
        <strong key={`${keyBase}-${key++}`} style={{ fontWeight: 600, color: "var(--fg-strong)" }}>
          {nested(m[2])}
        </strong>
      );
    } else if (m[3] !== undefined) {
      out.push(<PathLink key={`${keyBase}-${key++}`} text={m[3]} />);
    } else if (m[4] !== undefined) {
      out.push(
        <em key={`${keyBase}-${key++}`} style={{ fontStyle: "italic", color: "var(--fg)" }}>
          {nested(m[4])}
        </em>
      );
    } else if (m[5] !== undefined) {
      out.push(
        <span
          key={`${keyBase}-${key++}`}
          style={{ textDecoration: "line-through", color: "var(--fg-subtle)" }}
        >
          {nested(m[5])}
        </span>
      );
    } else if (m[6] !== undefined) {
      const href = safeLinkHref(m[7]);
      if (!href) {
        out.push(m[6]);
        last = m.index + m[0].length;
        continue;
      }
      // The author named it, so the name stands. A known brand still earns its
      // mark; an unknown host gets no glyph, because the words already read.
      const brand = linkIdentity(href).site;
      out.push(
        <ExternalLink
          key={`${keyBase}-${key++}`}
          href={href}
          title={m[8]}
          mark={brand ?? undefined}
        >
          {m[6]}
        </ExternalLink>
      );
    } else if (m[9] !== undefined) {
      // A URL written as prose. Nobody reads a 90-character address mid
      // sentence, so it reads as the one word inside it that carries meaning —
      // the repo, the package, the product — with the full address on hover.
      // The punctuation that ended the sentence stays outside the link.
      const [raw, trailing] = splitUrlTail(m[9]);
      const href = safeLinkHref(raw);
      if (!href) out.push(m[9]);
      else {
        const id = linkIdentity(href);
        out.push(
          <ExternalLink
            key={`${keyBase}-${key++}`}
            href={href}
            mark={id.bare ? undefined : id.site}
          >
            {id.label}
          </ExternalLink>
        );
        if (trailing) out.push(trailing);
      }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// The streaming tail: the same inline render, but the last plain-text run is
// split one span per word (a word plus its trailing space) so only the words
// that just arrived mount — and animate. Keys are positional; the text only
// grows at its end, so an existing word keeps its key and its node.
function renderInlineTail(text: string, keyBase: string): MdNode[] {
  const nodes = renderInline(text, keyBase);
  const lastIdx = nodes.length - 1;
  const last = nodes[lastIdx];
  if (typeof last !== "string") return nodes;
  const words: MdNode[] = [];
  const re = /\S+\s*/g;
  let w = 0;
  let m: RegExpExecArray | null;
  const lead = /^\s*/.exec(last)?.[0] ?? "";
  if (lead) words.push(lead);
  re.lastIndex = lead.length;
  while ((m = re.exec(last))) {
    words.push(
      <span key={`${keyBase}-w${w++}`} className="ai-word-in">
        {m[0]}
      </span>
    );
  }
  return [...nodes.slice(0, lastIdx), ...words];
}

// Block-level renderer: handles headers, ordered/unordered/task lists,
// blockquotes, horizontal rules, and paragraph breaks. Operates on a string
// that's already had fenced code blocks extracted (so we don't run formatting
// on code contents).
function renderProse(text: string, keyBase: string, options?: MarkdownOptions): MdNode[] {
  const lines = text.split("\n");
  const blocks: MdNode[] = [];
  let para: string[] = [];
  type ListState = { kind: "ul" | "ol" | "tasks"; items: string[] };
  let list: ListState | null = null;
  let k = 0;
  // True only for the final flush of a streaming render: the block being
  // flushed is the one the model is still typing into.
  let atTail = false;
  const inline = (text: string, kb: string, lastOfBlock: boolean) =>
    lastOfBlock && atTail ? renderInlineTail(text, kb) : renderInline(text, kb);

  const flushPara = () => {
    if (para.length === 0) return;
    const content: MdNode[] = [];
    para.forEach((ln, i) => {
      if (i > 0) content.push(<br key={`br-${keyBase}-${k}-${i}`} />);
      content.push(...inline(ln, `${keyBase}-p${k}-${i}`, i === para.length - 1));
    });
    blocks.push(
      <div
        key={`${keyBase}-para-${k++}`}
        style={{ margin: "2px 0", color: "var(--fg)", lineHeight: 1.6 }}
      >
        {content}
      </div>
    );
    para = [];
  };

  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => {
      if (list!.kind === "tasks") {
        const done = it.startsWith("[x] ");
        const text = it.replace(/^\[[ x]\]\s+/, "");
        return (
          <li
            key={`${keyBase}-li-${k}-${i}`}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 7,
              padding: "2px 0",
              fontSize: 12.5,
              lineHeight: 1.55,
              color: done ? "var(--fg-subtle)" : "var(--fg)",
              textDecoration: done ? "line-through" : "none",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 12,
                height: 12,
                flexShrink: 0,
                marginTop: 2,
                borderRadius: 3,
                border: done
                  ? "1px solid var(--accent)"
                  : "1px solid var(--border)",
                background: done ? "var(--accent)" : "transparent",
                display: "grid",
                placeItems: "center",
                color: "var(--bg)",
                fontSize: 9,
                fontWeight: 700,
                lineHeight: 1,
              }}
            >
              {done ? "✓" : ""}
            </span>
            <span style={{ flex: 1 }}>{inline(text, `${keyBase}-li${k}-${i}`, i === list!.items.length - 1)}</span>
          </li>
        );
      }
      return (
        <li
          key={`${keyBase}-li-${k}-${i}`}
          style={{ margin: "1px 0" }}
        >
          {inline(it, `${keyBase}-li${k}-${i}`, i === list!.items.length - 1)}
        </li>
      );
    });
    if (list.kind === "ul") {
      blocks.push(
        <ul
          key={`${keyBase}-ul-${k++}`}
          style={{ margin: "4px 0", paddingLeft: 0, listStyle: "none" }}
        >
          {items}
        </ul>
      );
    } else if (list.kind === "ol") {
      blocks.push(
        <ol
          key={`${keyBase}-ol-${k++}`}
          style={{ margin: "4px 0", paddingLeft: 22 }}
        >
          {items}
        </ol>
      );
    } else {
      blocks.push(
        <ul
          key={`${keyBase}-tasks-${k++}`}
          style={{ margin: "4px 0", paddingLeft: 0, listStyle: "none" }}
        >
          {items}
        </ul>
      );
    }
    list = null;
  };

  // GFM table: a run of `| … |` lines whose second line is the `---`
  // separator row. Anything that doesn't validate flows back into the
  // paragraph buffer untouched.
  let tableBuf: string[] | null = null;
  const splitRow = (line: string): string[] =>
    line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const flushTable = () => {
    if (!tableBuf) return;
    const buf = tableBuf;
    tableBuf = null;
    const sepRe = /^:?-{2,}:?$/;
    const isSep = buf.length >= 2 && splitRow(buf[1]).every((c) => sepRe.test(c));
    if (!isSep) {
      para.push(...buf);
      return;
    }
    const header = splitRow(buf[0]);
    const aligns = splitRow(buf[1]).map((c) =>
      c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"
    ) as Array<"left" | "center" | "right">;
    const rows = buf.slice(2).map(splitRow);
    const cellStyle = (col: number): CSSProperties => ({
      padding: "5px 12px",
      fontSize: 12,
      lineHeight: 1.5,
      textAlign: aligns[col] ?? "left",
      verticalAlign: "top",
    });
    blocks.push(
      <div
        key={`${keyBase}-table-${k++}`}
        style={{
          margin: "8px 0",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
          overflowX: "auto",
        }}
      >
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "max-content" }}>
          <thead>
            <tr style={{ background: "color-mix(in srgb, var(--bg-elevated) 80%, var(--bg))" }}>
              {header.map((cell, ci) => (
                <th
                  key={ci}
                  style={{
                    ...cellStyle(ci),
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "0.07em",
                    textTransform: "uppercase",
                    color: "var(--fg-subtle)",
                    fontFamily: "var(--font-mono)",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  {renderInline(cell, `${keyBase}-th${k}-${ci}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {header.map((_, ci) => (
                  <td
                    key={ci}
                    style={{
                      ...cellStyle(ci),
                      color: "var(--fg)",
                      borderTop: ri > 0 ? "1px solid var(--border)" : "none",
                    }}
                  >
                    {renderInline(row[ci] ?? "", `${keyBase}-td${k}-${ri}-${ci}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  let inBlockquote = false;
  let bqBuf: string[] = [];
  const flushBlockquote = () => {
    if (bqBuf.length === 0) return;
    blocks.push(
      <blockquote
        key={`${keyBase}-bq-${k++}`}
        style={{
          margin: "6px 0",
          padding: "4px 12px",
          borderLeft: "2px solid var(--border-strong, var(--border))",
          color: "var(--fg-subtle)",
          fontStyle: "italic",
        }}
      >
        {renderProse(bqBuf.join("\n"), `${keyBase}-bq-${k}`, options)}
      </blockquote>
    );
    bqBuf = [];
  };

  for (const line of lines) {
    // Table lines (`| a | b |`). Collect the run; flushTable validates the
    // separator row and falls back to plain text when it isn't a table.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (!tableBuf) {
        flushPara();
        flushList();
        tableBuf = [];
      }
      tableBuf.push(line);
      continue;
    } else if (tableBuf) {
      flushTable();
    }
    // Wire-format tool marker (`[tool: <name> <summary>]` on its own line).
    // Emitted by the opencode / codex delegate run flat­teners. Only honored
    // when the caller passes `renderTool`; otherwise the line falls through
    // to plain text so the AI panel's path is unaffected.
    if (options?.renderTool) {
      const toolMatch = /^\[tool:\s*([^\]]+)\]\s*$/.exec(line);
      if (toolMatch) {
        flushPara();
        flushList();
        flushBlockquote();
        const marker = toolMatch[1].trim();
        const m = marker.match(/^([^\s(:]+)(?:\s+(.+))?$/);
        const toolName = m?.[1] ?? (marker || "tool");
        const toolSummary = m?.[2]?.trim();
        blocks.push(
          <div key={`${keyBase}-tool-${k++}`} style={{ margin: "2px 0" }}>
            {options.renderTool(toolName, toolSummary)}
          </div>
        );
        continue;
      }
    }
    // Blockquote lines (`> text`).
    if (/^>\s?/.test(line)) {
      flushPara();
      flushList();
      bqBuf.push(line.replace(/^>\s?/, ""));
      inBlockquote = true;
      continue;
    } else if (inBlockquote) {
      flushBlockquote();
      inBlockquote = false;
    }
    // Horizontal rule (`---` on its own line).
    if (/^-{3,}\s*$|^\*{3,}\s*$/.test(line.trim())) {
      flushPara();
      flushList();
      blocks.push(
        <hr
          key={`${keyBase}-hr-${k++}`}
          style={{
            border: "none",
            borderTop: "1px solid var(--border)",
            margin: "10px 0",
          }}
        />
      );
      continue;
    }
    // Headings.
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      const size = level === 1 ? 16 : level === 2 ? 14 : 13;
      const weight = level === 1 ? 700 : 600;
      blocks.push(
        <div
          key={`${keyBase}-h-${k++}`}
          style={{
            fontWeight: weight,
            fontSize: size,
            color: "var(--fg-strong)",
            margin: `${level === 1 ? 12 : 8}px 0 2px`,
            lineHeight: 1.3,
          }}
        >
          {renderInline(heading[2], `${keyBase}-hh${k}`)}
        </div>
      );
      continue;
    }
    // Task list.
    if (/^[-*]\s+\[[ x]\]\s+/.test(line)) {
      flushPara();
      if (!list || list.kind !== "tasks") {
        flushList();
        list = { kind: "tasks", items: [] };
      }
      list.items.push(line.replace(/^[-*]\s+/, ""));
      continue;
    }
    // Unordered list.
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      if (!list || list.kind !== "ul") {
        flushList();
        list = { kind: "ul", items: [] };
      }
      list.items.push(ul[1]);
      continue;
    }
    // Ordered list.
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      if (!list || list.kind !== "ol") {
        flushList();
        list = { kind: "ol", items: [] };
      }
      list.items.push(ol[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushTable();
  atTail = !!options?.streaming;
  flushPara();
  flushList();
  flushBlockquote();
  return blocks;
}

export function splitThinking(raw: string): { thinking: string; content: string } {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let thinking = "";
  let content = "";
  let rest = raw;
  while (true) {
    const open = rest.indexOf(OPEN);
    if (open === -1) { content += rest; break; }
    content += rest.slice(0, open);
    const after = rest.slice(open + OPEN.length);
    const close = after.indexOf(CLOSE);
    if (close === -1) { thinking += after; break; }
    thinking += after.slice(0, close);
    rest = after.slice(close + CLOSE.length);
  }
  return { thinking, content: content.replace(/^\s+/, "") };
}

type StrippedPlan = { thinking: string; content: string };

/**
 * Some local chat models (qwen, gemma, smaller ollama weights) emit a
 * structured "plan" JSON in their visible text — `{ analysis, plan,
 * commands }` — instead of the `<think>…</think>` format. The
 * `commands` field is a would-be tool call (read_file, get_git_status,
 * etc.) that chat mode doesn't honour, so the JSON is pure noise to
 * the reader. Lift the analysis + plan into the thinking channel and
 * leave the user-visible text empty; the UI's existing "I'm in chat
 * mode" reasoning block carries the answer.
 *
 * The detector is intentionally conservative:
 *   - the entire response must be a single JSON object (after a trim),
 *   - the object must carry at least one of the known plan keys.
 *
 * A "here's the answer, and here's a JSON plan after it" reply is left
 * alone — the JSON is part of the user's answer in that case, not
 * reasoning.
 */
export function stripPlanJson(raw: string): StrippedPlan {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return { thinking: "", content: raw };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { thinking: "", content: raw };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { thinking: "", content: raw };
  }
  const obj = parsed as Record<string, unknown>;
  const analysis = typeof obj.analysis === "string" ? obj.analysis : "";
  const plan = typeof obj.plan === "string" ? obj.plan : "";
  const commands = Array.isArray(obj.commands) ? obj.commands : [];
  const hasPlanShape =
    analysis.length > 0 || plan.length > 0 || commands.length > 0;
  if (!hasPlanShape) {
    return { thinking: "", content: raw };
  }
  // Render the analysis + plan + command list in the thinking channel.
  // Commands are summarised as a short list so the user can see what
  // the model *wanted* to do — useful when they're trying to figure
  // out why the model went silent in chat mode.
  const parts: string[] = [];
  if (analysis) parts.push(analysis);
  if (plan) parts.push(plan);
  if (commands.length > 0) {
    const cmds = commands
      .slice(0, 8)
      .map((c) => {
        if (!c || typeof c !== "object") return "- (invalid command)";
        const o = c as Record<string, unknown>;
        const name = typeof o.tool_name === "string" ? o.tool_name : "tool";
        const args = o.arguments;
        const argText =
          args && typeof args === "object"
            ? " " +
              Object.entries(args as Record<string, unknown>)
                .slice(0, 3)
                .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                .join(" ")
            : "";
        return `- ${name}${argText}`;
      })
      .join("\n");
    parts.push(`Would have called:\n${cmds}`);
  }
  return { thinking: parts.join("\n\n"), content: "" };
}

/** Parsed nodes for settled text, keyed by the text itself. Elements are
 *  immutable descriptions, so one array can back the same message on every
 *  render — and the same text in two rows. Bounded; oldest entry goes first. */
const PARSE_CACHE = new Map<string, MdNode[]>();
const PARSE_CACHE_MAX = 400;

export function renderMarkdown(text: string, options?: MarkdownOptions): MdNode[] {
  // A streaming tail changes on every tick and would only churn the cache; a
  // `renderTool` hook makes the output depend on the caller, not the text.
  const cacheable = !options?.streaming && !options?.renderTool;
  if (cacheable) {
    const hit = PARSE_CACHE.get(text);
    if (hit) return hit;
  }
  const out = parseMarkdown(text, options);
  if (cacheable) {
    if (PARSE_CACHE.size >= PARSE_CACHE_MAX) {
      const oldest = PARSE_CACHE.keys().next().value;
      if (oldest !== undefined) PARSE_CACHE.delete(oldest);
    }
    PARSE_CACHE.set(text, out);
  }
  return out;
}

// A drawing the model forgot to fence. The visualizer's contract is a fenced
// `html` / `svg` block and the prompt asks for one, but a model sometimes
// writes `<svg …>…</svg>` straight into the prose — and the reader gets a
// page of angle brackets instead of the picture. Markup that opens at the
// start of a line and closes is the same intent as a fence, so it is given
// one before parsing. While the text is still arriving, an `<svg` at the tail
// that has not closed yet is fenced too, so it is held as source until it
// does — like any other streaming fence. Only an `<svg>` or a whole `<html>`
// document qualify: a bare `<div>` in prose is as often a quotation as a
// drawing. Segments inside real fences are never touched.
const BARE_MARKUP_OPEN = /^[ \t]*<(svg|!doctype html|html)\b/gim;

function closeOfBareMarkup(seg: string, from: number, kind: "svg" | "html"): number {
  if (kind === "html") {
    const end = seg.indexOf("</html>", from);
    return end < 0 ? -1 : end + "</html>".length;
  }
  // Nested `<svg>` (a symbol inside a drawing) must not end the block early.
  const tag = /<svg\b|<\/svg\s*>/gi;
  tag.lastIndex = from;
  let depth = 0;
  for (let m = tag.exec(seg); m; m = tag.exec(seg)) {
    if (m[0][1] === "/") {
      if (--depth === 0) return m.index + m[0].length;
    } else depth++;
  }
  return -1;
}

function fenceBareMarkupInProse(seg: string, tail: boolean): string {
  let out = "";
  let cursor = 0;
  BARE_MARKUP_OPEN.lastIndex = 0;
  for (let m = BARE_MARKUP_OPEN.exec(seg); m; m = BARE_MARKUP_OPEN.exec(seg)) {
    if (m.index < cursor) continue;
    const start = m.index + m[0].indexOf("<");
    const kind = m[1].toLowerCase() === "svg" ? "svg" : "html";
    const end = closeOfBareMarkup(seg, start, kind);
    if (end < 0) {
      // Unclosed. Only the streaming tail may hold it open as source; a
      // finished message that never closed its tag stays what it is — text.
      if (tail) return out + seg.slice(cursor, start) + "```" + kind + "\n" + seg.slice(start);
      continue;
    }
    out += seg.slice(cursor, start) + "```" + kind + "\n" + seg.slice(start, end) + "\n```";
    cursor = end;
    BARE_MARKUP_OPEN.lastIndex = end;
  }
  return out + seg.slice(cursor);
}

export function fenceBareMarkup(text: string, streaming = false): string {
  BARE_MARKUP_OPEN.lastIndex = 0;
  if (!BARE_MARKUP_OPEN.test(text)) return text;
  const segments = text.split("```");
  return segments
    .map((seg, idx) => (idx % 2 === 1 ? seg : fenceBareMarkupInProse(seg, streaming && idx === segments.length - 1)))
    .join("```");
}

function parseMarkdown(text: string, options?: MarkdownOptions): MdNode[] {
  // Split on ``` so every odd-indexed segment is a code block and every
  // even-indexed segment is prose. Render code blocks first so their
  // contents (which can contain their own ```) are not interpreted again.
  const segments = fenceBareMarkup(text, options?.streaming === true).split("```");
  const out: MdNode[] = [];
  segments.forEach((seg, idx) => {
    if (idx % 2 === 1) {
      const nl = seg.indexOf("\n");
      let lang = "";
      let code = seg;
      if (nl >= 0) {
        const first = seg.slice(0, nl).trim();
        if (/^[\w+#-]*$/.test(first)) { lang = first; code = seg.slice(nl + 1); }
      }
      code = code.replace(/\n$/, "");
      // A fence the split did not close is the streaming tail: its markup is
      // half-written, so it stays source until the closing fence arrives.
      const closed = idx < segments.length - 1;
      out.push(
        VISUAL_LANGS.has(lang.toLowerCase())
          ? <VisualBlock key={`code-${idx}`} code={code} lang={lang} closed={closed} />
          : <CodeBlock key={`code-${idx}`} code={code} lang={lang} />,
      );
    } else if (seg) {
      // Only the last segment can be the streaming tail; an earlier one is
      // already closed off by a code fence.
      const last = idx === segments.length - 1;
      out.push(...renderProse(seg, `seg-${idx}`, last ? options : { ...options, streaming: false }));
    }
  });
  return out;
}

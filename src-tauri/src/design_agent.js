// Klide Design mode — the picker that runs inside the framed page.
// Served by design_canvas.rs, which replaces the token below per canvas. It
// reports what the pointer is over and what was clicked, applies live style
// and text edits Klide asks for, and nothing else. Every message carries the
// token; messages without it are ignored in both directions.
(() => {
  if (window.top === window || window.__klideDesign) return;
  window.__klideDesign = true;
  const TOKEN = "__KLIDE_TOKEN__";
  let tool = "select";
  const ids = new WeakMap();
  const byId = new Map();
  let nextId = 1;
  let watched = [];

  const post = (msg) => parent.postMessage({ klideDesign: TOKEN, ...msg }, "*");
  const idOf = (el) => {
    let id = ids.get(el);
    if (!id) { id = nextId++; ids.set(el, id); byId.set(id, new WeakRef(el)); }
    return id;
  };
  const get = (id) => byId.get(id)?.deref() ?? null;
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };

  // The React component that rendered an element, read from the dev build.
  function componentOf(el) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let fiber = key ? el[key] : null;
    const names = [];
    while (fiber && names.length < 2) {
      const t = fiber.type;
      const name = typeof t === "function" ? t.displayName || t.name : t && typeof t === "object" ? t.displayName || (t.render && t.render.name) : null;
      if (name && /^[A-Z]/.test(name) && names[0] !== name) names.push(name);
      fiber = fiber.return;
    }
    return names.reverse().join(" › ") || "";
  }
  function describe(el) {
    const aria = el.getAttribute("aria-label");
    const text = (el.textContent || "").trim().replace(/\s+/g, " ");
    const hint = aria || (text ? `“${text.slice(0, 32)}${text.length > 32 ? "…" : ""}”` : "");
    return `${el.tagName.toLowerCase()}${hint ? " " + hint : ""}`;
  }
  const leafText = (el) => (el.children.length === 0 && (el.textContent || "").trim() ? el.textContent : null);
  function readStyle(el) {
    const s = getComputedStyle(el);
    return { paddingTop: s.paddingTop, paddingRight: s.paddingRight, gap: s.gap === "normal" ? "0px" : s.gap, fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color, backgroundColor: s.backgroundColor, borderRadius: s.borderTopLeftRadius };
  }
  // Tokens the page defines, resolved, so Klide can offer the page's own scale.
  function tokens() {
    const out = {};
    const root = getComputedStyle(document.documentElement);
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of Array.from(rules || [])) {
        if (!rule.style || !/^:root/.test(rule.selectorText || "")) continue;
        for (const name of Array.from(rule.style)) if (name.startsWith("--") && !(name in out)) out[name] = root.getPropertyValue(name).trim();
      }
    }
    return out;
  }
  const facts = (el) => ({ id: idOf(el), component: componentOf(el), where: describe(el), style: readStyle(el), text: leafText(el), rect: box(el) });
  const targetOf = (e) => (e.target instanceof Element ? e.target : null);
  const editable = (el) => el && el.closest && el.closest("input, textarea, select, [contenteditable]");

  const cursor = document.createElement("style");
  const setTool = (next) => {
    tool = next;
    cursor.textContent = tool === "use" ? "" : `*, *::before, *::after { cursor: ${tool === "comment" ? "crosshair" : "default"} !important; }`;
    if (!cursor.isConnected) (document.head || document.documentElement).appendChild(cursor);
    if (tool === "use") post({ type: "hover", rect: null });
  };

  let frame = 0;
  const sendRects = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      post({ type: "rects", rects: watched.map((id) => { const el = get(id); return { id, rect: el && el.isConnected ? box(el) : null }; }) });
    });
  };

  document.addEventListener("mousemove", (e) => {
    if (tool === "use") return;
    const el = targetOf(e);
    post({ type: "hover", rect: el ? box(el) : null });
  }, true);
  document.addEventListener("mouseleave", () => post({ type: "hover", rect: null }), true);
  for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "auxclick"]) {
    document.addEventListener(type, (e) => {
      if (tool === "use") return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const el = targetOf(e);
      if (type === "click" && el) post({ type: "pick", tool, element: facts(el) });
    }, true);
  }
  document.addEventListener("scroll", () => { post({ type: "scrolling" }); sendRects(); }, true);
  window.addEventListener("resize", sendRects);
  document.addEventListener("keydown", (e) => {
    if (editable(e.target) && tool === "use") return;
    if (["Escape", "v", "c", "u"].includes(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (editable(e.target)) return;
      post({ type: "key", key: e.key });
    }
  }, true);
  new ResizeObserver(sendRects).observe(document.documentElement);

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (e.source !== parent || !m || m.klideDesign !== TOKEN) return;
    if (m.type === "tool") setTool(m.tool);
    if (m.type === "watch") { watched = m.ids; sendRects(); }
    if (m.type === "set" || m.type === "unset") {
      const el = get(m.id);
      if (!el) return;
      if (m.prop === "text") el.textContent = m.type === "set" ? m.value : m.from;
      else if (m.type === "set") el.style.setProperty(m.prop, m.value);
      else el.style.removeProperty(m.prop);
      post({ type: "facts", element: facts(el) });
      sendRects();
    }
  });

  const ready = () => { setTool(tool); post({ type: "ready", url: location.href, title: document.title, tokens: tokens() }); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
  window.addEventListener("load", () => post({ type: "tokens", tokens: tokens() }), { once: true });
})();

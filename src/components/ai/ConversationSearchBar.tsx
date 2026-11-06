import { forwardRef, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronIcon, CloseIcon, SearchIcon } from "../../icons";
import { Tooltip } from "../Tooltip";
import type { Msg } from "./types";
import { searchConversation, type ConversationMatch } from "./transcriptNavigation";
import "./conversationSearch.css";

export type ConversationSearchHandle = { find: () => void; dismiss: () => boolean };
type Props = {
  messages: readonly Msg[];
  onReveal: (index: number, match?: ConversationMatch) => void;
  onCloseSearch: () => void;
  insetRight?: string;
};
const actionStyle: CSSProperties = {
  display: "grid", placeItems: "center", width: 26, height: 26, flexShrink: 0,
  border: "none", borderRadius: "var(--radius-full, 999px)",
};

/** An in-chat find bar. Dormant until the focused conversation receives Cmd+F. */
export const ConversationSearchBar = forwardRef<ConversationSearchHandle, Props>(function ConversationSearchBar({ messages, onReveal, onCloseSearch, insetRight = "12px" }, ref) {
  const [open, setOpen] = useState(false);
  const [present, setPresent] = useState(false);
  const [query, setQuery] = useState("");
  const [includeReasoning, setIncludeReasoning] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const [selection, setSelection] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const matches = useMemo(() => present ? searchConversation(messages, deferredQuery, { includeReasoning }) : [], [messages, deferredQuery, present, includeReasoning]);
  const selected = Math.min(selection, Math.max(0, matches.length - 1));
  const pending = query !== deferredQuery;
  const find = () => {
    if (!open) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setSelection(0);
    }
    setPresent(true);
    setOpen(true);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  };
  useEffect(() => {
    if (open || !present) return;
    const timer = window.setTimeout(() => setPresent(false), 180);
    return () => window.clearTimeout(timer);
  }, [open, present]);
  const revealRef = useRef(onReveal);
  revealRef.current = onReveal;
  useEffect(() => {
    if (open && deferredQuery.trim() && matches[0]) revealRef.current(matches[0].index, matches[0]);
    // Query or scope changes reveal their first match. Streaming never moves the reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredQuery, open, includeReasoning]);
  const close = () => {
    setOpen(false); onCloseSearch();
    if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
  };
  const dismiss = () => {
    if (!open) return false;
    close();
    return true;
  };
  useImperativeHandle(ref, () => ({ find, dismiss }));
  const go = (position: number) => {
    if (!open || !matches.length || pending) return;
    const next = (position + matches.length) % matches.length;
    setSelection(next); onReveal(matches[next].index, matches[next]);
  };
  if (!present) return null;
  return <div role="search" aria-label="Search this conversation" className="conversation-search-bar" data-open={open} inert={!open} aria-hidden={!open || undefined}
    style={{ position: "absolute", top: 8, right: insetRight, zIndex: 3, width: 360, maxWidth: `calc(100% - ${insetRight} - 12px)`,
      display: "flex", flexDirection: "column", gap: 8, padding: "6px 8px 6px 12px", boxSizing: "border-box",
      border: "none", borderRadius: "var(--radius-xl)", background: "var(--bg-elevated)",
      boxShadow: "0 0 0 1px var(--panel-border), var(--panel-shadow)",
      color: "var(--fg)", fontFamily: "var(--font-ui)", fontSize: "var(--fs-base)" }}
    onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
    }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0 }}>
    <SearchIcon size={16} style={{ flexShrink: 0, color: "var(--fg-subtle)" }} />
    <input ref={input} type="search" className="conversation-search-input klide-bare-filter" aria-label="Find in conversation" placeholder="Find in conversation…" value={query}
      onChange={event => { setQuery(event.target.value); setSelection(0); onCloseSearch(); }}
      onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); go(event.shiftKey ? selected - 1 : selected + 1); }
      }} />
    <span role="status" className="conversation-search-count" style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-xs)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
      {pending ? "…" : matches.length ? `${selected + 1} / ${matches.length}` : query.trim() ? "No matches" : ""}
    </span>
    <div style={{ display: "flex", alignItems: "center", flexShrink: 0, gap: 2 }}>
      <Tooltip label="Previous match"><button type="button" className="conversation-search-action" style={actionStyle} aria-label="Previous match" disabled={!matches.length || pending} onClick={() => go(selected - 1)}><ChevronIcon size={14} open /></button></Tooltip>
      <Tooltip label="Next match"><button type="button" className="conversation-search-action" style={actionStyle} aria-label="Next match" disabled={!matches.length || pending} onClick={() => go(selected + 1)}><ChevronIcon size={14} /></button></Tooltip>
      <Tooltip label="Include reasoning" placement="bottom" showOnClick>
        <button type="button" role="switch" aria-label="Include reasoning" aria-checked={includeReasoning}
          className="klide-switch conversation-search-reasoning" data-checked={includeReasoning}
          onClick={() => { onCloseSearch(); setSelection(0); setIncludeReasoning(value => !value); }}>
          <span className="klide-switch-knob" />
        </button>
      </Tooltip>
      <Tooltip label="Close search"><button type="button" className="conversation-search-action" style={actionStyle} aria-label="Close conversation search" onClick={close}><CloseIcon size={14} /></button></Tooltip>
    </div>
    </div>

  </div>;
});

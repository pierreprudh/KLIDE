import { GithubObserverCard, type ObserverSidebar } from "./GithubObserverCard";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { createListenerScope } from "../../tauriEvents";
import { listObservers, stopObserver, observerLabel, type Observer } from "../../agent/observers";
import { notify } from "../../toast";
import { DotGridLoader } from "./icons";
import { useElapsed } from "./WorkingRow";
import { createPortal } from "react-dom";
import type { Msg } from "./types";
import { mergeObserverCards } from "../../agent/observerCards";

export function observerMessageIndex(msgs: Msg[], id: string): number | null {
  const start = msgs.findIndex(msg => msg.role === "tool" && msg.toolName === "run_command" && msg.content.startsWith("Watching `") && msg.content.includes(` as \`${id}\`.`));
  if (start < 0) return null;
  let anchor: number | null = null;
  for (let i = start + 1; i < msgs.length; i++) {
    if (msgs[i].role === "user" || msgs[i].role === "system") break;
    if (msgs[i].role === "assistant") anchor = i;
  }
  return anchor;
}

/** A conversation can be idle while its observers are working. These rows
 * stay separate from the reply's Working row, so sending remains available. */
export function ConversationObservers({ runId, onFollowup, sidebar, onGithubPresence, msgs, messageRoot }: {
  runId: string;
  msgs: Msg[];
  messageRoot: HTMLElement | null;
  sidebar?: ObserverSidebar;
  onGithubPresence?: (runId: string, present: boolean) => void;
  /** False means a local turn is still cleaning up; try after it releases. */
  onFollowup: () => boolean;
}) {
  const [observers, setObservers] = useState<Observer[]>(() => mergeObserverCards(runId, []));
  const follow = useRef(onFollowup);
  follow.current = onFollowup;
  const hasGithub = observers.some(observer => observer.githubWatch);
  useEffect(() => { onGithubPresence?.(runId, hasGithub); }, [runId, hasGithub, onGithubPresence]);
  useEffect(() => {
    setObservers(mergeObserverCards(runId, []));
    let alive = true;
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;
    const scope = createListenerScope();
    scope.add(listen<string>("agent-observer-wake", ({ payload }) => {
      if (payload === runId) pending = true;
    }));
    // Completion is a second signal in case a very short follow-up finished
    // before this view could attach. The transcript remains the authority.
    scope.add(listen<string>("agent-observer-finished", ({ payload }) => {
      if (payload === runId) pending = true;
    }));
    const refresh = async () => {
      try {
        const rows = await listObservers(runId);
        if (!alive) return;
        setObservers(mergeObserverCards(runId, rows));
        if (pending && follow.current()) pending = false;
      } catch { /* Browser previews have no native observer registry. */ }
      if (alive) timer = setTimeout(() => void refresh(), 1000);
    };
    void refresh();
    return () => { alive = false; clearTimeout(timer); scope.dispose(); };
  }, [runId]);

  if (!observers.length) return null;
  return <div aria-label="Background observers" style={{ margin: "12px 0", color: "var(--fg-subtle)", fontSize: 12 }}>
    {observers.map((observer) => {
      const index = observer.githubWatch ? observerMessageIndex(msgs, observer.id) : null;
      const target = index === null ? null : messageRoot?.querySelector<HTMLElement>(`[data-observer-slot="${index}"]`);
      const row = <ObserverRow key={observer.id} observer={observer} runId={runId} sidebar={sidebar} onStopped={() => void listObservers(runId).then(setObservers)} />;
      return target ? createPortal(row, target, observer.id) : row;
    })}
  </div>;
}

function ObserverRow({ observer, runId, onStopped, sidebar }: { observer: Observer; runId: string; onStopped: () => void; sidebar?: ObserverSidebar }) {
  const [hovered, setHovered] = useState(false);
  const elapsed = useElapsed(observer.startedMs);
  const running = observer.status.state === "running";
  if (observer.githubWatch) return <GithubObserverCard observer={observer} runId={runId} sidebar={sidebar} onStop={() => {
    void stopObserver(runId, observer.id).then(onStopped).catch(error => notify(String(error), { tone: "error" }));
  }} />;
  return <div
    onMouseEnter={() => setHovered(true)}
    onMouseLeave={() => setHovered(false)}
    style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", minWidth: 0 }}
  >
    {running && <DotGridLoader size={10} label="Watching in background" />}
    <span>{observerLabel(observer)}</span>
    {running && <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)", fontVariantNumeric: "tabular-nums" }}>{elapsed}</span>}
    <code style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--fg-dim)" }} title={observer.command}>{observer.command}</code>
    {running && <button
      type="button"
      aria-label="Stop background observer"
      onClick={() => {
        void stopObserver(runId, observer.id).then(onStopped)
          .catch((error) => notify(`Couldn't stop observer: ${String(error)}`, { tone: "error" }));
      }}
      style={{ border: 0, background: "none", color: "var(--fg-subtle)", cursor: "pointer", fontSize: 12, opacity: hovered ? 1 : 0, pointerEvents: hovered ? "auto" : "none", transition: "opacity 120ms ease" }}
    >Stop</button>}
  </div>;
}
